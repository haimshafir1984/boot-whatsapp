# תוכנית: כשל בלקוחת Meta אחת לא יעצור ניתוב ללקוחות אחרות על אותו מספר

**מסמך זה מיועד לבדיקה בלבד.** אין בו אישור למימוש. המטרה: לקבל מסקנות/הכרעות מחייבות לפני שמתחילים סבב פיתוח בפועל — בדיוק כמו סבבי הביקורת הקודמים עם קודקס בפרויקט הזה.

## הרקע

נבדק מסמך אפיון חיצוני ("central routing run 1") שהציע שכתוב ארכיטקטורה מלא (DB ייעודי חדש, 5 טבלאות, פרוטוקול גרסה חדשה, מצבי `legacy/shadow/central`) כדי לפתור, בין היתר, בעיית מהירות נתפסת. בדיקה ישירה בייצור (לוגים אמיתיים, פעמיים החודש) הראתה ש-`route_ms` בפועל הוא תמיד 20-250 מ"ש גם עם `clients_checked=10` — הניתוב עצמו **מעולם לא** נמצא כצוואר בקבוק אמיתי מול תלונות איטיות. לעומת זאת, קריאת קוד ישירה חשפה בעיית אמינות אמיתית ומאומתת, נפרדת לגמרי מ"איטיות": **כשל בבדיקת pending-conversation של לקוחה אחת יכול לעצור ניתוב לכל הלקוחות האחרות החולקות אותו מספר Meta** — כולל הודעות עם טריגר טרי וחד-משמעי ללקוחה בריאה לגמרי.

המסמך הזה מאפיין תיקון ממוקד לבעיה הזו בלבד. הוא **אינו** מציע שכתוב ארכיטקטורה.

## הבעיה, עם ראיות מדויקות מהקוד

