# תוצאות מימוש — בטיחות, מהירות, פריסה

מסמך תוצאה למשימת המימוש של `docs/safety-speed-deploy-plan-2026-09-02.md`.
**לא בוצעה פריסה בשום שלב. קוד ובדיקות בלבד.**

## אימות עצמאי (קומיט `b7bd073`)

עברתי על כל הדיפים, בניתי מחדש, והרצתי הכל בעצמי — כולל שתי בדיקות מוטציה (החזרת בדיקת החתימה
ל"תמיד מאשר", היפוך סדר ה-shutdown) שאישרו ששתי הבדיקות הקריטיות באמת תופסות רגרסיה, לא רק "רצות".

**נוסף למה שדווח:**

- **סבב בדיקות רחב יותר** (34 סוויטות, לא רק אלה שנגעו ישירות) חשף כשל אחד — `test-load-burst-campaign.js`
  נכשל עם `pool.connect is not a function`. **אומת ב-git ancestry שזה קדם לענף הזה לגמרי**
  (`e54d1a0` הוא אב-קדמון של `ff47ebb`, קומיט B2-1 מהיום) — ה-mock pool של הבדיקה מעולם לא תמך
  ב-`.connect()`, ותיקון B2-1 שבר אותו בלי שאף אחד שם לב כי הוא לא היה בסבב הבדיקות של B2-1. **לא קשור
  לעבודה של המשימה הזו.** תוקן (הוספת `connect()` ל-`MockPool`), נבדק (300/300 הצליחו בכל שלושת התרחישים),
  קומיט נפרד.
- **סגרתי את הפער של "בדיקות Postgres/docker לא הורצו — אין DB בסביבה"**: יש לי גישה ל-`flowsbiz_test`
  המקומי. הרצתי `test-postgres-transactions`, `test-flush-scoped-wait`, `test-postgres-delta`,
  `test-postgres-no-lost-writes` — **כולן עוברות נקי**. מאשר ש-`storage.ts`/`conversationState.ts` לא
  שברו את נתיב ה-Postgres. `docker build` בפועל עדיין לא נבדק (אין Docker בסביבה שלי גם).

**מסקנה:** ששת השלבים תואמים בדיוק לתוכנית המתוקנת — כולל הסדר ההפוך במחיקת קמפיין ובחירת המשתמש
המפורשת בעריכת flow (לא היוריסטיקה), שני התיקונים שקודקס דרש בסקירה השנייה. `INCLUDE_CHROMIUM` לא נגוע,
כמתוכנן. שלוש השאלות הפתוחות (audit, grace period, HEALTHCHECK routing) עדיין פתוחות — לא ניתן לאמת
אותן מקוד בלבד, דורשות גישה לפרודקשן/Dokploy.

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

`5f9589b` — "Ordered SIGTERM/SIGINT drain with stoppable workers"

---

## שלב 3 — תיקון מחיקת קמפיין (ב.2)

### מה בוצע

| שינוי | מיקום |
|---|---|
| `DELETE /api/campaigns/:id`: `storage.deleteCampaign(id)` **קודם**; `conversationState.removeByCampaign(id)` רק אם `ok === true`. מחזיר גם `conversations` (מספר השיחות שנותקו) | `src/adminServer.ts:4383-4390` |
| ערך `test:campaign-delete-conversations` ב-scripts | `package.json` |

### התאמה לתוכנית

תואם בדיוק לקטע ב.2: הסדר ההפוך (ניקוי שיחות לפני המחיקה) חשוף למצב שבו המחיקה
נכשלת אחרי שכבר נותקו שיחות פעילות — נזק בלי תועלת. עכשיו: מחיקה, ואם הצליחה — ניקוי.

### עריכת flow (PUT) — מומש עם מודאל מלא (אושר ע"י האונר: "ממש עכשיו, מודאל מלא")

**שרת** — `PUT /api/campaigns/:id` (`src/adminServer.ts:4370-4383`): אחרי `updateCampaign`
מוצלח, אם `req.body.endActiveConversations === true` → `conversationState.removeByCampaign(existing.id)`,
ומחזיר `endedConversations`. **בלי היוריסטיקה בצד שרת** — השרת מכבד את הדגל כפי שנשלח.

