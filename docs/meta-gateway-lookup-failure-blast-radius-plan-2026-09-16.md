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

---

## עדכון — Opus 5 דחה את התיקון המוצע כפי שהוא כתוב, ואימתתי כל טענה שלו בקוד ישירות

**מסקנת Opus 5, בשורה אחת: האבחנה בבעיה נכונה, אבל סעיפים 4-5 של "התיקון המוצע" למעלה פותחים פרצת בטיחות אמיתית שהמסמך סימן בטעות כ"לא דורש שינוי". אין לממש את המסמך כפי שהוא כתוב.**

בדקתי כל אחת משלוש הטענות המרכזיות של Opus ישירות בקוד (לא קיבלתי אותן כמות שהן) — כולן אומתו נכונות:

### באג 1 (חמור) — "פינוי pending ישן" (סעיף 5 למעלה) לא ינקה לקוחה שנכשלה

בדקתי את [adminServer.ts:1838-1847](../src/adminServer.ts#L1838):
```ts
const staleClients = clients.filter(
  (client) => client.id !== targetClient!.id
    && Boolean(pendingByClient.get(client.id)?.pending || pendingByClient.get(client.id)?.activeWork),
);
```
לקוחה שה-pending check שלה נכשל **אף פעם לא הגיעה** ל-`pendingByClient.set(...)` — `pendingByClient.get(client.id)` יהיה `undefined`, ו-`undefined?.pending` הוא `undefined` (falsy). כלומר "לא ידוע" נספר בטעות כ"אין לה כלום", והיא **לא** מקבלת את קריאת ה-`meta-clear-pending`.

בדקתי גם מה הקריאה הזו בפועל עושה ([adminServer.ts:3177-3199](../src/adminServer.ts#L3177)) — זה לא רק "ניקוי דגל":
```ts
let removed = conversationState.removeByPhone(phone);
await stopCampaignWork(phone, async () => {
  removed += conversationState.removeByPhone(phone);
  storage.cancelOutboxForRecipient(phone);
  metaClientInbox.cancelPendingForPhone(phone);
  storage.cancelServiceBotFollowUps(phone);
  storage.clearServiceBotSessionForPhone(phone);
  ...
});
```
זה עוצר עבודה פעילה, מבטל הודעות בתור, מבטל follow-ups. בלי הקריאה הזו, הלקוחה שנכשלה **ממשיכה לשלוח הודעות קמפיין** לאותו אדם, במקביל לקמפיין החדש שהתחיל אצל לקוחה אחרת. זה בדיוק המצב שהקוד הקיים נבנה למנוע (מעדיף retry על פני שליחה לא בטוחה) — התיקון כפי שכתוב הופך את זה לברירת מחדל.

### באג 2 — "ניתוח הסיכון השיורי" שלי (הפסקה מעל) הסתמך על מנגנון שלא מכסה את זה

בדקתי את `Decision reply timeout` ([messageFlow.ts:2913-2930](../src/messageFlow.ts#L2913)) — הוא עושה רק `conversationState.remove(senderJid)`. **אין בו** קריאה ל-`stopCampaignWork`, לא מבטל הודעות בתור, לא מבטל service-bot follow-ups. כלומר הטענה שלי שהמנגנון הזה "מנקה שיחות תקועות בעצמו" שגויה — הוא מנקה רק את מצב ההמתנה לתשובה, לא את העבודה הפעילה. המסקנה של Opus נכונה: זו כן נסיגה, לא רק עיכוב מבוקר.

### באג 3 (המלכודת הכי חמורה, פספסתי לגמרי) — סעיף 4 ("לא משתנה") כן משתנה, ובצורה מסוכנת

בדקתי את הענף `if (!targetClient && !best)` ב-[adminServer.ts:1874-1921](../src/adminServer.ts#L1874). המונה `pendingLookupFailures` **המקומי לענף הזה** (שורה 1875, מתעדכן בשורה 1898) יושב בתוך try/catch שקורא רק `pendingByClient.get(client.id)` — **קריאה ל-Map לעולם לא זורקת חריגה**. ההערה בקוד עצמו (שורות 1878-1881) מודה בכך: "a client that failed that lookup already bumped lookupFailures and made us throw before reaching here" — כלומר המונה הזה **תלוי לגמרי** בכך שה-throw הגורף בשורה 1817 כבר סינן קודם לכן את הלקוחות הכושלות. ברגע שמסירים את ה-throw הגורף (כמו שסעיף 2-3 למעלה מציעים), המונה הזה נשאר **תמיד אפס**, גם כש-lookup באמת נכשל — כי הוא פשוט לא יכול לזהות את זה בעצמו. התוצאה: אם ללקוחה אחרת יש pending אמיתי, `decideMetaFallbackRoute` תחזיר `route` במקום `retry`, וההודעה תנותב ללקוחה הלא-נכונה בזמן שהבעלים האמיתיים (שנכשל הבדיקה שלו) מעולם לא נשאל. זה ניתוב שגוי בין לקוחות — בדיוק סוג הבאג שהמערכת הזו בנויה כל הזמן למנוע.

### מסקנה

שלושת הבאגים מאומתים במדויק בקוד. **אני מקבל את דחיית Opus 5 במלואה** — "התיקון המוצע" בסעיף "התיקון המוצע" למעלה **נדחה, לא ימומש כפי שהוא כתוב**.

### הדרך הנכונה קדימה (לפי המלצת Opus 5, מאומתת)

1. **קודם — רק לוג אבחוני, בלי שינוי התנהגות.** לרשום בנפרד כשל ב-route-list מול כשל ב-pending check, ובמיוחד לרשום כמה פעמים כשל pending קורה **בזמן שכבר יש התאמת טריגר טרי חד-משמעית** ללקוחה אחרת (בדיוק התרחיש שהתיקון אמור לפתור). למדוד בייצור לפני שנוגעים בהתנהגות.
2. **רק אם זה קורה מספיק כדי להצדיק שינוי בקובץ הרגיש הזה** — לכתוב מחדש את סעיפים 4-5 כך ש: (א) לקוחה שנכשלה ב-pending check מקבלת קריאת עצירה עיוורת (`meta-clear-pending`) *לפני* שמנתבים ללקוחה אחרת — לא רק ללקוחות שדיווחו pending; (ב) אם היא לא מאשרת (`cancelled: true`) — retry כמו היום, לא ניתוב; (ג) הכשלים מהלולאה הראשונה חייבים לעבור בפירוש ל-`decideMetaFallbackRoute` (לא להסתמך על המונה המקומי השבור בסעיף 4).
3. **רק אז לבקש מקודקס סבב ביקורת נוסף** על הגרסה המתוקנת.

**המצב הנוכחי: אין אישור למימוש שום שינוי התנהגות בניתוב. השלב הבא, אם וכאשר יאושר, הוא לוג אבחוני בלבד — לא שינוי בהתנהגות ה-fail-closed הקיימת.**

---

## שחזור מבוקר בייצור (16.9.2026) — נתונים אמיתיים, לא תיאורטיים

בוצע שחזור מבוקר בסביבת הייצור בפועל, לפני הקמפיין הגדול הצפוי בקרוב, כדי לכמת את הבעיה עם מספרים אמיתיים ולא רק ניתוח קוד.

**הגדרה**: שתי לקוחות עם פעילות נמוכה בשעות הבדיקה, ושתפקידן שונה — לקוחה A (יעד, בריאה): אביגיל בן דוד (`c8c9c18e`), קמפיין "קמפיין אביגיל בן דוד" עם טריגר "גם אני רוצה להצטרף לקהילה של אביגיל בן דוד". לקוחה B (מדומה כתקועה): רחל אלעזרא (`7330b047`).

**הערה תפעולית**: `docker stop` על קונטיינר בודד לא הספיק — זהו שירות Docker Swarm, וה-orchestrator מפעיל קונטיינר חדש תוך שניות ספורות (`replicas: 1/1` נאכף). נדרש `docker service scale <service>=0` כדי שהלקוחה תישאר לא-זמינה בפועל, ו-`=1` כדי להחזיר אותה.

### תוצאה 1: הבאג משוחזר במדויק, ומהיר בהרבה משהערכנו

עם רחל אלעזרא כבויה (`scale=0`), הודעת הטריגר ל-אביגיל בן דוד (client בריא לחלוטין) נכנסה ללולאת retry מיידית:

```
13:25:42.671  META_GATEWAY_INBOUND
13:25:42.757  attempt=1  "Campaign routing incomplete for 1 client(s); refusing unsafe fallback"
13:25:43.565  attempt=2
13:25:45.089  attempt=3
13:25:47.557  attempt=4
13:25:52.120  attempt=5
13:25:57.598  attempt=6
13:26:03.247  attempt=7
13:26:08.716  attempt=8
13:26:14.241  attempt=9
13:26:19.629  META_GATEWAY_INBOX_FAILED  ← כישלון סופי + התרעת critical
```

**37 שניות בדיוק** מההודעה הראשונה לכישלון הסופי — תואם במדויק את עקומת ה-backoff המתועדת בהערת הקוד ([adminServer.ts:1970-1972](../src/adminServer.ts#L1970): "All 10 attempts now fit inside ~38s").

### תוצאה 2: זו לא "עיכוב" — זו אובדן הודעה מוחלט

ניסיתי לתקן תוך כדי (הרצתי `docker service scale =1` ברגע שראיתי `attempt=9` בלוג), אבל **Swarm לוקח יותר מ-37 שניות** להחזיר קונטיינר למצב `healthy` בפועל (health check + start-period) — משמעותית יותר זמן מכל חלון ה-retry. התוצאה: **ההודעה נכשלה סופית ולעולם לא הגיעה לקמפיין של אביגיל בן דוד**, למרות שהלקוחה שלה בריאה לחלוטין לאורך כל הזמן. נדרשה שליחה חוזרת ידנית מהמשתמש.

זה משמעותי יותר ממה שההערכה המקורית במסמך הניחה ("עיכוב של עד 38 שניות ואז retry מצליח"). בפועל: **בכל תרחיש שבו לקוחה חולקת-מספר נופלת ליותר מ-~37 שניות (זמן החזרה טיפוסי של שירות ב-Swarm, לא רק תרחיש קיצון), כל ההודעות לכל שאר הלקוחות על אותו מספר נכשלות סופית ולא רק מתעכבות** — כולל התרעת `critical` אמיתית לכל הודעה כזו.

### תוצאה 3: אחרי שהלקוחה חזרה לחיים, ניתוב תקין חזר מיידית

הודעה חוזרת (אחרי שרחל אלעזרא אושרה `healthy`) נותבה תוך 96 מ"ש:

```
13:27:56.572  META_GATEWAY_INBOUND (wamid חדש)
13:27:56.677  META_GATEWAY_ROUTED  c8c9c18e  campaign=mtftc97du00y  route_ms=96
```

מאשר: הבעיה היא אך ורק בחלון שבו לקוחה כלשהי לא זמינה — ברגע שהיא חוזרת, הניתוב מהיר ותקין כרגיל.

### מסקנה מעודכנת

הנתונים האמיתיים **מחזקים**, לא מחלישים, את הצורך בתיקון — אבל גם מחזקים את דחיית Opus 5 לתיקון כפי שנכתב במקור: אם התיקון המתוקן (עם קריאת עצירה עיוורת ללקוחה הכושלת) לא יסתיים תוך פחות מ-~37 שניות, עדיין יהיה כישלון סופי. כל תיקון עתידי חייב לקחת בחשבון שזמן ה-timeout על קריאת ה-`meta-clear-pending` העיוורת (הצעה 2 בתשובות ל-Opus, timeout 3 שניות + retry) הוא הרבה יותר קצר מ-37 שניות — ולכן סביר שכן ישפר משמעותית את המצב, לא רק תיאורטית.

**המלצה מעודכנת**: הנתונים האלה מספיקים כבר עכשיו כדי להצדיק כתיבה מחדש של סעיפים 4-5 לפי תיקוני Opus, בלי להמתין לצבירת לוג פסיבי נוסף — התרחיש כבר אומת ככזה שקורה במהירות ובוודאות, לא רק תיאורטי.
