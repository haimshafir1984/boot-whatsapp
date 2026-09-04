# תוצאות מימוש — עמידות מספר Meta משותף, חלק A5-1 בלבד

מסמך תוצאה למימוש שאושר בתוכנית `docs/shared-number-resilience-plan-2026-09-03.md`.

- ענף: `shared-number-resilience-fix` (מעל `master`, שכבר כולל את `decision-recovery-scale-fix`).
- מומש **אך ורק** חלק "A5-1 — cache עם stale-while-revalidate + invalidation מודע-generation".
- **File-delivery pause/resume לא מומש בכוונה** — ראה סעיף ייעודי בסוף.

---

## 1. מה בוצע — פירוט לפי קובץ

### `src/metaGatewayReliability.ts` (+30 / −3)

הרחבה של **המחלקה הכללית** `AsyncExpiringCache<T>` (לא מחלקה חדשה, לא cache ייעודי ל-routes):

| שינוי | פירוט |
| --- | --- |
| `CacheEntry<T>.generation: number` | שדה חובה חדש; נספר פר-key. |
| `get()` — generation capture | ב-cache miss נלכד `generation = existing?.generation ?? 0` לפני קריאת `load()`. הרשומה הזמנית נכתבת כ-`{ pending, generation }`. |
| `get()` — הגנת generation ב-`load().then(success)` | כשה-fetch מסתיים: `const current = this.entries.get(key); if (current && current.generation !== generation) return value;` — הערך מוחזר למי שקרא (הוא עדיין מקבל תשובה), אבל **לא נכתב ל-cache** אם ה-generation התקדם בינתיים. |
| `get()` — הגנת generation ב-`load().then(error)` | מחיקת הרשומה על כשל רק אם `current.generation === generation` (לא דורסים invalidate שקרה בינתיים). |
| `invalidate(key)` | מקדם את ה-generation ומאפס את המצביע ל-value/pending: `this.entries.set(key, { generation: (existing?.generation ?? 0) + 1 })`. |
| `isFresh(key)` | accessor קטן (מצב freshness ללא side-effect) — משמש **רק** ל-log של HIT/MISS ב-`getCachedRoutes`. זו התוספת היחידה מעבר לקוד המדויק שבתוכנית, והיא הכרחית כי `get()` לא חושף אם הייתה פגיעה. בדיקת ה-generation ב-`load().then` נשארת בדיוק כפי שהתוכנית מפרטת (וזו הנקודה שבדיקת המוטציה תוקפת).

### `src/adminServer.ts` (+101 / −49)

**1. import** — נוספו `AsyncExpiringCache`, `META_CAMPAIGN_CACHE_TTL_MS` מ-`./metaGatewayReliability` (`META_CAMPAIGN_CACHE_TTL_MS=5_000` כבר היה מוגדר שם, לא היה בשימוש).

**2. cache + helpers + רענון ברקע** (נוסף מיד לפני `routeMetaGatewayInbound`, בתוך `startAdminServer` כי צריך `ownerStorage`/`fetchClientAsOwner`):

```ts
const ROUTES_REFRESH_INTERVAL_MS = 2_000;
const routesCache = new AsyncExpiringCache<MetaGatewayRoute[]>(META_CAMPAIGN_CACHE_TTL_MS);

const fetchRoutesForClient = async (client) => {
  const result = await fetchClientAsOwner<MetaGatewayRoute[]>(client, '/owner-api/meta-routes', {
    signal: AbortSignal.timeout(3_000),
  });
  if (!result.ok || !Array.isArray(result.body)) throw new Error('meta-routes fetch failed with status ' + result.status);
  return result.body;
};

const getCachedRoutes = async (client) => {
  const cacheHit = routesCache.isFresh(client.id);
  try {
    const routes = await routesCache.get(client.id, () => fetchRoutesForClient(client));
    console.log(cacheHit ? '[META_ROUTES_CACHE_HIT]' : '[META_ROUTES_CACHE_MISS]', client.id);
    return routes;
  } catch {
    return 'unavailable'; // fail-closed, זהה ל-lookupFailure היום
  }
};

const refreshAllRoutesCaches = () => {
  const clients = ownerStorage.getClients().filter((c) =>
    c.whatsappProvider === 'META_CLOUD_API' && c.managementUrl && c.ownerAccessToken && c.provisioningStatus !== 'disabled');
  for (const client of clients) {
    void routesCache.get(client.id, () => fetchRoutesForClient(client)).catch((err) => {
      console.warn('[META_ROUTES_CACHE_REFRESH_FAILED]', client.id, err);
    });
  }
};
setInterval(refreshAllRoutesCaches, ROUTES_REFRESH_INTERVAL_MS);
```

