# תוצאות מימוש — בטיחות, מהירות, פריסה

מסמך תוצאה למשימת המימוש של `docs/safety-speed-deploy-plan-2026-09-02.md`.
**לא בוצעה פריסה בשום שלב. קוד ובדיקות בלבד.**

## תנאי פתיחה

| פריט | ערך |
|---|---|
| קומיט נבדק (בסיס) | `9e03f99` — "Fold in Codex's second review: real webhook signature gap, worker shutdown, atomic-write scoping" |
| `git log --oneline -5` | `9e03f99`, `0cf735a`, `5d93bd5`, `45bb07c`, `4f8879f` |
| `npm run build` לפני שינויים | עבר נקי (`tsc`, ללא פלט, exit 0) |
| ענף עבודה | `safety-speed-deploy-plan` (יצא מ-`master` @ `9e03f99`) |

הערה: בעץ העבודה יש שינויים לא-מקומיטים שקדמו למשימה (`META_API_SETUP.md`,
`docs/ZOMEE_SERVICE_BOT_SETUP.md`, `docs/service-bot-implementation-plan.md`,
וקבצים לא-מנוטרים תחת `.migration/` ו-`scripts/test-load-burst-todays-launch.js`).
לא נגעתי בהם; הקומיטים של המשימה מוסיפים רק קבצים שנוגעים למשימה.

---

## שלב 1 — אימות חתימת Meta (ב.1)

### מה בוצע

| שינוי | מיקום |
|---|---|
| מודול חדש: `isValidMetaSignature()` (פונקציה טהורה, HMAC-SHA256 על ה-raw body, השוואה constant-time) + `createMetaSignatureVerifier(getSecret)` (middleware factory) | `src/metaWebhookSignature.ts` (חדש, 74 שורות) |
| `verify` callback ב-`express.json()` הגלובלי שתופס `req.rawBody` | `src/adminServer.ts:1262-1267` |
| חיווט ה-middleware: `const verifyMetaSignature = createMetaSignatureVerifier(() => config.META_APP_SECRET)` | `src/adminServer.ts:1269-1275` |
| החלת ה-middleware על ה-route: `app.post('/webhooks/meta/whatsapp', verifyMetaSignature, (req, res) => {...})` | `src/adminServer.ts:1963` |
| import | `src/adminServer.ts:36` |
| ערך `test:meta-webhook-signature` ב-scripts | `package.json` |

### התאמה לתוכנית (B.1, שלושה חלקים)

1. **תפיסת body גולמי** — בוצע כ-`verify` callback על `express.json()` הגלובלי,
   בדיוק כפי שהתוכנית מציינת. `req.rawBody` הוא ה-`Buffer` המדויק ש-Meta חתמה עליו.
2. **אימות HMAC בשער** — `createMetaSignatureVerifier` מחזיר 403 **לפני** ה-handler
   (לפני `enqueue`/ניתוב). השוואת `crypto.timingSafeEqual` עם בדיקת אורך מקדימה.
   כש-`META_APP_SECRET` לא מוגדר → `next()` בלי חסימה (סעיף 3 בתוכנית).
   ההבדל היחיד מקוד הדוגמה בתוכנית: ה-middleware חולץ לפונקציית factory במודול
   נפרד כדי שהוא עצמו (ולא עותק שלו) ייבדק ב-unit test — תואם לדפוס הקיים בקוד
   (`validateTwilioSignature` פונקציה עצמאית, `metaGatewayReliability.ts` מייצא helpers).
3. **Audit** — ראה "שאלה פתוחה" למטה. **לא בוצע — אין לי גישה לסביבה.**

**היקף:** רק `POST /webhooks/meta/whatsapp` (השער שמקבל תעבורה ישירה מ-Meta).
`POST /internal/meta/whatsapp` (`adminServer.ts:~2820`) כבר מוגן ב-`requireOwnerApiToken`
ולא נגעתי בו. `GET /webhooks/meta/whatsapp` (verification challenge) לא רלוונטי לחתימה.

### שאלה פתוחה — לא ידוע, דורש בדיקה נוספת (חסם לפני שהאימות הופך לחובה)

**Audit של `META_APP_SECRET` בלקוחות קיימים לא בוצע.** התוכנית (B.1 שלב 3) דורשת לבדוק
אילו לקוחות מנוהלים בפועל רצים **בלי** `META_APP_SECRET` מוגדר ב-env של הקונטיינר,
לפני שהאימות הופך לחובה (ב-`assertClientProvisioningConfig` — פריט נפרד שלא נכלל
במשימה הזו).