**לקוח** — `public/index.html`:
| שינוי | מיקום |
|---|---|
| `let editingOriginalFlowJson` — snapshot של ה-flow כפי שנטען לעורך | `public/index.html:2224-2226` |
| `openEditModal`: `editingOriginalFlowJson = JSON.stringify(getDecisionFlow())` מיד אחרי `populateCampaignConversation` (אותה נורמליזציה כמו בשמירה) | `public/index.html:~3029` |
| `openNewModal`: `editingOriginalFlowJson = null` | `public/index.html:~2986` |
| `askEndActiveConversationsChoice()` — Promise שמחזיר `'end'` / `'keep'` / `'cancel'`; overlay-click ו-Escape = `'cancel'`; focus על "keep" | `public/index.html:~3092` |
| `submitCampaign`: אם `editingId` **וגם** `JSON.stringify(conversation.decisionFlow) !== editingOriginalFlowJson` → פותח מודאל; `'cancel'` → מבטל שמירה; אחרת `body.endActiveConversations = choice === 'end'` | `public/index.html:~3163` |
| אחרי שמירה מוצלחת: `editingOriginalFlowJson` מתאפס ל-flow שנשמר (עריכה נוספת באותו סשן תשאל שוב רק אם ישתנה שוב) | `public/index.html:~3188` |
| מודאל `#flowEditConfirmOverlay` (מחלקות `.modal-overlay`/`.modal` הקיימות, `z-index:300`) — כותרת "שינית את שלבי השיחה", שלושה כפתורים: השאר (ברירת מחדל, מומלץ) / סיים עכשיו / ביטול, + הערת הסבר | `public/index.html` (לפני `</body>`) |

**התאמה לתוכנית:** "פעולה מפורשת" ולא "ניחוש היוריסטי" — הלקוח מזהה שינוי flow אמיתי
(השוואת JSON מול ה-snapshot שנטען) ומציג בחירה; ברירת המחדל היא **לא** לנתק ("להשאיר").
אם המשתמש לא שינה את ה-flow — אין מודאל, אין דגל, התנהגות זהה למאסטר.

**בדיקה ידנית בדפדפן:** הופעל `dist/index.js` (JSON mode), התחברות לקוח, המודאל אולץ
פתוח דרך console — נרנדר ממורכז, מעוצב תואם-דשבורד, `z-index:300`, שלושת הכפתורים
והכותרת נכונים, `typeof askEndActiveConversationsChoice === 'function'`. (צילום מסך נלקח.)
בדיקת תחביר: `new Function()` על גוש ה-`<script>` היחיד — 0 שגיאות.

### בדיקות — `scripts/test-campaign-delete-conversations.js` (חדש)

מריץ את ה-route האמיתי של admin-server מעל HTTP (התחברות לקוח → cookie → `DELETE`).

```
$ node scripts/test-campaign-delete-conversations.js
OWNER_ACCESS_TOKEN is not configured. Temporary owner access code: k61la4HG7zrYbAIGpKR2vvxg
  Gateway retry: base 500ms, cap 5000ms, drain every 500ms
🖥️  Admin dashboard → http://localhost:41655
  failure path — delete fails, conversationState untouched (no stranded conversations)
  success path — campaign deleted first, then its conversations cleared
  flow edit (PUT) — endActiveConversations flag honoured as sent, no server-side guessing
Campaign delete / conversation cleanup tests passed.
EXIT: 0
```

- **DELETE מסלול כשל:** `storage.deleteCampaign` מוחלף למוק שמחזיר `false`. `DELETE` →
  `200 { ok:false, conversations:0 }`; שתי השיחות עדיין קיימות; השיחה של הקמפיין
  ה"נמחק" **לא** הוסרה. (מכסה "מחיקה שנכשלת → conversationState לא נוגע".)
- **DELETE מסלול הצלחה:** `deleteCampaign` אמיתי. `DELETE` → `200 { ok:true, conversations:1 }`;
  בדיוק השיחה של אותו קמפיין הוסרה; השיחה של הקמפיין השני נשארה; הקמפיין נעלם
  מ-storage. (מכסה "מחיקה מוצלחת → conversationState מנוקה".)