**3. `routeMetaGatewayInbound` — לולאת הגילוי (לשעבר 1654-1708):**

- **routes:** במקום `POST /owner-api/meta-routing-snapshot` עם ניסיון חוזר מיידי, נקרא `getCachedRoutes(client)`. תוצאה `'unavailable'` → `throw` → נתפס ב-`catch` הקיים → `lookupFailures += 1` **בדיוק כמו קליינט שלא ענה היום**. שרשרת ה-fallback הישנה (`snapshot` 404 → `/owner-api/meta-routes` ישיר → `/owner-api/campaigns` → `campaignsToMetaGatewayRoutes`) הוסרה מהלולאה הזו; `getCachedRoutes` תמיד קורא ל-`/owner-api/meta-routes`. (`campaignsToMetaGatewayRoutes` עדיין בשימוש במקומות אחרים; `MetaRoutingSnapshotResponse` והנתיב `/owner-api/meta-routing-snapshot` נשארו קיימים, לא נגעתי בהם.)
- **pending conversation — נשאר בדיוק כמו היום:** קריאה **חיה** ל-`POST /owner-api/meta-pending-route` פר-קליינט, **ללא cache**, כולל אותו ניסיון חוזר מיידי אחד (`[META_GATEWAY_ROUTING_RETRY]`) שהיה עוטף את קריאת ה-snapshot. `pendingByClient` מאוכלס בדיוק כמו קודם. `404` → הקליינט מקדים לנתיב, לא נספר ככשל; סטטוס אחר שאינו `ok` → `throw` → `lookupFailures += 1`.
- `Set<string> legacyRoutingClients` הוסר (כל הקליינטים עוברים באותו נתיב עכשיו).

**4. `routeMetaGatewayInbound` — בלוק ה-fallback (`!targetClient && !best`):** הסרת ענף ה-`legacyRoutingClients.has(...)` שביצע קריאה חיה נוספת ל-`/owner-api/meta-pending-route`. עכשיו `pendingByClient` כבר מאוכלס לכל הקליינטים מלולאת הגילוי, וקליינט שנכשל שם כבר גרם ל-`throw` לפני שמגיעים לכאן. `pendingLookupFailures` נשאר (עדיין מוזן ל-`decideMetaFallbackRoute`, ה-`catch` עדיין מקדם אותו). בלוק ה-staleClients (`clear-pending` לשיחות ממתינות ישנות אצל קליינטים אחרים כשיש טריגר טרי) עובד בדיוק כמו קודם — הוא צורך את אותו `pendingByClient`.

**5. Invalidation מיידי** — `routesCache.invalidate(<clientId>)` נוסף בכל מקום שמשנה סטטוס לקוח:

| מיקום | טריגר |
| --- | --- |
| `provisionClient` — נתיב הצלחה | אחרי `provisioningStatus: 'deploying'` |
| `provisionClient` — נתיב `catch` | אחרי `provisioningStatus: 'failed'` |
| `runBulkRedeploy` — לולאה | אחרי כל `dokployProvisioner.redeployExistingClient(client)` (כולל הענף `decision-recovery-scale-fix` שכבר ב-`master`) |
| `POST /owner/api/clients/:id/disable` | אחרי `provisioningStatus: 'disabled'` |
| `POST /owner/api/clients/:id/enable` | אחרי `provisioningStatus: 'ready'` |
| `POST /owner/api/clients/:id/check-ready` | אחרי `provisioningStatus: 'ready'` |
| `DELETE /owner/api/clients/:id` | אחרי `ownerStorage.deleteClient(client.id)` |