הפונקציה [`routeMetaGatewayInbound`](../src/adminServer.ts#L1722) עושה, לכל הודעה נכנסת, לולאת גילוי על כל הלקוחות שחולקות את אותו מספר Meta ([adminServer.ts:1770-1812](../src/adminServer.ts#L1770)):

```ts
await Promise.all(clients.map(async (client) => {
  try {
    const campaigns = await getCachedRoutes(client);          // (1) כמעט תמיד ממוטמן, נדיר שנכשל
    if (campaigns === 'unavailable') throw new Error(...);
    // ... fetchPendingRoute(client) עם retry אחד            // (2) קריאת רשת חיה, בלי מטמון, לכל הודעה
    ...
    campaignsByClient.set(client.id, campaigns);
    for (const campaign of campaigns) { /* בונה candidates */ }
  } catch (err) {
    lookupFailures += 1;   // (1) ו-(2) נופלים לאותו מונה אחד
  }
}));

if (lookupFailures > 0) {
  throw new Error(`Campaign routing incomplete for ${lookupFailures} client(s); refusing unsafe fallback`);
}
```

שתי בעיות פנימיות שנעולות יחד בבלוק try/catch אחד:

1. **שני כשלים שונים לגמרי נספרים באותו מונה.** #1 (`getCachedRoutes`) הוא כמעט תמיד רענון-רקע ממוטמן (`ROUTES_REFRESH_INTERVAL_MS = 2_000`, [adminServer.ts:1677](../src/adminServer.ts#L1677)) ונדיר שנכשל בפועל. #2 (`fetchPendingRoute`) הוא קריאת HTTP חיה, פר-הודעה, פר-לקוחה, בלי מטמון — הרבה יותר שברירי (timeout 3 שניות, אם הלקוחה עמוסה/מופעלת-מחדש/נופלת).
2. **ה-throw ב-1817-1819 הוא בלתי מותנה**: הוא קורה **לפני** שבודקים בכלל אם כבר נמצאה התאמת טריגר חד-משמעית ללקוחה אחרת. גם אם `best` (ראו [metaCampaignRouting.ts:30](../src/metaCampaignRouting.ts#L30)) כבר קובע בבירור שההודעה שייכת ללקוחה בריאה — ה-throw כבר קרה, וההודעה כולה חוזרת ל-Inbox עם backoff (`metaInboxRetryDelayMs`, עד ~38 שניות, 10 ניסיונות, ואז `markFailed` + התרעת critical, [adminServer.ts:1973-2021](../src/adminServer.ts#L1973)).

### פונקציה קיימת שכבר בנויה נכון — אבל כמעט קוד מת

[`decideMetaFallbackRoute`](../src/metaGatewayReliability.ts#L17) כבר מפרידה נכון בין `routeLookupFailures` ל-`pendingLookupFailures`, ונכשלת סגור (`retry`) **רק** כשבאמת אי אפשר לדעת מי הבעלים (אין טריגר טרי, וגם לא כל בדיקות ה-pending הצליחו):

```ts
export function decideMetaFallbackRoute(input: {
  routeLookupFailures: number;
  pendingLookupFailures: number;
  pendingClientIds: string[];
}): MetaFallbackRouteDecision {
  if (input.routeLookupFailures > 0 || input.pendingLookupFailures > 0) {
    return { action: 'retry' };
  }
  ...
}
```

היא נקראת ב-[adminServer.ts:1904-1910](../src/adminServer.ts#L1904) — אבל רק בענף `if (!targetClient && !best)`, שאליו **אי אפשר להגיע** כשיש כשל כלשהו, כי ה-throw הגורף בשורה 1817 כבר קרה קודם. כלומר יש כבר מנגנון fail-closed נכון ומדויק בקוד — פשוט לא מגיעים אליו.

## למה ambiguity detection נשאר תקין אחרי ההפרדה

[`selectMetaRouteCandidate`](../src/metaCampaignRouting.ts#L30) פועל אך ורק על מערך `candidates` שמקבל — **אין לו שום תלות ב-pending lookup**:

```ts
export function selectMetaRouteCandidate<TClient>(candidates: MetaRouteCandidate<TClient>[]) {
  candidates.sort((a, b) => b.triggerText.length - a.triggerText.length);
  const best = candidates[0];
  ...
  const topClientIds = new Set(candidates.filter(c => c.triggerText.length === best.triggerText.length).map(c => c.clientId));
  return { best, ambiguous: topClientIds.size > 1 };
}
```

כלומר: אם ממשיכים לבנות את `candidates` מכל לקוחה שה-**route list** שלה הצליח (בלי תלות בהצלחת ה-pending check שלה), בדיקת האי-חד-משמעיות נשארת מדויקת ב-100% — אין תרחיש שבו לקוחה "נעלמת" מרשימת המתמודדים בגלל כשל שאין לו שום קשר לרשימת הטריגרים שלה.

## התיקון המוצע

1. לפצל את בלוק ה-try/catch המשולב ל-2 שלבים נפרדים עם 2 מונים: `routeLookupFailures` (כשל ב-`getCachedRoutes`) ו-`pendingLookupFailures` (כשל ב-`fetchPendingRoute`). `campaignsByClient`/`candidates` מתמלאים מכל לקוחה שה-route list שלה הצליח, **גם אם** ה-pending check שלה נכשל.
2. `routeLookupFailures > 0` ממשיך לגרום ל-throw גורף מיידי, **בדיוק כמו היום** — בלי route list מלא אי אפשר לקבוע ambiguity בבטחה. זה לא משתנה.
3. אם נמצאה התאמת טריגר טרי חד-משמעית (`best`, לא `ambiguous`) — לנתב מיד, **גם אם** `pendingLookupFailures > 0` עבור לקוחות אחרות. הודעה עם בעלים ידוע אינה צריכה לחכות לתשובת pending מלקוחה לא-קשורה.
4. אם **אין** התאמת טריגר טרי (מסתמכים על pending בלבד) — הענף הקיים ב-[adminServer.ts:1874-1921](../src/adminServer.ts#L1874) ממשיך להשתמש ב-`decideMetaFallbackRoute` בדיוק כפי שהוא היום, כולל ה-fail-closed הקיים על `pendingLookupFailures > 0`. **לא משתנה.**
5. "פינוי pending ישן" ([adminServer.ts:1838-1869](../src/adminServer.ts#L1838)) כבר בנוי נכון להתמודד עם לקוחה חסרת-תשובה (`pendingByClient.get(client.id)` יהיה `undefined`, לא נכלל בניקוי, לא קורס) — לא דורש שינוי.

## ניתוח סיכון שיורי (שנבדק ולא נשלל)

אם ללקוחה שנכשלה ב-pending check יש בפועל שיחה פתוחה עם אותו שולח, היא **לא** תנוקה מיידית (בניגוד להיום, שבו כל ההודעה נכשלת ואף אחד לא מנוקה בכל מקרה). זה לא regression: יש מנגנון timeout קיים (`Decision reply timeout`, נצפה בלוגים בפועל) שמנקה שיחות תקועות בעצמן. ואם השולח יחזור עם הודעת המשך רגילה (בלי טריגר טרי) לפני שהניקוי קרה — `decideMetaFallbackRoute` יראה `pendingClientIds.length > 1` (הלקוחה הישנה שלא נוקתה + כל אפשרי אחר) ויחזיר `ambiguous`, כלומר **חוסם בבטחה**, לא מערבב. זו בדיוק ההתנהגות הבטוחה הקיימת — רק שהעיכוב מוגבל ללקוחה הספציפית שהייתה תקועה, לא לכל ההודעה.

## כיסוי בדיקות קיים — נבדק, לא מספיק

`scripts/test-meta-routes-cache.js` בודק רק את מסלול ה-route-list (`getCachedRoutes` מחזיר `'unavailable'` → `routeLookupFailures`) — לא נוגע כלל בהפרדה בין route-list-failure ל-pending-failure, ולא בודק את ה-throw הגורף בפועל מול `routeMetaGatewayInbound` עצמה (זו closure פנימית ב-`startAdminServer`, לא exported directly היום).

**נדרשות בדיקות ייעודיות חדשות** (לפי המתודולוגיה הקבועה בפרויקט — כל שינוי בקובץ הזה גרר עד כה באג אמיתי שנתפס רק בבדיקה ישירה, לא בסקירת קוד):

1. טריגר טרי חד-משמעי ללקוחה A; לקוחה B (לא קשורה) נכשלת ב-pending check → ההודעה מנותבת ל-A מיד, בלי להמתין ל-retry.
2. `getCachedRoutes` נכשל (לא pending) ללקוחה כלשהי → ההודעה עדיין נכשלת סגור בדיוק כמו היום (regression guard על ההתנהגות הקיימת).
3. אין טריגר טרי, מסתמכים על pending; לקוחה כלשהי נכשלת ב-pending check → עדיין `retry` (fail-closed), ללא שינוי — regression guard על הענף הקיים.
4. שתי לקוחות עם טריגר זהה/חופף באורכו, ולקוחה שלישית לא-קשורה נכשלת ב-pending check → עדיין מזוהה `ambiguous` נכון (מוודא שההפרדה לא פוגעת בזיהוי אי-חד-משמעיות).
5. מקרה "פינוי pending ישן" עם לקוחה שנכשלה ב-pending check: לא קורס, לא מנקה את הלקוחה הכושלת, ממשיך לנתב את ההודעה הטרייה ליעד הנכון.
6. תרחיש ה"סיכון השיורי": שולח עם pending אמיתי על לקוחה B (לא זמינה), שולח הודעת המשך רגילה (בלי טריגר) לפני שה-pending של B נוקה → מתקבל `ambiguous`/retry ולא ניתוב שגוי.

## היקף המימוש המוערך

שינוי ממוקד בפונקציה אחת (`routeMetaGatewayInbound`) + הבדיקות החדשות שלמעלה. מוערך כ-30-60 שורות שינוי קוד, לא כולל בדיקות. אין שינוי סכימה, אין migration, אין תלות ב-DB חדש, אין שינוי לפרוטוקול הפנימי.

## שאלות פתוחות ל-Opus 5

1. האם ההפרדה בין `routeLookupFailures` ל-`pendingLookupFailures` כפי שמתואר כאן נכונה ומספיקה, או שיש תרחיש נוסף שדורש מונה/ענף שלישי?
2. האם יש הצדקה לנסות גם לנקות (`meta-clear-pending`) את הלקוחה שנכשלה ב-pending check באופן אסינכרוני/מושהה (לא חוסם את הניתוב), במקום להשאיר את זה למנגנון ה-timeout הקיים בלבד?
3. האם רשימת הבדיקות המוצעת (1-6 למעלה) מכסה את כל התרחישים המהותיים, או שחסר תרחיש?
4. האם יש להוסיף גם מדד/לוג ייעודי (למשל `pending_lookup_skipped_clients=N`) כדי שאפשר יהיה לזהות בייצור באיזו תדירות זה קורה, לפני שמניחים שהבעיה נעלמה?

**המסמך הזה מיועד רק לבדיקה ומתן מסקנות. לא לבצע מימוש עד קבלת הכרעה מפורשת.**
