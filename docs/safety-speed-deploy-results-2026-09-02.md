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

`<יתווסף אחרי commit>`

---

## שלב 2 — SIGTERM תקין (א.1)

**ממתין לאישור להמשך** — ראה "החלטה נדרשת מהאונר" למטה.

---

## שלבים 3-6

טרם בוצעו.

---

## החלטה נדרשת מהאונר לפני שלב 2

לפי הוראות המשימה: "אם אין לך גישה לבדוק את זה [audit של `META_APP_SECRET`]
בפועל, תעד את זה כחסם ותשאל אותי לפני שממשיכים לשלב 2 - אל תניח."

אין לי גישה ל-Dokploy / owner storage של הפרודקשן. שלב 1 (קוד + בדיקות) הושלם
ובטוח לפריסה עתידית (fail-open בלי secret), אבל ה-audit עצמו לא בוצע.

**שאלה:** האם להמשיך לשלב 2 (SIGTERM), או שברצונך קודם לבצע/לספק את תוצאות
ה-audit של `META_APP_SECRET` בלקוחות הפעילים?

---

## סטטוס כללי

**לא בוצעה פריסה. ממתין לאישור.**
