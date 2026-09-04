# תוכנית טכנית — עמידות מספר Meta משותף (A5-1) + תור שולחים לא-נחסם ב-file-delivery

מסמך לסקירת קודקס. שני חלקים בלתי-תלויים, שניהם משפיעים ישירות על קמפיין גדול על מספר Meta ראשי משותף.

## סטטוס — סבב 3

- **A5-1 (routes cache): מאושר עקרונית, בכפוף לשני תיקוני עיצוב.** מפורט למטה — stale-while-revalidate עם רענון ברקע, ו-invalidation מודע-generation.
- **File-delivery pause/resume: עדיין לא מאושר למימוש.** קודקס זיהה שגם ההנחה היסודית הקודמת (control מגיע מה-gateway) הייתה שגויה — ה-control שייך אך ורק ל-`metaClientDrainer` בצד הלקוחה, לא לגייטווי. גם עיצוב ה-state machine וגם עיצוב ה-fairness דורשים עוד עבודה. **לא לממש בסבב הזה** — ראה "סדר עבודה" בסוף.

## עדכון — הערות קודקס (סבב 2) שולבו

### A5-1

1. **cache עצל בלבד לא מספיק** — כשה-TTL פג, ההודעה הראשונה אחרי התפוגה עדיין ממתינה ל-HTTP חי. תחת תעבורה רציפה על מספר משותף, זה קורה כל ~5 שניות. **תיקון: רענון ברקע (`setInterval`, קצב תת-TTL) שמשמר ערך טרי כמעט תמיד — הנתיב החם כמעט אף פעם לא ממתין לרשת בפועל.** ה-fail-closed הקיים (lookupFailure כשאין ערך טרי) נשאר בדיוק כמו היום למקרה שהרענון עצמו נכשל/מתעכב.
2. **`invalidate()` נאיבי (`delete()`) הוא race אמיתי** — fetch איטי שהתחיל *לפני* invalidate יכול "להחיות" ערך מבוטל אחרי שהוא כבר הוחלף. **תיקון: generation counter פר-key.** `invalidate()` מקדם את ה-generation; `load()` שמסתיים בודק אם ה-generation עדיין זהה למה שהיה כשהוא התחיל — אם לא, לא כותב ל-cache.

### File-delivery

1. **הנחת יסוד שגויה תוקנה: control שייך רק ל-`metaClientDrainer`.** בדקתי את הנתיב המלא: `metaGatewayDrainer` (רץ בגייטווי) מנתב ומעביר HTTP forward ל-`/internal/meta/whatsapp` על הלקוחה היעד ומחזיר `{handled:true}` — **הוא לא מריץ זרימת הודעה ולא קורא ל-`sendFileWithRetry` בכלל.** העיבוד בפועל (כולל שליחת קבצים) קורה בתוך `metaClientDrainer`, שרץ **בתהליך של הלקוחה עצמה**. אין טעם ואין אפשרות אמיתית להעביר `control` מהגייטווי — זה שני תהליכים נפרדים.
2. **חתימת `runGroup`/פרמטר מפורש בוטלה לטובת `AsyncLocalStorage` מצומצם** — בגלל עומק הקריאה האמיתי בין `metaClientDrainer.runGroup` ל-`sendFileWithRetry` (הרבה helpers פנימיים ב-`messageFlow.ts`), פרמטר מפורש ידרוש לגעת בהרבה יותר משני call sites. במקום זה: scope ייעודי וצר בסגנון `outboxStorageScope` הקיים, מופעל **רק** בתוך `metaClientDrainer.runGroup` (אף פעם לא בגייטווי).
3. **State machine חסר מצב `resuming`** — שני `resume()` מקבילים על אותו group יכולים שניהם להיכנס ל-`acquireSlot()` בזמן שהמצב עדיין `paused`, ואחד מהם דולף סלוט. גם: אם `runGroup` מסתיים בזמן שהוא ממתין ל-`resume()`, הסלוט שמתקבל דולף.
4. **`claim(1)` בלולאה — חשש מאושש** — `claimBatch` עושה `slice()`+`sort()`+סריקה על **כל** הפריטים בכל קריאה (`metaGatewayInbox.ts:61`). `claim(1)` חוזר על זה N פעמים במקום פעם אחת ל-batch. **צריך לחזור ל-`claim(batchSize)` (10-20), לא `claim(1)`.**
5. **`drain()` ארוך-חי לא מסוכן מעצמו, אבל צריך חוזה ברור** ל-shutdown באמצע, ולוודא ש-enqueue חדש בזמן ש-`drain()` כבר רץ נכנס לעיבוד בפועל ולא נשאר תלוי ל-timer הבא.