- אין לי גישה לממשק Dokploy ולא ל-owner storage של הפרודקשן.
- `data/owner/clients.json` המקומי מכיל רק לקוח בדיקה אחד כושל מסוג BAILEYS,
  בלי `managementUrl` — לא מייצג את הפרודקשן.
- **הקוד שנכתב בטוח גם בלי ה-audit:** כשאין secret → `next()` בלי חסימה, כך ש-webhook
  של לקוח בלי secret ממשיך לעבוד כרגיל. ה-audit חוסם רק את הצעד הבא (הפיכה לחובה),
  שאינו חלק מהמשימה הזו.

**סטטוס: לא ידוע — דורש בדיקה של האונר מול Dokploy/פרודקשן.**

### בדיקות — `scripts/test-meta-webhook-signature.js` (חדש)

שתי שכבות. פלט מלא מההרצה:

```
$ node scripts/test-meta-webhook-signature.js
  layer 1 (isValidMetaSignature) — 10 assertions passed; big body = 1080048 bytes
[META_GATEWAY_SIGNATURE_REJECTED] 127.0.0.1 sha256=00000000000000000
[META_GATEWAY_SIGNATURE_REJECTED] 127.0.0.1 (none)
[META_GATEWAY_SIGNATURE_REJECTED] 127.0.0.1 sha256=71eecad284ca18fa2
  layer 2a (secret set) — 403 on bad/missing, 200 + enqueue on valid
  layer 2b (secret unset) — request passes through unverified, handler runs
Meta webhook signature tests passed.
EXIT: 0
```

**שכבה 1 — `isValidMetaSignature()` טהורה (10 assertions):**
- חתימה תקינה על גוף webhook אמיתי (עם טקסט עברי, `object: whatsapp_business_account`, ~1KB) → `true`.
- חתימה שחושבה עם secret אחר → `false`.
- חתימה מעוותת (`sha256=deadbeef`, נכשלת במסלול אי-התאמת אורך) → `false`.
- חתימה בפורמט תקין אבל שגויה (`sha256=` + 64 אפסים, נכשלת במסלול `timingSafeEqual`) → `false`.
- header חתימה ריק / `undefined` → `false`.
- secret ריק → `false` (אי אפשר לאמת).
- שינוי בייט אחד בגוף → החתימה נפסלת.
- גוף גדול (~1.08MB) עם יוניקוד עברי (`'שלום עולם '.repeat(60000)`) → חתימה תקינה עוברת.
  זה מכסה את דרישת "rawBody נכון גם עבור payloads גדולים/עם unicode עברי".

**שכבה 2 — ה-middleware האמיתי (`createMetaSignatureVerifier`) מעל HTTP אמיתי:**
אפליקציית express מינימלית עם אותו חיווט כמו `adminServer.ts` (אותו `express.json`
עם `verify` שתופס `rawBody`, אותו middleware), handler מרגל שסופר קריאות במקום `enqueue`.

- *secret מוגדר:*
  - חתימה תקינה → `200`, `handlerHits === 1` (מגיע ל-enqueue), ה-handler קיבל את הגוף המפורסר.
  - חתימה שגויה (`sha256=` + 64 אפסים) → `403`, `handlerHits` נשאר `1` (אין side effect, לא הגיע ל-enqueue).
  - חתימה חסרה → `403`, `handlerHits` נשאר `1`.
  - חתימה מ-secret של "תוקף" → `403`, `handlerHits` נשאר `1`.
- *secret לא מוגדר (`() => ''`):*
  - בקשה בלי חתימה כלל → `200`, `handlerHits === 1` (לא חוסמים בלי secret, סעיף 3).

`npm run build` אחרי השינוי: עבר נקי (exit 0).

### קומיט

`3889b68` — "Verify X-Hub-Signature-256 on the Meta webhook gateway route"

---

## שלב 2 — SIGTERM תקין (א.1)

האונר אישר להמשיך לשלב 2 (ה-audit של `META_APP_SECRET` נשאר שאלה פתוחה — ראה למטה).

### מה בוצע