`dokployProvisioner.ts` נבדק — הוא אינו משנה `provisioningStatus` בעצמו (משתמש ב-callback `update` שמקבל `provision()`) ואין לו הפניה ל-`routesCache`. `redeployExistingClient` / `deleteClientResources` נקראים רק מ-`adminServer.ts` מהמקומות שכבר מכוסים למעלה. לכן אין נקודות invalidation ב-`dokployProvisioner.ts`.

**6. לוגים** — `[META_ROUTES_CACHE_HIT]` / `[META_ROUTES_CACHE_MISS]` פר-לקוח ב-`getCachedRoutes`; `[META_ROUTES_CACHE_REFRESH_FAILED]` עם השגיאה ב-`refreshAllRoutesCaches`. **לא נוספה מדידת `route_ms` חדשה** — היא כבר קיימת ב-`[META_GATEWAY_ROUTED] ... route_ms=...` (`adminServer.ts`, שורת ה-log של ניתוב מוצלח).

### `scripts/test-meta-routes-cache.js` (חדש, 324 שורות)

7 מקרי בדיקה (למטה). מכיל מחלקה `MutatedCacheWithoutGenerationCheck` — עותק של `get()` **בלי** בדיקת ה-generation ב-`then(success)` — כדי שהוכחת המוטציה תרוץ בכל CI, לא רק בעריכה ידנית של המקור. הוכחת המוטציה על המקור עצמו בוצעה גם היא ידנית (סעיף 3).

---

## 2. בדיקות — פלט ריצה אמיתי

### `scripts/test-meta-routes-cache.js`

```
$ node scripts/test-meta-routes-cache.js
Meta routes cache tests passed.
exit=0
```

| # | מקרה | מה נבדק |
| --- | --- | --- |
| 1 | **cache hit לא שולח HTTP** | קריאה ראשונה: `hit=false`, `httpCalls=1`. קריאה שנייה בתוך TTL: `hit=true`, `httpCalls` נשאר `1`. |
| 2 | **single-flight** | שתי קריאות `getCachedRoutes` בו-זמנית לקליינט קר, לפני שה-fetch הראשון resolve — `httpCalls===1`, שתיהן מקבלות אותה תוצאה. |
| 3 | **generation-aware invalidation** | `fetch איטי מתחיל (httpCalls=1) → invalidate() → fetch איטי מסתיים עם ['stale-v1']`. הקורא התלוי עדיין מקבל `['stale-v1']` (assertion: "the in-flight caller still gets an answer"). ה-`get()` הבא **חייב** fetch חדש → `assert.equal(httpCalls, 2, 'a fetch from before invalidate() must not repopulate the cache')`. אחרי שה-fetch החדש נוחת עם `['fresh-v2']`, קריאה נוספת היא `hit=true` ו-`httpCalls` נשאר `2` — כלומר הערך הישן **לא** החייה את ה-cache. |
| 4 | **רענון ברקע שומר ערך טרי** | 30 שניות מדומות, הודעה כל שנייה, `refreshAll` כל 2ש'. הקריאה הראשונה-אי-פעם `hit=false` (`httpCalls=1`). על פני 30 קריאות "פתאומיות": יחס hit `>= 0.8`, ו-`httpCalls <= 10` (עוקב אחרי ה-TTL, לא אחרי נפח ההודעות). ביקורת: אותה תעבורה **ללא** רענון ברקע נותנת יחס hit נמוך יותר (`bareHits/bareReads < hitRatio`). |
| 5 | **`'unavailable'` == `lookupFailures>0` היום** | קליינט שה-fetch שלו זורק → `getCachedRoutes` מחזיר `'unavailable'`. `lookupFailures = 1`. `decideMetaFallbackRoute({routeLookupFailures:1, ...})` עם התוצאה הזו **שווה בדיוק** (`assert.deepEqual`) לקריאה עם `routeLookupFailures:1` הקבוע — ושתיהן `{action:'retry'}`. קליינט שהתאושש נכנס ל-cache רגיל בקריאה הבאה (`ok===1`, "a failed load must not have poisoned the cache"). |
| 6 | **מוטציה (אוטומטית)** | `MutatedCacheWithoutGenerationCheck` מריץ את רצף מקרה 3: מוודא ש-`resurrected===true` — כלומר בלי בדיקת ה-generation, ה-fetch שקדם ל-`invalidate()` **כן** מחזיר את `['stale-v1']` ל-cache ואף fetch חדש לא מתחיל. |
| 7 | **רגרסיה** | ראו סעיף 4. |