## רקע — למה שני אלה קשורים לקמפיין על מספר משותף

כשקמפיין גדול רץ על המספר הראשי המשותף (`sharedAdminNumber`, `adminServer.ts:1630-1638`), **כל** לקוחות ה-Meta במערכת נכנסים לאותו נתיב ניתוב לכל הודעה שמגיעה על המספר הזה — לא רק הלקוח שהקמפיין שלו רץ. שני המנגנונים למטה הם שני אופנים שבהם עומס אצל לקוחה אחת "דולף" ופוגע בכל השאר על אותו מספר, גם אם הן שקטות לגמרי.

## חלק A5-1 — cache עם stale-while-revalidate + invalidation מודע-generation

### `AsyncExpiringCache` — הרחבה עם generation

```ts
interface CacheEntry<T> {
  value?: T;
  expiresAt?: number;
  pending?: Promise<T>;
  generation: number;
}

export class AsyncExpiringCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing?.value !== undefined && (existing.expiresAt ?? 0) > this.now()) {
      return existing.value;
    }
    if (existing?.pending) return existing.pending;

    const generation = existing?.generation ?? 0;
    const pending = load().then(
      (value) => {
        const current = this.entries.get(key);
        // invalidate() bumped the generation while this fetch was in flight -
        // this result is already stale by the time it lands. Return it to the
        // caller (they still get an answer) but do not resurrect it in cache.
        if (current && current.generation !== generation) return value;
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs, generation });
        return value;
      },
      (error) => {
        const current = this.entries.get(key);
        if (current && current.generation === generation) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, { pending, generation });
    return pending;
  }

  /** Bumps the key's generation and clears its value/pending pointer. Any
   * fetch already in flight for the OLD generation will not be allowed to
   * write its result back once it lands - see get(). */
  invalidate(key: string): void {
    const existing = this.entries.get(key);
    this.entries.set(key, { generation: (existing?.generation ?? 0) + 1 });
  }
}
```

זו הרחבה ל-**מחלקה הכללית** (לא cache ייעודי נפרד) — לפי המלצת קודקס: זה נשאר כלי כללי, נבדק היטב פעם אחת, ולא רק פתרון-נקודתי ל-routes.

### רענון ברקע — stale-while-revalidate בפועל

```ts
const routesCache = new AsyncExpiringCache<MetaGatewayRoute[]>(META_CAMPAIGN_CACHE_TTL_MS); // 5_000, קבוע קיים
const ROUTES_REFRESH_INTERVAL_MS = 2_000; // תת-TTL בבירור, כך שערך כמעט תמיד טרי כשהודעה מגיעה

async function fetchRoutesForClient(client: ManagedClient): Promise<MetaGatewayRoute[]> {
  const result = await fetchClientAsOwner<MetaGatewayRoute[]>(client, '/owner-api/meta-routes', {
    signal: AbortSignal.timeout(3_000),
  });
  if (!result.ok || !Array.isArray(result.body)) throw new Error('meta-routes fetch failed with status ' + result.status);
  return result.body;
}

async function getCachedRoutes(client: ManagedClient): Promise<MetaGatewayRoute[] | 'unavailable'> {
  try {
    return await routesCache.get(client.id, () => fetchRoutesForClient(client));
  } catch {
    return 'unavailable'; // בדיוק כמו lookupFailures>0 היום - fail-closed, לא לנתב
  }
}

// לרוץ ברקע, לא בתוך routeMetaGatewayInbound - שומר ערכים טריים לפני שהם
// בכלל פגים, כך שהנתיב החם כמעט אף פעם לא נתקל ב-cache שפג ולא ממתין לרשת.
function refreshAllRoutesCaches(): void {
  const clients = ownerStorage.getClients().filter((c) =>
    c.whatsappProvider === 'META_CLOUD_API' && c.managementUrl && c.ownerAccessToken && c.provisioningStatus !== 'disabled');
  for (const client of clients) {
    void getCachedRoutes(client); // תוצאה נזרקת בכוונה - זה רק "שמור טרי", לא בשביל הודעה ספציפית
  }
}
setInterval(refreshAllRoutesCaches, ROUTES_REFRESH_INTERVAL_MS);
```