- **PUT בלי הדגל:** עריכת flow עם `conversation` חדש בלי `endActiveConversations` →
  `200 { endedConversations:0 }`; השיחה הפעילה נשארה.
- **PUT עם `endActiveConversations:true`:** →`200 { endedConversations:2 }`; **כל** השיחות
  הפעילות של אותו קמפיין (2) נותקו; שיחות של קמפיינים אחרים לא נגעו.

`npm run build` אחרי השינוי: עבר נקי (exit 0).

### קומיט

- `9dcb139` — "Delete campaign before detaching its live conversations" (DELETE fix)
- `d42337a` — "Ask before ending live conversations on a campaign flow edit" (PUT modal)

---

## שלב 4 — `/health/live` + HEALTHCHECK (א.2)

### הנחה לא-מאומתת (לפי הוראות המשימה — לתעד ולהמשיך)

**לא נבדק אם Dokploy/Swarm בפועל משתמשים ב-HEALTHCHECK לניתוב תעבורה / rolling
replace, או רק כאינדיקציה תפעולית.** אין לי גישה לממשק/תיעוד Dokploy. גם אם זו רק
אינדיקציה תפעולית — זה עדיין שיפור: מבדיל קונטיינר חי מתקוע, ו-`/health/live` זול
מספיק כדי לא להיתקע מאחורי `/health` הכבד. **סטטוס: לא ידוע — דורש בדיקה נוספת**
(שאלה פתוחה 3).

### מה בוצע

| שינוי | מיקום |
|---|---|
| `GET /health/live` — מחזיר `200 {ok:true,live:true}` בלי לגעת ב-`storage` בכלל (לא `getCampaigns`, לא queue stats, לא failed deliveries). ה-`/health` הכבד נשאר לדשבורד | `src/adminServer.ts:1415-1421` |
| `HEALTHCHECK --interval=15s --timeout=5s --start-period=100s --retries=3` עם probe `node -e "require('http').get('.../health/live', ...)"` | `Dockerfile` (לפני `CMD`) |
| ערך `test:health-live` ב-scripts | `package.json` |

`start-period=100s` (לא 40s) — לפי התוכנית המעודכנת; DB גדול צריך זמן ל-`applyMigrations`+
`loadSnapshot`. הערה ב-Dockerfile: לכייל מחדש אחרי מדידת boot→ready אמיתית בפריסה הבאה.

### בדיקות — `scripts/test-health-live.js` (חדש)

```
$ node scripts/test-health-live.js
OWNER_ACCESS_TOKEN is not configured. Temporary owner access code: LEdTrGWafbDXEhFHBkYfFc03
  Gateway retry: base 500ms, cap 5000ms, drain every 500ms
🖥️  Admin dashboard → http://localhost:44272
  1. /health/live -> 200 {ok:true,live:true}
  2. storage broken -> /health/live 200, /health 500
  3. under a 30x /health burst: 40x /health/live all 200, p95=2ms max=69ms
Health liveness probe tests passed.
EXIT: 0
```