### מקרה 6 — הוכחת המוטציה על המקור עצמו (ידני)

הוסרה בדיקת ה-generation מ-`load().then(success)` ב-`src/metaGatewayReliability.ts` (השארתי רק `this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs, generation }); return value;`), `npm run build`, ואז:

```
$ node scripts/test-meta-routes-cache.js
AssertionError [ERR_ASSERTION]: a fetch from before invalidate() must not repopulate the cache

1 !== 2

    at main (C:\Users\haim\Projects\parpar sagol\scripts\test-meta-routes-cache.js:130:12) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: 1,
  expected: 2,
  operator: 'strictEqual',
  diff: 'simple'
}
```

**מה זה הוכיח:** בלי בדיקת ה-generation, ה-fetch האיטי שהתחיל לפני `invalidate()` נחת עם `['stale-v1']` וכתב אותו חזרה ל-cache. לכן ה-`get()` שאחרי ה-`invalidate()` ראה רשומה "טרייה" ולא הפעיל `load()` — `httpCalls` נשאר `1` במקום `2`. ה-assertion המדויק שנכשל: `assert.equal(httpCalls, 2, 'a fetch from before invalidate() must not repopulate the cache')` (`test-meta-routes-cache.js:130`).

לאחר מכן **שוחזרה** בדיקת ה-generation, `npm run build`, והבדיקה חוזרת לעבור:

```
$ node scripts/test-meta-routes-cache.js
Meta routes cache tests passed.
```

---

## 3. סבב רגרסיה מלא

`npm run build` → נקי (`tsc`, exit 0). לאחר מכן כל `scripts/test-*.js` פרט לבדיקות load/scale/benchmark ולבדיקות שדורשות Postgres חי:

```
PASS=46  FAIL=1   (skips: scale-load ×2, load-burst ×2, decision-recovery-scale, postgres-burst, postgres-dirty-tables-benchmark)
```

(`test-referral-ranking.js` הורץ בנפרד ללא timeout וסיים `EXIT=0`; ה-FAIL היחיד שנשאר הוא `test-postgres-migration-pilot.js` — ראה למטה.)

בדיקות שנגזרות ישירות מהשינוי — **כולן עברו**:

| בדיקה | תוצאה |
| --- | --- |
| `test-meta-routes-cache.js` (חדשה) | PASS |
| `test-meta-gateway-reliability.js` (מכסה `AsyncExpiringCache` הקיים) | PASS |
| `test-meta-gateway-inbox.js` | PASS |
| `test-meta-campaign-routing.js` | PASS |
| `test-meta-trigger-age-window.js` | PASS |
| `test-meta-contact-payload.js`, `test-meta-media-cache.js`, `test-meta-speed-and-list-presentation.js`, `test-meta-typing-indicator.js`, `test-meta-webhook-signature.js` | PASS |
| `test-client-disable.js` (גורף מקור על `provisioningStatus === 'disabled'`) | PASS |
| `test-bulk-redeploy-status.js`, `test-redeploy-existing-client.js` | PASS |
| `test-dokploy-provisioner-postgres.js`, `test-provider-health.js` | PASS |

`test-meta-gateway-reliability.js` בפרט מריץ את חוזה ה-`AsyncExpiringCache` הקיים (single-flight על miss מקבילי, שימוש-חוזר ברשומה טרייה, רענון על תפוגה, "failed loads must not poison the cache") — כולם עברו אחרי ההרחבה עם ה-generation.