`AsyncExpiringCache.get()` כבר נותן single-flight אמיתי: אם הרענון-ברקע כבר מריץ `load()` לאותו client.id, וגם הודעה נכנסת קוראת ל-`getCachedRoutes` באותו רגע, שתיהן משתפות את אותו promise — לא כפילות בקשות. **המרת `routeMetaGatewayInbound`:** הלולאה ב-1654-1708 מפסיקה לקרוא ל-`/owner-api/meta-routing-snapshot`, קוראת `getCachedRoutes(client)` במקום. `lookupFailures` נספר זהה בדיוק כשהתוצאה `'unavailable'`.

**Pending conversation נשאר בדיוק כמו היום** — קריאה חיה ל-`/owner-api/meta-pending-route` (קיים, `adminServer.ts:2961-2968`), רק כשאין התאמת trigger חד-משמעית. אין cache לזה — גדל עם מספר המשתתפים וחושף מידע מיותר לגייטווי, כפי שקודקס קבע.

### Invalidation מיידי + לוגים

- בכל מקום שמשנה סטטוס לקוח (השבתה, מחיקה, סיום `provisionClient`/`redeployExistingClient`) → `routesCache.invalidate(client.id)`.
- לוגים: `[META_ROUTES_CACHE_HIT]`/`[META_ROUTES_CACHE_MISS]` פר-לקוח, `[META_ROUTES_CACHE_REFRESH_FAILED]` עם שגיאה. `route_ms` **כבר קיים בלוג** (`adminServer.ts:1852`, `[META_GATEWAY_ROUTED] ... route_ms=...`) — משימת המדידה (סעיף הבדיקות) היא לקרוא לוגים קיימים מפרודקשן, לא להוסיף מדידה חדשה.

## חלק File-Delivery — לא מאושר למימוש בסבב הזה

### מה כן ברור ומאומת