| שינוי | מיקום |
|---|---|
| מודול חדש `createShutdownHandler({ server, workers, storage, graceMs?, exit?, log?, errorLog? })` — drain מסודר: `server.close()` → `Promise.all(workers.stop())` → `storage.close()` ב-try/catch → `exit(0)`. טיימר כפוי `graceMs` (ברירת מחדל **22_000**) → `exit(1)`. דגל `shuttingDown` לחסימת אות שני. **בלי** `storage.flush()` נפרד. | `src/shutdown.ts` (חדש) |
| `startContactSaveQueue` מחזיר `{ stop: () => Promise<void> }`; `while (!stopping)` במקום `while (true)`; `if (stopping) break;` אחרי שליפת job (לפני `processOne`); `stop()` קובע `stopping = true`, ממתין ל-`loop`, ומאפס `workerStarted` | `src/contactQueue.ts:9,56-84` |
| `startOutboxDispatcher` מחזיר `{ stop }` (במקום `NodeJS.Timeout`); `inFlight` מחזיק את ה-tick הרץ; `if (stopping) break;` בתוך לולאת ה-tick; `stop()` קובע `stopping`, `clearInterval`, וממתין ל-`inFlight` | `src/outboxDispatcher.ts:81-125` |
| `startServiceBotFollowUpDispatcher` — אותו דפוס בדיוק; `if (stopping) break;` בתוך לולאת ה-`for` | `src/serviceBotFollowUpDispatcher.ts:9-49` |
| `startAdminServer` מחזיר `import('http').Server` (`return app.listen(...)`) במקום `void` | `src/adminServer.ts:1245,4437` |
| `index.ts` — לוכד את ארבעת ה-handles, בונה `createShutdownHandler`, רושם `process.on('SIGTERM'|'SIGINT')` | `src/index.ts:16,97-108` |
| עדכון קוראים קיימים: `clearInterval(timer)` → `await timer.stop()` | `scripts/test-outbox-claim.js:54`, `test-outbox-durability.js:102`, `test-outbox-ordering.js:51` |
| ערך `test:graceful-shutdown` ב-scripts | `package.json` |

### התאמה לתוכנית (A.1) וסטיות מכוונות

- סדר ה-shutdown תואם בדיוק לתוכנית: HTTP (עם `await` אמיתי דרך Promise) → שלושת ה-workers עם המתנה לעבודה בטיסה → רק אז `storage.close()`. grace 22s. `storage.flush()` נפרד לא נוסף (מאושר בתוכנית — `close()` כבר עושה שקט מלא).
- **חילוץ ל-`src/shutdown.ts`** במקום קוד inline ב-`index.ts` — כדי שסדר ה-drain ייבדק ב-unit עם fakes. הלוגיקה זהה לקטע בתוכנית (אין outer try/catch מסביב לשלבים 1-2, כמו בתוכנית; רק `storage.close()` עטוף).
- **`contactQueue.stop()` מאפס `workerStarted = false`** (ו-`stopping = false` בכניסה) — תוספת קטנה מעבר לקטע בתוכנית, כדי לאפשר restart של ה-worker בתוך אותו תהליך (נדרש לבדיקות; לא מזיק בפרודקשן כי דבר לא מפעיל מחדש worker תוך כדי shutdown).
- **`startWhatsAppScheduler` לא נעצר ב-shutdown** — A.1 מגדיר במפורש שלושה workers + server + storage. ה-scheduler רלוונטי רק ל-BAILEYS; לקוחות Meta/Twilio (אלה עם כאב הפריסה) לא מפעילים אותו. מחוץ להיקף A.1.

### שאלות פתוחות — לא ידוע, דורש בדיקה נוספת

1. **grace period ב-Dokploy (א.1.1):** ה-timeout הפנימי 22s עוזר רק אם ה-stop grace period של Dokploy ≥ 22s (עדיף ≥ 30s). אין לי גישה להגדרות Dokploy. **סטטוס: לא ידוע — דורש בדיקה/הגדרה של האונר ב-Dokploy לפני שמסתמכים על ה-drain המלא.**
2. **דיוק ציפייה (exactly-once):** shutdown מסודר מקטין משמעותית כפילויות אבל לא מבטיח אפס — החלון בין `send()` בפועל ל-Meta לבין `markOutboxSent`+`flush` נשאר. הבדיקה למטה מאמתת שהחלון נסגר כשה-tick מספיק להשלים, ושהודעה שהושלמה לא נשלחת שוב.

### בדיקות — `scripts/test-graceful-shutdown.js` (חדש)

פלט מלא:

```
$ node scripts/test-graceful-shutdown.js
  1. ordering: server.close -> workers.stop -> storage.close -> exit(0)
  2. forced timeout: wedged storage.close() -> exit(1) after graceMs, no hang
  3. double signal is a no-op
  4. storage.close() throwing is logged, shutdown still exits 0
  5. shutdown waits for in-flight HTTP before stopping workers
  6. a closed http.Server refuses new connections
   Contact queue worker started.
   Manual mode: contact recorded locally (9720000000001).
   Contact queue: saved 9720000000001 as "x".
   Contact queue worker started.
   Manual mode: contact recorded locally (9720000000001).
   Contact queue: saved 9720000000001 as "x".
  7. contactQueue.stop() ends the loop; no processing after it resolves
  8. outboxDispatcher.stop() waits for a mid-send dispatch; no write races close()
  9. serviceBotFollowUpDispatcher.stop() waits for the current tick
Graceful shutdown tests passed.
EXIT: 0
```