### ה-FAIL היחיד — לא קשור לשינוי

**`scripts/test-postgres-migration-pilot.js`** — נכשל עם `DATABASE_URL is required and must point to an empty pilot database`. תלות תשתית טהורה (Postgres חי + `DATABASE_URL`), לא קיים בסביבה המקומית. הקובץ אינו מוזכר בשינוי ואינו נוגע ב-A5-1 (`grep` על `metaGatewayReliability|routesCache|meta-routes|AsyncExpiringCache|routeMetaGatewayInbound` → אין התאמה). נכנס לריפו ב-`d9bbe26 Add isolated PostgreSQL migration pilot`, שהוא אב-קדמון ל-`master` (הענף שלי בנוי מעל `master` ללא שינוי בקובץ).

**הערה על `scripts/test-referral-ranking.js`** — בהרצת ה-runner עם timeout של 90ש' לכל בדיקה היא סומנה FAIL בגלל משך ריצה (>2 דק', השהיות אמת). בהרצה נפרדת ללא timeout: `Referral ranking and menu tests passed.` ואז `EXIT=0`. הקובץ אינו נוגע ב-A5-1.

---

## 4. משימת אימות `route_ms` (לא בדיקה אוטומטית)

התוכנית מבקשת לקרוא `route_ms` מלוגי פרודקשן אמיתיים (`[META_GATEWAY_ROUTED] ... route_ms=...`) כבסיס לפני המימוש. אין גישה ללוגי פרודקשן מסביבת הפיתוח הזו, כך שהבסיס לא נלכד כאן. הלוג עצמו **לא שונה** — אותה שורה, אותו שדה `route_ms` (נמדד מ-`routingStartedAt` עד סיום ה-forward). ההשוואה תיעשה מהלוגים אחרי הפריסה: לפני המימוש כל הודעה במספר משותף עשתה fan-out חי ל-`/owner-api/meta-routing-snapshot` לכל N הקליינטים; אחרי, ה-routes מגיעים מ-cache שרוענן ברקע ורק ה-pending הוא fan-out חי.

---

## 5. File-delivery pause/resume — לא מומש בכוונה

**File-delivery pause/resume לא מומש בכוונה — נשאר לתוכנית נפרדת עתידית.** זו החלטה מודעת, לא השמטה.

התוכנית (`docs/shared-number-resilience-plan-2026-09-03.md`) מסמנת את חלק "File-Delivery" במפורש: *"לא מאושר למימוש בסבב הזה"*, ומפרטת ארבע נקודות עיצוב פתוחות (state machine עם `resuming`, scope מבוסס `AsyncLocalStorage`, `claim(batchSize)` במקום `claim(1)`, וחוזה `drain()`/shutdown) שכולן דורשות עיצוב + בדיקת עומס ייעודית (300/1,000/5,000 פריטים) לפני שממשיכים.

בהתאם לכך, **לא נגעתי** ב-`waitForOutboxFileDelivery` (`messageFlow.ts`), ב-pause/resume של `createSenderDrainer`, ואין `SenderDrainerControl` או כל שלד שלו. `createSenderDrainer` ב-`metaGatewayReliability.ts` נשאר בדיוק כפי שהיה.

---

## 6. רשימת קומיטים

ענף `shared-number-resilience-fix`, מעל `049f0f6` (`master`):

- `dcab4fa` — `A5-1: generation-aware AsyncExpiringCache + invalidate()` — הרחבת המחלקה הכללית ב-`src/metaGatewayReliability.ts`.
- `e469a14` — `A5-1: route gateway inbound through a background-refreshed routes cache` — חיבור ה-cache ל-`routeMetaGatewayInbound`, רענון ברקע, invalidation פר-שינוי-סטטוס-לקוח, לוגים.
- `A5-1: tests for the routes cache + results doc` (הקומיט האחרון בענף) — `scripts/test-meta-routes-cache.js` + מסמך זה.