- הבעיה עצמה אמיתית ומאומתת: `waitForOutboxFileDelivery` (`messageFlow.ts:3184-3197`) חוסם עד 20s בתוך `runGroup` של `metaClientDrainer`, תופס סלוט מתוך 50 בלי לעשות עבודה.
- **תיקנתי טעות קודמת:** ה-control שייך ל-`metaClientDrainer` בלבד (רץ בתהליך הלקוחה) — לא לגייטווי. `metaGatewayDrainer.runGroup` (`adminServer.ts:1878-1908`) לא צריך לדעת שום דבר על זה.
- **אימות שנשאר תקף:** "פריט אחד פעיל פר-שולח" נאכף ברמת האחסון (`metaGatewayInbox.ts`'s `status:'processing'` + `isClaimable`), לא ע"י `inflight` של הדריינר — שחרור סלוט בעת המתנה לא יכול לגרום לפריט הבא של אותו שולח לעקוף. זה עדיין נכון ועדיין דורש בדיקה ייעודית שמוכיחה את זה בפועל.

### מה עדיין פתוח, לא סגור להיום

1. **State machine עם `resuming`:**
   ```
   held → paused → resuming → held → finished
   ```
   `resume()` חייב להיות idempotent — קריאה שנייה בזמן ש-state כבר `resuming` מחזירה את אותו `resumePromise`, לא פותחת בקשת סלוט נוספת. וגם: אם `runGroup` "נגמר" (למשל timeout חיצוני אחר, או שגיאה לא-קשורה) בזמן שהוא בתוך `resuming` (ממתין ל-`acquireSlot`), הסלוט שמתקבל בסוף חייב להשתחרר מיד, לא לדלוף.

2. **מנגנון scope מצומצם (`AsyncLocalStorage`), לא פרמטר מפורש** — בסגנון `outboxStorageScope` הקיים, מופעל אך ורק בתוך `metaClientDrainer.runGroup`, עם בדיקת בידוד מפורשת (שני שולחים במקביל, רק אחד `paused` — ה-control לא "דולף" לשני).

3. **`claim(batchSize)` חוזר, לא `claim(1)`** — צריך עיצוב fairness שעובד עם claiming מבוסס-batch (בניגוד ל"תור FIFO אחד פר-פריט" מהסבב הקודם, שדרש `claim(1)` ויצר בעיית ביצועים). כיוון אפשרי (**לא סופי, טעון סקירה נוספת**): claim עדיין מוגבל לקיבולת פנויה בפועל (כמו במקור), ו-`resume()` מתחרה על קיבולת חדשה שמתפנה ב-**סבב הוגן** מול claims חדשים (למשל round-robin בין "תור resume" ל"claim הבא") — לא עדיפות קבועה לאף צד. זו בדיוק הנקודה שקודקס לא אישר כפסאודו-קוד סופי, ונדרש עיצוב+בדיקת עומס ייעודית (300/1,000/5,000 פריטים) לפני שממשיכים.

4. **חוזה `drain()`/shutdown ברור** — התנהגות תחת SIGTERM כששולח נמצא `paused`, וודאות שסלוט שמתפנה בזמן ש-`drain()` כבר רץ נתפס בפועל, לא נשאר תלוי לטיימר הבא.

**מסקנה: זה לא "תיקון קטן" (קודקס, סבב 1) — זה שינוי קונקורנטיות בליבה. לא לכלול בסבב המימוש הזה.**

## בדיקות — A5-1 בלבד (חלק זה מאושר למימוש)

`scripts/test-meta-routes-cache.js`:
1. **cache hit לא שולח HTTP** — client A עם cache טרי, קריאה שנייה מיד אחרי → אפס קריאות רשת נוספות.
2. **single-flight** — שתי קריאות "בו-זמנית" ל-`getCachedRoutes` לפני שהראשונה resolves, ל-client שה-cache שלו פג → קריאת HTTP אחת בלבד, שתיהן מקבלות אותה תוצאה.
3. **generation-aware invalidation (הבדיקה שקודקס דרש במפורש):**
   ```
   fetch איטי מתחיל → invalidate() → fetch איטי מסתיים → get() הבא חייב לבצע fetch חדש
   ```
   מוודא ש-`get()` אחרי ה-`invalidate()` **לא** מקבל את הערך מה-fetch הישן שכבר בוטל, גם אם הוא עוד "מרחף" ומסתיים אחרי.
4. **רענון ברקע שומר ערך טרי** — לדמות `refreshAllRoutesCaches()` רץ כל 2 שניות, לוודא שקריאה "פתאומית" ל-`getCachedRoutes` כמעט תמיד מקבלת cache hit (לא ממתינה לרשת), חוץ מהקריאה הראשונה-אי-פעם.
5. **unavailable = בדיוק כמו lookupFailures היום** — client שה-fetch שלו נכשל → `'unavailable'`, ו-`routeMetaGatewayInbound` מתנהג זהה למה שהוא עושה היום.
6. **regression מלא** — `test-meta-gateway-inbox.js`, `test-meta-gateway-reliability.js`, `test-meta-campaign-routing.js`, `test-meta-trigger-age-window.js`.
7. **מוטציה** — להסיר את בדיקת ה-generation מ-`load().then(...)`, מוודא שבדיקה 3 נכשלת (מוכיחה שהיא באמת תופסת את ה-race).

**משימת אימות (לא בדיקה אוטומטית):** לקרוא `route_ms` מלוגי פרודקשן אמיתיים (`[META_GATEWAY_ROUTED]`) מהיום/מלפני, לתעד את הבסיס לפני המימוש.

## סדר עבודה (מאושר ע"י קודקס)

1. **לממש ולפרוס רק את A5-1** (routes cache: generation-aware `AsyncExpiringCache`, רענון ברקע, invalidation, לוגים) — זה מה שמוכן לביצוע.
2. לבדוק תחת עומס gateway + כמה לקוחות, כולל לקוחה אחת שלא עונה, לפני שממשיכים.
3. **File-delivery pause/resume נשאר כתוכנית נפרדת, לעבודה עתידית** — לא חלק מסבב המימוש הזה. כשהזמן מגיע: לעצב סביב `metaClientDrainer` בלבד, `AsyncLocalStorage` מצומצם, `claim(batchSize)`, ומנגנון fairness שנבדק תחת עומס (300/1,000/5,000 פריטים) לפני שמוצג כפסאודו-קוד סופי.