מיפוי מול דרישות הבדיקה בתוכנית:

| דרישה בתוכנית | בדיקה |
|---|---|
| SIGTERM באמצע `sendTrackedOutboxMessage` (בין `send()` ל-`markOutboxSent`+`flush`) — אחרי "restart" אין כפילות שליחה מעבר לחלון הקצר | בדיקה 8: dispatcher נעצר כשהוא תקוע בתוך `send()`. `stop()` לא מתרסולב עד ש-`send` מסתיים; אחרי כן `markOutboxSent` + ה-`flush` הסופי מתועדים **לפני** ש-`stop()` חוזר (הסדר: `flush, send:start, send:end, markOutboxSent, flush`). לאחר `storage.close()` — שום כתיבה נוספת (ה-fake זורק אם נכתב אחרי close). |
| SIGTERM כש-`outboxDispatcher` באמצע tick — ה-tick מסתיים לפני `storage.close()`, שום כתיבה לא נכשלת מול pool סגור | בדיקה 8 (אותו תרחיש) + בדיקה 1 (הסדר `worker.stop` לפני `storage.close`). |
| `server.close()` חוסם בקשות HTTP חדשות בפועל (לא רק תיאורטי) | בדיקה 6: `http.Server` אמיתי, בקשה מצליחה (200), `await server.close()`, בקשה חדשה → `ECONNREFUSED`/`ECONNRESET`. בדיקה 5: ה-handler לא עוצר workers עד ש-callback של `server.close` נורה (בקשה בטיסה). |
| timeout כפוי (20-22s) עובד אם `flush()`/`close()` נתקע (מוק שתקוע לנצח) — `process.exit(1)`, לא נתקע | בדיקה 2: `storage.close` שמחזיר Promise שלא נפתר לעולם; עם `graceMs=150` — לפני 120ms אין `exit`, אחרי — `exit([1])`, elapsed < 2000ms (כלומר דרך `graceMs` ולא ברירת המחדל 22s). |
| `contactQueue.stop()` — אין race שבו job נתפס אבל `stop()` קרה לפני `processOne` | בדיקה 7: fake storage עם אספקת jobs אינסופית; אחרי `stop()` שמתרסולב — מספר ה-`markContactSaveAttempt` קפוא ל-200ms; `stop()` לא נתקע (race מול `sleep` של 2.5s). כולל אימות ש-worker חדש עולה אחרי עצירה (איפוס דגל). |
| (נוסף) סדר, אות כפול, `storage.close()` שזורק | בדיקות 1, 3, 4. |

### רגרסיה על קוראים קיימים

`test-outbox-claim`, `test-outbox-durability`, `test-outbox-ordering` (עודכנו ל-`await timer.stop()`),
`test-service-bot-flow`, `test-flow-concurrency`, `test-meta-gateway-inbox`, `test-meta-gateway-reliability` —
כולם עברו נקי (exit 0). `test-outbox-ordering` שקודם תועד כ"נתקע ב-teardown" עכשיו יוצא נקי בזכות `await timer.stop()`.

`npm run build` אחרי כל שינויי שלב 2: עבר נקי (exit 0).

### קומיט

`<יתווסף אחרי commit>`

---

## שלבים 3-6

טרם בוצעו.

---

## שאלות פתוחות מרוכזות (מצב: לא ידוע — דורש בדיקה נוספת)

1. **Audit של `META_APP_SECRET` בלקוחות פעילים** (ב.1 שלב 3) — אילו לקוחות רצים בלי הסוד.
   חוסם את הפיכת האימות לחובה (`assertClientProvisioningConfig`), שאינו במשימה זו.
   הקוד הנוכחי fail-open ולכן בטוח בלי ה-audit.
2. **Dokploy stop grace period** (א.1.1) — האם ≥ 22-30s. אם קצר יותר, SIGKILL יקדים
   את ה-drain הפנימי.
3. **Dokploy / HEALTHCHECK routing** (א.2) — האם Dokploy/Swarm בפועל משתמשים ב-HEALTHCHECK
   לניתוב תעבורה / rolling replace, או רק כאינדיקציה תפעולית. (רלוונטי לשלב 4.)

---

## סטטוס כללי

**לא בוצעה פריסה. ממתין לאישור.**