- **בדיקה 1:** `/health/live` → `200 {ok:true,live:true}`.
- **בדיקה 2:** חמש מתודות storage (`getCampaigns`/`getContactQueueStats`/`getFailedDeliveries`/
  `getOutboxHealth`/`getStorageHealth`) מוחלפות למוקים שזורקים ("storage not ready /
  migration"). `/health/live` → `200`; `/health` הכבד → `500`. מכסה "מחזיר 200 גם
  כש-storage לא ready".
- **בדיקה 3:** 300 שורות campaignResults נזרעות כדי ש-`/health` יעשה עבודה אמיתית;
  30 בקשות `/health` במקביל + 40 בקשות `/health/live` סדרתיות ביניהן — כולן `200`,
  **p95=2ms, max=69ms**. מכסה "לא עושה קריאת DB — חוזרת מהר גם תחת עומס מדומה על ה-event loop".

**אימות ה-probe עצמו:** הורץ הקוד המדויק מה-Dockerfile (`node -e "require('http')
.get('http://127.0.0.1:3001/health/live', r=>process.exit(r.statusCode===200?0:1))..."`)
מול `dist/index.js` חי — `status 200, exit 0`.

**אימות Dockerfile:** `docker` לא זמין בסביבה המקומית — לא הורץ `docker build`. תחביר
ה-HEALTHCHECK (המשך שורה עם `\`, shell-form `CMD`) נבדק בעין; הקוד ב-`node -e` הורץ בנפרד.

`npm run build` אחרי השינוי: עבר נקי (exit 0).

### קומיט

`10a4b01` — "Add a storage-free /health/live probe and container HEALTHCHECK"

---

## שלב 5 — Atomic write, JSON mode בלבד (ב.3)

### מה בוצע

| שינוי | מיקום |
|---|---|
| `ConversationStatePersistenceBackend` — נוסף `isPrimaryConversationStore?(): boolean` (true רק ב-JSON mode, כשקובץ ה-state הוא מקור האמת היחיד) | `src/conversationState.ts:202-220` |
| `Storage.isPrimaryConversationStore()` → `return !this.backend` (אין backend = JSON mode) | `src/storage.ts:1082-1085` |
| `persist()`: אם `this.backend?.isPrimaryConversationStore?.() === true` → כתיבה אטומית (`.tmp` → `copyFileSync` ל-`.bak` → `renameSync`), בדיוק כמו `storage.ts:897-903` / `metaGatewayInbox.ts`. אחרת → `fs.writeFileSync` הרגיל (**ללא שינוי**) | `src/conversationState.ts:~395-415` |
| `restore()`: קריאת הקובץ עברה ל-`readSnapshotFile()` שמנסה קודם את הקובץ הראשי ואז `${filePath}.bak`; מחזיר `undefined` אם שום דבר לא מתפרסר (במקום לזרוק/לאבד הכל) | `src/conversationState.ts:357-372` |

### התאמה לתוכנית (ב.3) והיקף מצומצם

- **רק JSON mode** מקבל כתיבה אטומית. הסימן הוודאי: `Storage` בלי backend של Postgres.
  לא הנחתי — ה-mode נקבע מפורשות: `storageFactory.ts` יוצר `Storage` עם `backend` רק
  כש-`config.DATABASE_URL` מוגדר; `isPrimaryConversationStore()` מחזיר `!this.backend`.
- **נתיב הכתיבה של Postgres mode לא נגע** — כשיש backend (או backend סינתטי בבדיקות),
  הענף הוא בדיוק `fs.writeFileSync(this.filePath, json, 'utf-8')` כמו במאסטר. עיצוב
  ה-fallback ל-Postgres mode (כתיבה מדי N דקות / רק ב-shutdown / רק בכשל DB) — **לא**
  נכלל, כפי שהתוכנית מציינת שהוא דורש עיצוב נפרד.
- ה-`.bak` fallback ב-`restore()` פועל בשני המצבים (זול, לא מזיק) — אם הקובץ הראשי
  קטוע והיה `.bak` תקין, הוא ישוחזר.

### בדיקות — `scripts/test-conversation-state-atomic-write.js` (חדש)

```
$ node scripts/test-conversation-state-atomic-write.js
  1. JSON mode — atomic write, .bak = previous good snapshot, no .tmp left behind
Conversation state file ...\p2.json is unreadable (Unexpected end of JSON input); trying fallback.
  2. restore — truncated main file, recovers cleanly from .bak
Conversation state file ...\p3.json is unreadable (Expected property name or '}' ...); trying fallback.
  3. restore — truncated main, no .bak -> returns 0, no throw
  4. non-primary backend (no isPrimaryConversationStore()) — plain write, no .bak/.tmp (Postgres path unchanged)
  4. non-primary backend (isPrimaryConversationStore() === false) — plain write, no .bak/.tmp (Postgres path unchanged)
Conversation-state atomic write tests passed.
EXIT: 0
```

- **JSON mode (בדיקה 1):** `Storage` בלי backend, `isPrimaryConversationStore() === true`.
  אחרי `set()` — הקובץ קיים ומתפרסר, **אין `.tmp` שנשאר**. אחרי `set()` שני — `.bak`
  נוצר ומכיל את ה-snapshot הקודם (שיחה אחת) בעוד הראשי מכיל שתיים.
- **קריסה מדומה (בדיקה 2):** הקובץ הראשי = JSON קטוע (`'{"version":1,"conversations":{"x@c.us":'`),
  `.bak` = snapshot תקין. `restore()` → `1` (שוחזר מ-`.bak`), השיחה בזיכרון. **restore
  נכשל בצורה נקייה על הקובץ הישן התקין, לא על הקטוע.**
- **קטוע בלי `.bak` (בדיקה 3):** `restore()` → `0`, **בלי לזרוק**.
- **Postgres mode / regression (בדיקה 4):** backend סינתטי בלי `isPrimaryConversationStore`
  ו-backend עם `isPrimaryConversationStore: () => false` — אחרי `set()` הקובץ נכתב
  (התנהגות קיימת נשמרת) אבל **אין `.bak` ואין `.tmp`** — הענף האטומי לא נכנס לפעולה
  ב-non-JSON mode. מכסה "לוודא אין שינוי בהתנהגות הכתיבה הקיימת".

**רגרסיה:** `test-conversation-state-flow-rehydration` ו-`test-flow-recovery` — עברו נקי (exit 0).
בדיקות שדורשות Postgres חי (`test-postgres-no-lost-writes`) לא הורצו — אין DB מקומי בסביבה.

`npm run build` אחרי השינוי: עבר נקי (exit 0).

### קומיט

`a506b7b` — "Atomic conversation-state file write in JSON mode + .bak restore fallback"

---

## שלב 6 — אופטימיזציות build קטנות (א.3, החלק שבהיקף)

### מה בוצע — `Dockerfile`

| לפני | אחרי |
|---|---|
| builder: `COPY . .` | `COPY tsconfig.json ./` + `COPY src ./src` (זה כל מה ש-`tsc` צריך — `tsconfig` עם `"include": ["src/**/*"]`) |
| prod: `COPY --from=builder /app/{public,owner-public,site-public,scripts}` | `COPY {public,owner-public,site-public,scripts}` ישירות מה-build context (ה-builder כבר לא מכיל אותם) |
| `dist` | ללא שינוי — עדיין `COPY --from=builder /app/dist ./dist` |
| `npm ci --omit=dev` | **ללא שינוי** (לפי ההוראה — לא להחליף ב-`npm prune`) |

**תועלת:** שכבת ה-`COPY src` בבילדר כבר לא נפסלת מ-cache בגלל קבצי root לא-קשורים
(`.migration/`, `*.md` ברמת השורש, `.tmp-*`, `design-prototype/`, `tmp/`). אלה גם כבר
לא נכנסים לתמונת ה-builder בכלל.

**נכונות:** `tsc` צורך רק `tsconfig.json`+`src/` (אומת: אף קובץ ב-`src/*.ts` לא מייבא
מחוץ ל-`src/`). `scripts/` מועתק ב-prod **לפני** `npm ci --omit=dev`, כך ש-`postinstall`
(`node scripts/patch-baileys-prelogin-ack.js`) עדיין רץ. `.dockerignore` ממשיך לסנן את
כל תיקיות ה-`COPY` הישירות.

### מה לא נעשה (מחוץ להיקף לפי התוכנית וההוראות)

- **Chromium דרך Build Arg (`INCLUDE_CHROMIUM`)** — התוכנית: "בפריסה נפרדת לגמרי, אחרי
  שכל השאר יציב". לא נגעתי.
- **BuildKit npm cache mount** — התוכנית מסמנת כאופטימיזציה עתידית שדורשת בדיקה נפרדת.
- **החלפת `npm ci --omit=dev` ב-`npm prune`** — ההוראה: להשאיר כמו שהוא.

### בדיקות

אין בדיקה אוטומטית לשינוי Dockerfile. `docker` לא זמין בסביבה המקומית — **לא הורץ
`docker build`**. אימות בעין: הבילדר מקבל בדיוק את מה ש-`tsc` צריך; ה-prod מקבל `dist`
מהבילדר ואת תיקיות הסטטיק מה-context בסדר הנכון (`scripts` לפני `npm ci --omit=dev`).
`npm run build` מקומי (שמשתמש באותם `tsconfig`+`src`) — עבר נקי (exit 0).

**הנחה לא-מאומתת:** שרשרת ה-`COPY` החדשה תעבור ב-`docker build` של Dokploy. סבירות
גבוהה (כל הקבצים קיימים ולא-מוחרגים), אבל לא נבדק מול Docker אמיתי.

### קומיט

`78b9ad8` — "Copy only tsconfig+src into the builder, static dirs from context"

---

## שאלות פתוחות מרוכזות (מצב: לא ידוע — דורש בדיקה נוספת)

1. **Audit של `META_APP_SECRET` בלקוחות פעילים** (ב.1 שלב 3) — אילו לקוחות רצים בלי הסוד.
   חוסם את הפיכת האימות לחובה (`assertClientProvisioningConfig`), שאינו במשימה זו.
   הקוד הנוכחי fail-open ולכן בטוח בלי ה-audit.
2. **Dokploy stop grace period** (א.1.1) — האם ≥ 22-30s. אם קצר יותר, SIGKILL יקדים
   את ה-drain הפנימי.
3. **Dokploy / HEALTHCHECK routing** (א.2) — האם Dokploy/Swarm בפועל משתמשים ב-HEALTHCHECK
   לניתוב תעבורה / rolling replace, או רק כאינדיקציה תפעולית. (רלוונטי לשלב 4.)
4. ~~עריכת flow — בחירה מפורשת ב-UI (ב.2)~~ — **הוכרע:** האונר בחר "ממש עכשיו, מודאל מלא".
   מומש בשלב 3 (מודאל `#flowEditConfirmOverlay` + דגל `endActiveConversations`).

**אף אחת מ-1-3 אינה "בוצע" — כולן דורשות בדיקה של האונר מול Dokploy/פרודקשן.**

---

## כל הקומיטים בענף `safety-speed-deploy-plan` (מעל `9e03f99`)

| hash | שלב | תיאור |
|---|---|---|
| `3889b68` | 1 | Verify X-Hub-Signature-256 on the Meta webhook gateway route |
| `1977b32` | 1 | Record step 1 commit hash in results doc |
| `5f9589b` | 2 | Ordered SIGTERM/SIGINT drain with stoppable workers |
| `d695cfb` | 2 | Record step 2 commit hash in results doc |
| `9dcb139` | 3 | Delete campaign before detaching its live conversations |
| `8487f2c` | 3 | Record step 3 commit hash in results doc |
| `d42337a` | 3 | Ask before ending live conversations on a campaign flow edit |
| (doc) | 3 | Record step 3 part 2 commit hash |
| `10a4b01` | 4 | Add a storage-free /health/live probe and container HEALTHCHECK |
| (doc) | 4 | Record step 4 commit hash |
| `a506b7b` | 5 | Atomic conversation-state file write in JSON mode + .bak restore fallback |
| (doc) | 5 | Record step 5 commit hash |
| `78b9ad8` | 6 | Copy only tsconfig+src into the builder, static dirs from context |
| (doc) | 6 | Record step 6 commit hash |

## בדיקות — ריכוז

בדיקות חדשות (כולן exit 0):

| קובץ | שלב | מכסה |
|---|---|---|
| `scripts/test-meta-webhook-signature.js` | 1 | פונקציה טהורה (10 assertions, כולל גוף ~1MB עברי) + middleware אמיתי מעל HTTP: 403 על חתימה שגויה/חסרה, 200+enqueue על תקינה, 200 בלי secret |
| `scripts/test-graceful-shutdown.js` | 2 | 9 מקרים: סדר drain, forced-timeout exit(1), אות כפול, `storage.close()` שזורק, המתנה לבקשת HTTP בטיסה, שרת סגור מסרב חיבורים, race של `contactQueue.stop()`, dispatch שנעצר באמצע send, service-bot tick |
| `scripts/test-campaign-delete-conversations.js` | 3 | DELETE: כשל→conversationState לא נוגע, הצלחה→מנוקה. PUT: בלי דגל→0, `endActiveConversations:true`→ניתוק כל שיחות הקמפיין |
| `scripts/test-health-live.js` | 4 | `/health/live` 200; 200 גם כש-5 מתודות storage זורקות (`/health`→500); 40 קריאות תחת burst של 30×`/health` — כולן 200, p95≈2ms |
| `scripts/test-conversation-state-atomic-write.js` | 5 | JSON mode: כתיבה אטומית, `.bak`=snapshot קודם, אין `.tmp`. שחזור מ-`.bak` על קובץ קטוע. קטוע בלי `.bak`→0 בלי לזרוק. non-primary backend→כתיבה רגילה בלי `.bak`/`.tmp` |

רגרסיה (כולן exit 0): `test-outbox-claim`, `test-outbox-durability`, `test-outbox-ordering`
(עודכנו ל-`await timer.stop()`), `test-service-bot-flow`, `test-flow-concurrency`,
`test-flow-recovery`, `test-conversation-state-flow-rehydration`, `test-meta-gateway-inbox`,
`test-meta-gateway-reliability`, `test-meta-campaign-routing`.

בדיקות שלא הורצו: כל מה שדורש Postgres חי (`test-postgres-*`, `test-migration-safety`)
— אין DB מקומי בסביבה. `docker build` — אין docker בסביבה.

`npm run build` — עבר נקי (exit 0) אחרי כל שלב ובסוף.

## מה לא נכלל במשימה (מפורש בתוכנית/הוראות)

- **א.3 Chromium דרך Build Arg (`INCLUDE_CHROMIUM`)** — "בפריסה נפרדת לגמרי, אחרי שכל השאר יציב".
- **ב.3 Postgres-mode fallback write** — דורש עיצוב נפרד, לא "אותו תיקון".
- **החלפת `npm ci --omit=dev` ב-`npm prune`** — ההוראה: להשאיר.
- **BuildKit npm cache mount** — אופטימיזציה עתידית.
- הפיכת אימות חתימת Meta לחובה (`assertClientProvisioningConfig`) — תלוי ב-audit (שאלה פתוחה 1).

---

## סטטוס כללי

כל ששת השלבים בסדר הביצוע המחייב הושלמו: קוד + בדיקות + תיעוד. שלוש שאלות פתוחות
(audit של `META_APP_SECRET`, grace period ב-Dokploy, שימוש בפועל ב-HEALTHCHECK לניתוב)
מסומנות **"לא ידוע — דורש בדיקה נוספת"** ולא כ"בוצע".

**לא בוצעה פריסה. ממתין לאישור.**

---

## עדכון — grace period אומת, `graceMs` שונה ל-8s (קומיט `cc40864`)

השאלה הפתוחה ב-א.1.1 **נסגרה**. האונר בדק ישירות מול השרת:

```
$ docker service inspect client-account-be61c10f-zk3aoz \
    --format '{{if .Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}{{.Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}{{else}}NOT_SET{{end}}'
10s
```

זה ה-`stop_grace_period` האמיתי שה-Swarm יכבד — לא ניחוש. ברירת המחדל שהונחה מקודם (10s, ברירת
המחדל של Docker) אושרה במדויק.

**המשמעות:** `graceMs` בברירת מחדל של **22_000** (כפי שדווח למעלה, §"מודול חדש `createShutdownHandler`")
היה שגוי בפועל — Swarm היה שולח SIGKILL אחרי 10 שניות, **12 שניות לפני** שהטיימר הפנימי שלנו היה
מגיע לפעול. כלומר ה-drain המסודר לא היה מקבל אף פעם הזדמנות לרוץ עד הסוף בפריסה אמיתית; הקונטיינר
תמיד היה נהרג בכוח ע"י הפלטפורמה קודם.

**תוקן:** `graceMs` שונה ל-**8_000** (`src/shutdown.ts`) — 2 שניות שוליים מתחת ל-10s האמיתיים.
`scripts/test-graceful-shutdown.js` עודכן (הודעת assertion בלבד, הבדיקה עצמה משתמשת ב-`graceMs=150`
משלה ולא הייתה תלויה בברירת המחדל) והורץ מחדש — 9/9 עברו.

שתי שאלות פתוחות נותרות מתוך השלוש המקוריות: audit של `META_APP_SECRET` (כל הלקוחות מוגדרים —
אושר ע"י האונר) ושימוש בפועל ב-HEALTHCHECK לניתוב (אושר: לא משמש לניתוב, רק תצוגה ב-UI). שתיהן
כבר סגורות בפועל; grace period הייתה השאלה האחרונה, ועכשיו גם היא סגורה.
