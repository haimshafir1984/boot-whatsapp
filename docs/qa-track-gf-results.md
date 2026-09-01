# QA - מסלולים G ו-F - 2026-09-01

**סוג המשימה:** בדיקה בלבד. לא בוצע שינוי קוד, לא פריסה, לא נגיעה בפרודקשן.
**קומיט נבדק:** `8fff225` ("Record what the concurrency fix leaves behind"), ענף `master`.
**תנאי פתיחה:** `npm run build` עבר נקי (tsc, ללא שגיאות).
**פריסה בפועל:** Dokploy (לא Railway). ראה ממצא **DOC-1**.

---

## תקציר מנהלים - תשובות לשאלות שנשאלו

| # | שאלה | תשובה קצרה |
|---|---|---|
| 1 | אילו ברירות מחדל ב-`config.ts` לא מתאימות לעומס קמפיין גדול | `BOT_REPLY_DELAY_MS` לא-Meta = 1000ms; `delayMs` פר-שלב לא נחסם ב-runtime (רק בכתיבה, 60s); `FILE_DELIVERY_WAIT_TIMEOUT_MS`=20s חוסם slot של שולח; `FLOW_RECOVERY_WINDOW_MS`=24h עדיין קשיח ולא ניתן לשינוי - זה מנוע ההצטברות. ראה G3-1..G3-4 |
| 2 | האם לקוח חדש מ-`dokployProvisioner` מקבל הגדרות נכונות, ומה אם ההקמה נעצרת | ברובן כן, אך: `META_APP_SECRET` אופציונלי → אימות webhook עלול להישאר כבוי (G2-1); הקמה שנעצרת אחרי `postgres.create` ולפני `postgres.deploy` משאירה DB לא-פרוס והלקוח נכנס ל-crash loop (G2-2); תגובת HTTP אבודה אחרי `application.create` → Service יתום ב-Dokploy (G2-3) |
| 3 | כמה זמן בנייה אפשר לחסוך ומה הסיכון | ~4-4.5 דקות מתוך ~7. הסרת Chromium: -128s/-759MB, סיכון = אובדן fallback חירום ל-WEB_JS (החלטה מוצרית). `node_modules` מה-builder במקום `npm ci` שני: -75s, סיכון נמוך. `COPY` ממוקד לפני build: חוסך rebuilds, סיכון אפסי. ראה F1 |
| 4 | פריסה בטוחה בלי SIGTERM ובלי HEALTHCHECK | היום כל פריסה = אובדן כתיבות ב-`pendingWrites` + חלון 502. מיתון ידני: לפרוס רק כשאין קמפיין ציבורי פעיל, לוודא `pendingWrites=0` ב-`/health` לפני, ולהמתין. תיקון אמיתי דורש SIGTERM+flush ו-HEALTHCHECK. ראה F2/F4 |
| 5 | מגבלות משאבים ומה קורה כשנגמר הזיכרון | אין מגבלות בקוד/ריפו (אין compose, אין `--max-old-space-size`, אין `NODE_OPTIONS`). מגבלות, אם קיימות, מוגדרות ב-Dokploy UI ולא נראות מהריפו. OOM = `SIGKILL` מיידי → זהה לאובדן הנתונים של פריסה, בלי אפילו חלון flush. ראה F3 |
| 6 | 502 לסירוגין (1 מ-4) | ככל הנראה שילוב: (א) אין HEALTHCHECK → Dokploy/Traefik מנתב לקונטיינר לפני/במהלך שהאפליקציה מוכנה, כולל חלון הפריסה עצמו; (ב) `/health` עושה עבודה סינכרונית לא-טריוויאלית (סינון קמפיינים, ספירת תורים) והוא נפגע כשה-event loop רווי - בדיוק תרחיש 31/8; (ג) `pg` Pool ללא `max`/timeouts → מיצוי 10 חיבורים → `/health` תקוע. ראה F4-1 |

---

## מסלול G - הגדרות וערכי ברירת מחדל

### G1. `src/config.ts` - התנהגות כשמשתנה חסר

**מה:** אין שכבת ולידציה. `envValue()` מחזיר מחרוזת ריקה בשקט לכל משתנה מחרוזת חסר; `envFlag()` נופל ל-default. הכשל היחיד בעליית המערכת הוא `DATABASE_URL` לא תקין (`index.ts:111-115`, `process.exit(1)`).
**איפה:** `src/config.ts:7-16` (העוזרים), `src/config.ts:18-88` (כל 28 השדות מ-env).
**ראיה קונקרטית לכל שדה בעייתי:**

| משתנה | `config.ts` | מה קורה כשחסר / שגוי | חומרה |
|---|---|---|---|
| `DATABASE_URL` | `:87` | חסר → נופל ל-JSON storage בשקט (`storageFactory.ts:6-9`). לקוח Meta פרוס מצפה ל-Postgres; מעבר שקט ל-JSON מחזיר את כל באגי הסריקה-המלאה שתוקנו. | חשוב |
| `META_ACCESS_TOKEN` / `META_PHONE_NUMBER_ID` / `META_VERIFY_TOKEN` | `:28-31` | חסר → `''`. אין כשל בעלייה. webhook של Meta ייכשל באימות (`META_VERIFY_TOKEN=''`) או שליחה תיכשל ב-runtime, בלי אזהרה בהפעלה. | חשוב |
| `META_APP_SECRET` | `:32` | חסר → `''`. אימות חתימת `X-Hub-Signature-256` של Meta מושבת (ראה מסלול E). לא נדרש ב-`assertClientProvisioningConfig`. | חשוב |
| `BOT_REPLY_DELAY_MS` | `:36` | שגוי (`"abc"`) → `Number()` = `NaN` נשמר ב-config. ממותן ב-`messageFlow.ts:40-43` עם `Number.isFinite`. לא מזיק אך config עצמו מכיל NaN. | שיפור |
| `FILE_DELIVERY_WAIT_TIMEOUT_MS` | `:37` | מוגדר כמחרוזת ריקה `""` → `Number("")` = `0` → `messageFlow.ts:33-36` נותן `Math.max(0, 0)` = `0` → המתנה לאישור מסירה של קבצים מבוטלת, סדר ההודעות שנצפה ע"י המשתמש עלול להתערבב. חסר → 20000 תקין. | שיפור |
| `CLIENT_MAX_CAMPAIGNS` | `:23` | `Number(envValue(...)) || 7`. הערך `"0"` → `0 || 7` = `7` (לא ניתן להגדיר "אפס קמפיינים"). `"abc"` → `NaN || 7` = 7. סביר, אך `|| ` על `0` הוא באג שקט. | שיפור |
| `ADMIN_PORT` | `:77` | `Number(process.env.PORT) || 3001`. אם `PORT` שגוי → 3001, אך Dokploy מגדיר `PORT=3001` (`dokployProvisioner.ts:402`), התאמה. | תקין |
| `CLIENT_SERVICE_EXPIRES_AT` | `:24` | חסר → `''`. אין ולידציה שזה תאריך ISO תקין; ערך שבור פשוט לא ייאכף. | שיפור |
| `WHATSAPP_PROVIDER` | `:27` | חסר → `'BAILEYS'`. משפיע על ברירות מחדל של `contactsProvider`, `BOT_REPLY_DELAY_MS`, `MAX_TRIGGER_AGE_MS`. ערך שגוי (למשל `META_CLOUD`) → נופל למסלול Baileys עם Chromium scheduler. אין ולידציה מול רשימה סגורה. | חשוב |

**תיקון מוצע:** להוסיף פונקציית `validateConfig()` שנקראת ב-`main()` לפני `createStorage()`: (1) לאמת ש-`WHATSAPP_PROVIDER` ∈ {`BAILEYS`,`META_CLOUD_API`,`TWILIO_API`}; (2) אם `META_CLOUD_API` - לדרוש `META_ACCESS_TOKEN`,`META_PHONE_NUMBER_ID`,`META_VERIFY_TOKEN`,`META_APP_SECRET` ולהיכשל בעלייה אם חסר; (3) להחליף `Number(x) || default` ב-`Number.isFinite` מפורש כדי לאפשר `0`; (4) להדפיס אזהרה כש-`DATABASE_URL` חסר על לקוח שאינו Baileys. סיכון: נמוך; משנה כשל שקט לכשל רועש בעלייה, מה שעדיף.

**הערה על "42 משתני סביבה":** בפועל `config.ts` קורא ~28 משתני env ייחודיים ישירות (חלקם עם fallback ל-`DOKPLOY_*`). שאר ה-42 שבמסמך ה-QA הם משתנים שנצרכים ב-`dokployProvisioner.ts` וב-`adminServer.ts` (למשל `GOOGLE_CLIENT_ID`, `DOKPLOY_*`, `OWNER_ACCESS_TOKEN`) ולא ב-`config.ts`. פירוט ה-`DOKPLOY_*` במסלול G2.

---

### G1-known. אימות: ברירת המחדל של `contactsProvider`

**מה:** המסמך מציין כ"ידוע" ש-`contactsProvider` מקבל `'google'` כברירת מחדל לכל לקוח Meta חדש וגורם ל-966 משימות שמירה תקועות. **הממצא כבר לא נכון עבור לקוחות Meta/Twilio - הוא תוקן.**
**איפה:** `src/storage.ts:603`.
**ראיה:**
```js
contactsProvider: config.WHATSAPP_PROVIDER === 'TWILIO_API' || config.WHATSAPP_PROVIDER === 'META_CLOUD_API' ? 'manual' : 'google',
```
לקוח Meta חדש מקבל היום `'manual'`. רק לקוח **Baileys** מקבל `'google'` כברירת מחדל. הטיפוס עצמו כבר צומצם ל-`'google' | 'manual'` (`storage.ts:183`) - כלומר `'icloud'` הוסר.
**חומרה:** שיפור (אימות בלבד). נותרה שאלה פתוחה: לקוח **Baileys** חדש עדיין מקבל `'google'` בלי חיבור Google בפועל - אותו דפוס הצטברות שקטה עדיין קיים במסלול Baileys. שווה לוודא ש-`contactQueue` לא מנסה לרוקן משימות `google` כשאין טוקן Google, או שהוא מסמן אותן `failed` מהר במקום `pending` לנצח.
**תיקון מוצע:** להחיל את אותו היגיון גם על Baileys - ברירת מחדל `'manual'` עד שחובר Google בפועל, ולעדכן ל-`'google'` ברגע ש-OAuth הושלם.

---

### G2. הקמת לקוח חדש - `src/dokployProvisioner.ts`

#### G2-1. `META_APP_SECRET` אינו נדרש בהקמת לקוח Meta

**מה:** `assertClientProvisioningConfig` דורש `metaAccessToken`, `metaPhoneNumberId`, `metaDisplayPhoneNumber`, `metaVerifyToken` - **אך לא `metaAppSecret`**. בבניית ה-env, `META_APP_SECRET` נכתב רק `if (this.config.metaAppSecret)`.
**איפה:** `src/dokployProvisioner.ts:489-497` (ה-assert), `src/dokployProvisioner.ts:440` (`if (this.config.metaAppSecret) envLines.push(...)`).
**ראיה קונקרטית:** אם `DOKPLOY_META_APP_SECRET` לא מוגדר בשירות המנהל, לקוח Meta יוקם בהצלחה, ייפרס, ויקבל webhook עובד - **בלי `META_APP_SECRET`**. כתוצאה, אימות חתימת `X-Hub-Signature-256` על ה-webhook של Meta מושבת (ראה `config.ts:32`, הערך יהיה `''`). כל גורם שמכיר את כתובת ה-webhook יכול להזריק הודעות נכנסות מזויפות.
**חומרה:** חשוב (חוצה למסלול E - אבטחה).
**תיקון מוצע:** להוסיף `!this.config?.metaAppSecret && 'DOKPLOY_META_APP_SECRET'` לרשימת ה-`missing` ב-`assertClientProvisioningConfig` (`:490-495`). סיכון: נמוך; מונע הקמת לקוח Meta לא-מאובטח. אם רוצים גמישות - לפחות להדפיס אזהרה חמורה בעת הקמה בלי app secret.

#### G2-2. הקמה שנעצרת אחרי `postgres.create` ולפני `postgres.deploy` → crash loop

**מה:** בלוק ה-PostgreSQL יוצר את ה-DB, שומר את פרטיו ב-owner storage, **ואז** קורא ל-`postgres.deploy` - הכול בתוך אותו `if (!hasRecordedPostgres(current) && provisionPostgresForNewClient)`. אם ה-`fetch` של `postgres.deploy` נכשל (רשת, timeout, 5xx של Dokploy), הפונקציה זורקת, הלקוח מסומן `failed`, אבל `hasRecordedPostgres(current)` כבר `true`.
**איפה:** `src/dokployProvisioner.ts:335-357`. ה-deploy בשורה `:355`, בתוך הבלוק שנשלט ע"י `:335`.
**ראיה קונקרטית / תרחיש כשל:**
1. `postgres.create` מצליח → `saveProgress({ dokployPostgresId, ... })` (`:347-353`).
2. `postgres.deploy` (`:355`) נכשל → `runProvision` זורק → `provisionClient` מסמן `provisioningStatus: 'failed'` (`adminServer.ts:2266-2268`).
3. המפעיל לוחץ "נסה שוב" → `runProvision` רץ שוב → `hasRecordedPostgres(current)` = `true` → **הבלוק כולו מדולג**, כולל `postgres.deploy`.
4. `databaseUrl(current)` (`:396`, דרך `:123-128`) מחזיר URL תקין תחבירית ל-DB ש**מעולם לא נפרס**.
5. הלקוח נפרס, `createStorage()` → `createPostgresBackend()` → `pool.query('select 1')` (`database.ts:257`) נכשל → `main().catch` → `process.exit(1)` (`index.ts:111-115`).
6. Dokploy מפעיל מחדש את הקונטיינר → כשל זהה → **crash loop אינסופי**, בלי הודעה ברורה למפעיל מעבר ל"failed".
**חומרה:** חשוב.
**תיקון מוצע:** להוציא את `postgres.deploy` מהתנאי `!hasRecordedPostgres`, ולהתנות אותו בדגל נפרד שנשמר (`dokployPostgresDeployRequested`), בדומה ל-`dokployDeploymentRequested` של האפליקציה (`:474-483`). כך retry ינסה שוב את ה-deploy בלבד. סיכון: נמוך-בינוני; דורש שדה חדש ב-`ClientProvisioningPatch` וב-`ManagedClient`.

#### G2-3. תגובת HTTP אבודה אחרי `application.create` → Service יתום

**מה:** `runProvision` מסתמך על כך שכל קריאת `this.post()` שמצליחה ב-Dokploy גם מחזירה תגובה שנקראת בהצלחה. אם `application.create` מבוצע בצד Dokploy אך התגובה אובדת (ניתוק רשת, timeout של `fetch` ללא AbortSignal), `this.post` זורק, `dokployApplicationId` **לא** נשמר.
**איפה:** `src/dokployProvisioner.ts:306-319` (יצירת האפליקציה), `src/dokployProvisioner.ts:511-532` (`post()` - אין timeout, אין ניסיון חוזר, אין בדיקת idempotency).
**ראיה קונקרטית:** ב-retry, `if (!current.dokployApplicationId)` (`:306`) עדיין `true` → `application.create` נקרא שוב עם אותו `name` (`serviceName` דטרמיניסטי, `:90-103`) → נוצר Service שני. הראשון (מ-`:307`) נשאר ב-Dokploy בלי רישום ב-owner storage → **משאב יתום** שלא ינוקה ע"י `deleteClientResources` (שמוחקת רק לפי IDs רשומים, `:251-263`).
**אותו דפוס** קיים עבור `mounts.create` (`:324`), `postgres.create` (`:336`), `domain.create` (`:457`).
**חומרה:** חשוב (עלות תשתית מצטברת + בלבול בתחזוקה).
**תיקון מוצע:** (1) ב-`post()` להוסיף `AbortSignal.timeout(15_000)` ולוג ברור על כל כשל רשת; (2) לפני `application.create` לקרוא `application.all`/list ולחפש Service בשם הצפוי - אם קיים, לאמץ את ה-ID במקום ליצור חדש; (3) לתעד ב-owner storage "provisioning checkpoint" גם כשקריאה נכשלת, כדי שניקוי ידני יוכל למצוא יתומים. סיכון: בינוני; משנה זרימת הקמה קריטית - דורש בדיקה מול Dokploy אמיתי.

#### G2-4. מה בדיוק מקבל לקוח חדש - ולידציה של ערכי ברירת מחדל

**מה:** בלוק ה-env של לקוח חדש (`dokployProvisioner.ts:385-451`). נבדק שכל שורה מוגדרת. נמצאו כמה החלטות קשיחות שלא ניתנות לשינוי פר-לקוח:
**איפה / ראיה:**

| שורה | ערך | הערה |
|---|---|---|
| `:392` | `CLIENT_REFERRAL_CONTEST_ENABLED=true` | קשיח `true` לכל לקוח, גם כשברירת המחדל ב-`config.ts:25` היא `false`. אין אפשרות לכבות פר-לקוח דרך ההקמה. |
| `:395` | `BAILEYS_FALLBACK_TO_WEBJS=false` | קשיח לכל לקוח - זה מה שהופך את Chromium בבנייה למת (F1). |
| `:396` | `DATABASE_URL=...@<appName>:5432/...` | תלוי ב-DNS פנימי של Dokploy בין שירותים. אם `dokployPostgresAppName` שגוי → crash loop (כמו G2-2). |
| כל השאר | - | **לא** מוגדרים: `FLOW_RECOVERY_WINDOW_MS`, `MAX_TRIGGER_AGE_MS`, `FILE_DELIVERY_WAIT_TIMEOUT_MS`, `COMPLETED_RETENTION_MS`, הגדרות `pg` Pool, `NODE_OPTIONS`/heap. כולם נשענים על קבועים קשיחים בקוד (ראה G3). |
| `:407-410` | `BOT_REPLY_DELAY_MS` | מטופל נכון: `current.botReplyDelayMs ?? this.config.botReplyDelayMs ?? (Meta ? 250 : 1000)`, עם `Math.max(0, round)`. |

**"האם אפשר להקים אותו לקוח פעמיים":** לא בקלות. `provision()` מסדרת קריאות דרך `provisioningQueue` (`:230-233`), ו-`serviceName` כולל `client.id.slice(0,8)` (`:102`) כך ששני רשומות לקוח שונות מייצרות שמות שונים. הקמה חוזרת של **אותה רשומה** מוגנת ע"י בדיקות `if (!current.dokploy*Id)`. הפרצה היחידה היא G2-3 (תגובה אבודה).
**חומרה:** שיפור.
**תיקון מוצע:** לחשוף `referralContestEnabled` ו-hooks לכוונון ביצועים (`FLOW_RECOVERY_WINDOW_MS` לפחות) כשדות ב-`ManagedClient` שנכתבים ל-env בהקמה, במקום קבועים קשיחים.

---

### G3. הגדרות שמשפיעות על ביצועים

#### G3-1. `delayMs` פר-שלב נחסם רק בכתיבה, לא ב-runtime

**מה:** המסמך מציין ש-`delayMs` פר-שלב "לא נחסם (עד 60 שניות)". בפועל **יש** חסם של 60s - אך **רק בנתיב הכתיבה של ה-API**, לא ב-runtime.
**איפה:** חסם בכתיבה: `src/adminServer.ts:942-943`:
```js
if (typeof item.delayMs === 'number' && Number.isFinite(item.delayMs) && item.delayMs > 0) {
  step.delayMs = Math.min(Math.max(Math.round(item.delayMs), 0), 60_000);
}
```
ב-runtime - **אין חסם עליון**: `src/messageFlow.ts:2447`, `:2759`, `:2873`:
```js
const stepDelayMs = Number.isFinite(step.delayMs) ? Math.max(0, step.delayMs ?? BOT_REPLY_DELAY_MS) : BOT_REPLY_DELAY_MS;
```
**ראיה קונקרטית / תרחיש כשל:** שלב עם `delayMs` שהגיע דרך מסלול שאינו ה-API (ייבוא snapshot, `replaceStorageSnapshot` ב-`database.ts:503`, עריכה ידנית של JSON, או migration עתידי) יכול להכיל ערך גדול מ-60000. ב-runtime הוא ייושם כמות שהוא. בנוסף, גם 60s "חוקיים" מצטברים: זרימה עם 5 שלבים × 60s = 5 דקות שבהן משתתפת מחזיקה slot מתוך `META_MAX_CONCURRENT_SENDERS=50` (`adminServer.ts:1849`). ב-1000 משתתפות זה חוסם את התור.
**חומרה:** חשוב.
**תיקון מוצע:** להחיל את אותו `Math.min(..., 60_000)` גם ב-`messageFlow.ts` בשלוש נקודות הקריאה, כרשת ביטחון בלתי-תלויה בנתיב הכתיבה. סיכון: אפסי (רק מקטין השהיות חריגות).

#### G3-2. `FLOW_RECOVERY_WINDOW_MS` = 24 שעות, קשיח, לא ניתן לשינוי

**מה:** זהו מנוע ההצטברות שזוהה כשורש אירוע 31/8 (שלב 2.1 בתוכנית הייצוב - "לקצר מ-24 שעות ל-2-4"). **טרם בוצע.** הערך עדיין 24h והוא קבוע מקומפל, לא משתנה סביבה.
**איפה:** `src/messageFlow.ts:53`:
```js
const FLOW_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
```
נצרך ב-`messageFlow.ts:224` (הגדרת `expiresAt` של `timedOutDecisions`), `:300` (טיימר מחיקה), `:727` (בדיקת גיל לשחזור).
**ראיה קונקרטית:** תוכנית הייצוב מדדה 1,075 שיחות `expired-decision` מתוך 1,214 שנשמרו יממה שלמה. כל עוד הערך 24h, אותה הצטברות תחזור בקמפיין הבא עם נטישה חלקית. אין דרך לכוונן זאת פר-לקוח או בלי redeploy.
**חומרה:** חוסם (לקמפיין גדול הבא).
**תיקון מוצע:** `const FLOW_RECOVERY_WINDOW_MS = Number(process.env.FLOW_RECOVERY_WINDOW_MS) || (4 * 60 * 60 * 1000);` והוספת המשתנה ל-env של ההקמה (`dokployProvisioner.ts`). סיכון: נמוך-בינוני - מקצר את חלון השחזור של שיחה שנטשה באמצע; יש לוודא שאין תרחיש לגיטימי של חזרה אחרי >4h.

#### G3-3. `FILE_DELIVERY_WAIT_TIMEOUT_MS` = 20s חוסם slot של שולח

**מה:** כל שלב שמשגר קובץ ממתין עד 20 שניות לאישור מסירה (webhook) לפני שממשיך.
**איפה:** `src/messageFlow.ts:33-36` (הקבוע), `src/messageFlow.ts:3157` (`const deadline = Date.now() + FILE_DELIVERY_WAIT_TIMEOUT_MS`), poll כל 300ms (`:37`).
**ראיה קונקרטית:** קמפיין עם וידאו: אם ה-webhook של אישור המסירה מתעכב/חסר, כל משתתפת חוסמת slot ל-20s מלאות. עם `META_MAX_CONCURRENT_SENDERS=50` ו-1000 משתתפות שמגיעות לשלב הקובץ בו-זמנית: `20s × ceil(1000/50)` ≈ **400 שניות** של השהיה מצטברת בתור, לפני שקילת שילוב וידאו+תמונה במקביל (שלב 4.1 בתוכנית, טרם בוצע).
**חומרה:** חשוב.
**תיקון מוצע:** להוריד ל-8-10s כברירת מחדל (webhook שלא הגיע ב-10s כנראה לא יגיע), ולהפוך את ההמתנה ללא-חוסמת-slot אם אפשר (לשחרר את ה-slot ולהמשיך את הזרימה מ-callback). סיכון: נמוך - עלול להגדיל אי-סדר נתפס בהודעות במקרי קצה של transcoding איטי מאוד.

#### G3-4. `claimBatch` / `META_MAX_CONCURRENT_SENDERS` - קבועים קשיחים

**מה:** מכסת המקביליות (`50`) וגודל ה-batch (`20`) קשיחים בקוד. שלב 4.2 בתוכנית הייצוב מזהיר שהעלאתם "דורשת בדיקת עומס לפני".
**איפה:** `src/adminServer.ts:1849` (`META_MAX_CONCURRENT_SENDERS = 50`), `:1855` ו-`:1899` (`batchSize: 20`), `:1852` ו-`:1898` (`claimBatch(limit, ...)`).
**ראיה קונקרטית:** הערך הועלה מ-20 משתמע ל-50 מפורש בקומיט `7344c9b`. לא ניתן לכוונן בלי redeploy, ואין משתנה סביבה. אם ה-50 מתברר כגבוה מדי בפרודקשן (רוויית event loop כמו 31/8), אין ברז מהיר לסגור.
**חומרה:** שיפור.
**תיקון מוצע:** `Number(process.env.META_MAX_CONCURRENT_SENDERS) || 50`, מתועד כדיאל חירום. סיכון: אפסי.

#### G3-5. `MAX_TRIGGER_AGE_MS` מול backoff - אימות: מיושר

**מה:** שלב 3.2 בתוכנית ("ליישר את ה-backoff מול `MAX_TRIGGER_AGE_MS`") **בוצע**.
**איפה:** `src/messageFlow.ts:20-22` (`MAX_TRIGGER_AGE_MS` = 10 דקות ל-Meta), `src/adminServer.ts:1842-1843`:
```js
const metaInboxRetryDelayMs = (attempts) => Math.min(500 * (2 ** Math.max(0, attempts - 1)), 5_000);
```
**ראיה:** 10 ניסיונות: `0.5+1+2+4+5+5+5+5+5+5` ≈ **37.5s** סה"כ, הרבה בתוך חלון 10 הדקות. הקומיט `53e3254` ("Stop punishing a momentary routing miss with a minute of backoff") מאשר. אין ממצא - רק אימות שהתיקון קיים ונכון.
**חומרה:** תקין.

---

## מסלול F - תשתית, Docker ופריסה

### F1. `Dockerfile` - זמן בנייה

**מה:** בנייה מלאה ~7 דקות. ארבעה בזבזנים, בסדר יורד של חיסכון אפשרי.
**איפה:** `Dockerfile:1-36` (הקובץ כולו, 36 שורות).

| # | בזבזן | איפה | חיסכון | סיכון |
|---|---|---|---|---|
| F1-a | **Chromium + פונטים בכל בנייה** | `Dockerfile:15-21` | ~128s, 759MB דיסק, 217MB הורדה | **מוצרי, לא טכני.** Chromium נדרש רק ל-`whatsapp-web.js`. כל לקוח מוקם עם `BAILEYS_FALLBACK_TO_WEBJS=false` (`dokployProvisioner.ts:395`), והמסלול נכנס לפעולה רק כשהערך `'true'`. אף לקוח פרוס לא יכול להגיע לקוד שדורש Chromium. **הסרה מבטלת את ה-fallback החירומי ל-WEB_JS.** אם מקבלים את זה - להסיר את שורות `15-21` ואת `PUPPETEER_*` (`:23-24`). |
| F1-b | **`npm ci` רץ פעמיים** | `Dockerfile:6` (builder) + `:33` (prod, `--omit=dev`) | ~75s (שלב הייצור) | נמוך. להעתיק `node_modules` מ-builder ולגזום devDependencies (`COPY --from=builder /app/node_modules ./node_modules` + `npm prune --omit=dev`), במקום `npm ci` שני. סיכון: `npm prune` פחות דטרמיניסטי מ-`npm ci`; חלופה בטוחה יותר - `npm ci --omit=dev` עם cache mount (`RUN --mount=type=cache,target=/root/.npm`). |
| F1-c | **`COPY . .` לפני `npm run build`** | `Dockerfile:7` | חוסם cache: כל שינוי בכל קובץ (כולל `docs/`, `README`) מבטל את שכבת ה-build ומאלץ `tsc` מחדש (~49s) | אפסי. להעתיק ממוקד: `COPY tsconfig.json ./` ואז `COPY src ./src` לפני `RUN npm run build`. `docs/`, `.migration/` וכו' לא צריכים להיכנס ל-builder בכלל. |
| F1-d | קיבוע `node:20-slim` | `Dockerfile:2`, `:11` | - | `node:20-slim` הוא tag נע - בנייה לא רפרודוקטיבית, ועדכון minor של Node יכול להשתנות בשקט בין פריסות. לקבע ל-digest (`node:20.18.1-slim@sha256:...`). סיכון: אפסי; שיפור יציבות. |

**הערכה מצטברת:** F1-a (128s) + F1-b (75s) + F1-c (rebuilds חוזרים) → בנייה יורדת מ-~7 דקות ל-~2-2.5. תואם את הערכת תוכנית הייצוב.
**חומרה:** שיפור (F1-a - חשוב, כי 759MB לכל image מכפיל אחסון ורוחב פס פר לקוח).

---

### F2. כיבוי מסודר - אין מטפל SIGTERM

**מה:** אין `process.on('SIGTERM')` ולא `SIGINT` בשום מקום ב-`src/`. המטפל היחיד הוא `unhandledRejection`.
**איפה:** `src/index.ts:23-25` - זה כל מה שיש:
```js
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
```
`grep -rn "SIGTERM\|SIGINT\|process.on(\|process.once(" src/` → תוצאה יחידה: `src/index.ts:23`.
`backend.close()` (`database.ts:321-324`, שקורא ל-`flush()` ואז `pool.end()`) **לא נקרא משום מקום** - grep על `.close()` ו-`flush()` מראה שכל הקריאות ל-`flush()` הן בנתיב הודעה, אף אחת לא בכיבוי.

**ראיה קונקרטית - מה נאבד בכל פריסה:**
1. Dokploy שולח `SIGTERM`. Node, ללא מטפל, מסיים **מיד** את התהליך.
2. `PostgresStorageBackend.drainPendingSnapshots()` (`database.ts:282-311`) רץ אסינכרונית. אם `draining=true` ברגע ה-SIGTERM, ה-`writeSnapshotDelta` הנוכחי נקטע ב-אמצע. הכתיבה היא delta מול `persistedSnapshot` (`database.ts:295`) - קטיעה באמצע transaction גורמת ל-`rollback` בצד Postgres, כך שאין השחתה, **אך** `this.persistedSnapshot` בזיכרון כבר לא יעודכן והשינוי אבד. `queuedSnapshot` (`database.ts:249`) - שינויים שהצטברו וטרם נכתבו - אבד לחלוטין.
3. הודעות באמצע שליחה: `sendBotMessage` (`messageFlow.ts:542`) שקורא ל-`storage.flush()` אחרי כל שלב (`:550`, `:568`, ...) - אם SIGTERM מגיע בין השליחה ל-`flush`, ההודעה נשלחה למשתמש אך המצב ("שלב X הושלם") לא נשמר → אחרי restart, `restore()` (`index.ts:54-82`) משחזר את השיחה בשלב X-1 → **שליחה כפולה של שלב X**.
4. `conversationState.persist()` - נכתב סינכרונית (תוכנית הייצוב, סעיף 3), כך שברוב המקרים הוא כן נשמר לפני SIGTERM. אך `outbox_messages` ו-`campaign_events` שעברו רק דרך ה-backend האסינכרוני חשופים.
5. **כמה זמן Dokploy נותן:** לא נראה מהריפו (מוגדר ב-Dokploy/Docker, ברירת מחדל Docker היא 10s ואז SIGKILL). אין קוד שמנצל את החלון הזה בכל מקרה.

**חומרה:** חוסם - אובדן נתונים בכל פריסה, וכפילויות שליחה למשתמשים אמיתיים.
**תיקון מוצע:** ב-`index.ts`, אחרי `main()`:
```js
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining…`);
  server.close();                        // להפסיק לקבל בקשות חדשות
  try { await storage.flush(); } catch (e) { console.error('flush on shutdown failed', e); }
  try { await backend?.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```
דורש ש-`main()` יחזיר/יחשוף את `storage` ואת ה-`http.Server` (כרגע `startAdminServer` לא מחזיר אותו - `adminServer.ts`). סיכון: נמוך-בינוני; חייב timeout קשיח (למשל `setTimeout(() => process.exit(1), 8000).unref()`) שלא נתקע אם `flush()` לא חוזר, כדי לא לחטוף SIGKILL מכוער.

---

### F3. משאבים ומגבלות

**מה:** אין מגבלות משאבים מוגדרות בקוד או בריפו, ואין הגבלת heap ל-Node.
**איפה / ראיה:**
- אין `docker-compose.yml` / `compose.yaml` בריפו (`glob **/{docker-compose,compose}*.{yml,yaml}` → אין תוצאות).
- אין `.toml` / nixpacks (`glob **/*.{toml,nixpacks}` → אין תוצאות).
- `Dockerfile:36`: `CMD ["node", "dist/index.js"]` - בלי `--max-old-space-size`, בלי `NODE_OPTIONS`.
- `dokployProvisioner.ts:385-451` (env של לקוח) - לא מגדיר `NODE_OPTIONS` ולא מגבלות.
- מגבלות זיכרון/CPU, אם קיימות, מוגדרות ב-Dokploy UI פר-אפליקציה ולא נראות מהריפו - **לא ניתן לאמת במסגרת QA של קוד**.

**מה קורה כשנגמר הזיכרון:**
- אם Dokploy מגדיר `--memory` על הקונטיינר: ה-OOM killer של הקרנל שולח `SIGKILL` (לא SIGTERM) → אין אפילו חלון flush → אובדן נתונים כמו F2 אך גרוע יותר (בלי אפשרות תיקון). זהו התרחיש של 31/8 אם ההצטברות (13MB conversation-state, תוכנית הייצוב סעיף 2) הייתה ממשיכה לגדול.
- אם אין `--memory`: Node עלול לצרוך את כל זיכרון המכונה המשותפת ולהפיל שירותי לקוחות אחרים על אותו שרת Dokploy.
- `V8` ללא `--max-old-space-size` על Node 20: מזהה cgroup limit ומכוון `heap` ל-~75% ממנו; מעל זה → `FATAL ERROR: Reached heap limit → Allocation failed` וקריסה (SIGABRT), לא OOM-kill. גם כאן אין flush.

**Volumes:** `dokployProvisioner.ts:323-333` מחבר volume ל-`/app/data`. מותקנים שם: `contacts.json`, `session/`, `conversation-state.json`, `google-token.json`, `owner/clients.json`, `uploads/` (`config.ts:80-86`). אם ה-volume מתמלא: כל `writeFileSync` (תוכנית הייצוב, סעיף 2) יזרוק `ENOSPC` בנתיב חם → תלוי אם נתפס. אין ניטור גודל volume בקוד.
**מדיניות restart / crash loop:** מוגדרת ב-Dokploy, לא בריפו. `index.ts:111-115` עושה `process.exit(1)` על כשל עלייה → Dokploy מפעיל מחדש → אם הסיבה קבועה (G2-2, DB לא זמין) → crash loop. אין backoff בקוד ואין circuit breaker.
**חומרה:** חשוב.
**תיקון מוצע:** (1) להוסיף `NODE_OPTIONS=--max-old-space-size=<75% מ-limit>` ל-env של ההקמה, מותאם למגבלת הקונטיינר; (2) לתעד ולאכוף מגבלת `--memory`/`--cpus` פר-לקוח ב-Dokploy (מחוץ לריפו, אך צריך להיכתב ב-`CLAUDE.md`/runbook); (3) להוסיף ל-`/health` את גודל ה-volume ואת `process.memoryUsage().heapUsed` כדי שניתן יהיה להתריע לפני OOM. סיכון: נמוך.

---

### F4. תהליך הפריסה

#### F4-1. אין HEALTHCHECK - ומקור ה-502 לסירוגין

**מה:** אין `HEALTHCHECK` ב-`Dockerfile` בכלל. Docker/Dokploy/Traefik יודעים רק אם התהליך חי, לא אם האפליקציה מוכנה או תקועה.
**איפה:** `Dockerfile:1-36` - אין שורת `HEALTHCHECK`. נקודת ה-`/health` קיימת (`adminServer.ts:1415-1455`) אך שום דבר בתשתית לא קורא לה כתנאי לניתוב תעבורה.

**ראיה קונקרטית ל-502 (1 מ-4 בקשות ל-`/health` בזמן שהמערכת דיווחה בריאה):** שלוש סיבות משתלבות, כל אחת מספיקה לחלק מהמקרים:

1. **חלון הפריסה עצמו.** בלי HEALTHCHECK ובלי rolling deploy אמיתי (קונטיינר יחיד פר לקוח - `dokployProvisioner` יוצר application אחד), כל `application.redeploy` (`adminServer.ts:2475`, `dokployProvisioner.ts:474-479`) מוריד את הקונטיינר הישן ומעלה חדש. בין השניים - Traefik מקבל `502` כי אין backend. משך: כל זמן העלייה, כולל `applyMigrations` (`database.ts:405-420`) ו-`loadSnapshot` (`database.ts:262-266`) שסורק ~13 טבלאות. תחת snapshot גדול זה שניות.

2. **`/health` עושה עבודה סינכרונית לא-טריוויאלית.** `adminServer.ts:1416-1444`: `storage.getCampaigns()` + 5 `.filter()` נפרדים על מערך הקמפיינים, `getContactQueueStats()`, `getFailedDeliveries(100)`, `conversationState.size()`, `metaGatewayInbox.counts()`. כשה-event loop רווי (בדיוק תרחיש 31/8 - `conversationState.persist()` סינכרוני של 110ms פר מעבר שלב), הבקשה ל-`/health` ממתינה מאחורי כל העבודה הזו. אם ה-proxy מגדיר timeout קצר (5-10s), הוא מחזיר `502`/`504` גם כשהתהליך "בריא" מבחינת liveness. **זה בדיוק "יכול להחזיר תקין בזמן שהמערכת חנוקה" הפוך - הוא נכשל להחזיר בזמן.**

3. **מיצוי `pg` connection pool.** `new Pool({ connectionString })` בלי `max` (`database.ts:226`, `:509`, `adminServer.ts:3593`) → ברירת מחדל 10 חיבורים. תחת עומס עם `META_MAX_CONCURRENT_SENDERS=50` שכל אחד מריץ שאילתות + ה-`drainPendingSnapshots` + בקשות דשבורד, 10 חיבורים נגמרים. שאילתה נוספת (כולל כאלה שמאחורי `/health` דרך `storage`) ממתינה ל-checkout ללא `connectionTimeoutMillis` → ממתינה לנצח → הבקשה תלויה → proxy timeout → `502`.

**חומרה:** חשוב (F4-1 עצמו - חוסם; זו חוויית המשתמש בזמן פריסה וגם תסמין מוקדם של חנק).
**תיקון מוצע:**
- להוסיף `HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"` ל-Dockerfile.
- להוסיף `/health/live` נפרד וזול (מחזיר `200` תמיד אם התהליך מגיב, בלי לגעת ב-storage) עבור ה-HEALTHCHECK והפרוקסי, ולהשאיר את `/health` הכבד ל-owner dashboard בלבד.
- להגדיר `pg` Pool עם `max: 10-20`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000` (מסלול I1, אך ישירות רלוונטי כאן).
- אם Dokploy תומך - להפעיל rolling deploy עם המתנה ל-HEALTHCHECK ירוק לפני הפניית תעבורה.
סיכון: נמוך; `/health/live` הוא תוספת, `HEALTHCHECK` הוא metadata של image.

#### F4-2. `redeploy-all` - כשל לקוח באמצע, אין rollback

**מה:** `runBulkRedeploy` (`adminServer.ts:2284-2313`) עובר על כל הלקוחות ברצף. כשל של אחד **לא** עוצר את השאר (טוב), אך גם אין ניסיון חוזר, אין rollback, והלקוח שנכשל נשאר במצב `failed`/`deploying` לא-דטרמיניסטי.
**איפה:** `adminServer.ts:2295-2308` (הלולאה), `:2244-2272` (`provisionClient` - מסמן `failed` וזורק).
**ראיה קונקרטית:**
- לקוח שנכשל ב-`provisionClient` → `provisioningStatus: 'failed'` (`:2266-2268`), אך אם הכשל היה **אחרי** `application.saveEnvironment` (`dokployProvisioner.ts:445`) ולפני `application.redeploy` (`:475`), ה-env החדש כבר נשמר ב-Dokploy אך הקוד רץ עדיין ישן. פריסה ידנית הבאה (או deploy אוטומטי מ-git push) תרים אותו עם env חדש ללא בדיקה.
- **אין rollback.** אין שמירת "גרסה קודמת שעבדה" בקוד. חזרה לגרסה קודמת = פעולה ידנית ב-Dokploy UI (redeploy של commit קודם). לא מתועד ב-`CLAUDE.md` (ראה DOC-1).
- "נצפו כשלים אקראיים בעבר" (מסמך QA) - עקבי עם G2-3 (תגובות HTTP אבודות, `post()` בלי timeout/retry).
**חומרה:** חשוב.
**תיקון מוצע:** (1) ב-`runBulkRedeploy` להוסיף retry יחיד עם השהיה לכל לקוח שנכשל, ולרכז את הכשלים הסופיים לדוח שנשלח למפעיל; (2) לתעד runbook rollback ב-`CLAUDE.md`: איך לזהות את ה-deployment ה"ירוק" האחרון ב-Dokploy ולחזור אליו; (3) `post()` עם timeout+retry (כמו G2-3). סיכון: נמוך.

#### F4-3. `downtime` בפועל והודעות שמגיעות בזמן פריסה

**מה:** קונטיינר יחיד פר לקוח + אין SIGTERM + אין HEALTHCHECK → כל פריסה = downtime מלא של משך העלייה, והודעות נכנסות באותו חלון אובדות או נדחות.
**איפה:** `dokployProvisioner.ts` יוצר application אחד (`:306-319`) עם domain אחד (`:455-472`). אין הגדרת replicas.
**ראיה קונקרטית:**
- Webhook של Meta שמגיע בזמן שהקונטיינר למטה: Meta מקבל non-2xx (או connection refused) → Meta חוזר על ה-webhook עם backoff משלו (דקות). אם המערכת עלתה בינתיים, ההודעה תתקבל באיחור. אם `messageAgeMs > MAX_TRIGGER_AGE_MS` (10 דקות ל-Meta, `messageFlow.ts:20-22`) בזמן שסוף סוף עובד - היא תיזרק כ-`stale trigger` (`messageFlow.ts:1115`). פריסה איטית (בנייה של 7 דקות + עלייה) בזמן קמפיין חי יכולה לדחוף הודעות מעבר לסף.
- כלל בטיחות 5 במסמך ה-QA ("לפני restart: לוודא שאין קמפיין ציבורי פעיל") הוא בדיוק בגלל זה - וזה כרגע נאכף רק ידנית.
**חומרה:** חשוב.
**תיקון מוצע (בהינתן המצב הנוכחי, בלי SIGTERM/HEALTHCHECK):** נוהל פריסה בטוחה ידני:
1. לוודא ב-`/health` של הלקוח: `storage.pendingWrites === 0`, `outbox` ריק או יציב, אין `campaigns.active > 0` עם תעבורה חיה (לבדוק `route_ms` בלוגים).
2. לפרוס רק בחלון שקט (לא בשעה הראשונה של קמפיין).
3. אחרי הפריסה: `/health` → לוודא `storage.ready === true`, `conversations.pending` סביר, ואין `stale trigger` בלוג.
4. `redeploy-all` - לעולם לא בזמן קמפיין חי של אף לקוח.
תיקון קבוע: SIGTERM+flush (F2) + HEALTHCHECK+rolling (F4-1) הופכים את זה מ"downtime מלא" ל"חלון של שניות עם drain מסודר".
סיכון: נוהל בלבד, אפס סיכון קוד.

---

## ממצא תיעוד

### DOC-1. `CLAUDE.md` מתאר Railway; הפריסה בפועל היא Dokploy

**מה:** `CLAUDE.md` כולו כתוב סביב Railway (סעיף "פריסה", "משתני סביבה", "הקמת לקוחות מבודדות") - כולל `RAILWAY_PROJECT_TOKEN`, `RAILWAY_SOURCE_REPO`, `RAILWAY_API_URL`, `RAILWAY_VOLUME_REGION`, ותיאור זרימת הקמה דרך "Railway Public API". בפועל ההקמה והפריסה עוברות דרך **Dokploy** (`src/dokployProvisioner.ts`, אין `railwayProvisioner` בקוד; `git log` מלא ב-"Dokploy"; `.migration/` מלא בסקריפטי `dokploy_*`).
**איפה:** `CLAUDE.md` - סעיף "## פריסה" (מזכיר `haimshafir1984/boot-whatsapp` ו-Railway), סעיף "## משתני סביבה ותיקיות מידע" (טבלת `RAILWAY_*`), סעיף "### הקמת לקוחות מבודדות". מול `src/dokployProvisioner.ts:143-533` ו-`src/config.ts` (אין אף `RAILWAY_*`, יש `DOKPLOY_*` דרך ה-provisioner).
**ראיה קונקרטית:**
- `CLAUDE.md`: "Production רץ ב-Railway מתוך הריפו `haimshafir1984/boot-whatsapp`".
- `dokployProvisioner.ts:148-152`: `DOKPLOY_API_TOKEN`, `DOKPLOY_ENVIRONMENT_ID`, `DOKPLOY_GIT_URL`, `DOKPLOY_CLIENT_DOMAIN_SUFFIX` - אלה משתני התשתית האמיתיים.
- `dokployProvisioner.ts:197`: endpoint ברירת מחדל `http://127.0.0.1:3000/api` (Dokploy מקומי על אותו שרת).
- אין קובץ `railway.json` / `railway.toml` בריפו; יש `Dockerfile` ש-Dokploy בונה (`dokployProvisioner.ts:362-372`, `buildType: 'dockerfile'`).
**חומרה:** חשוב (מטעה כל סוכן/מפתח חדש - למשל הפניה ל-`RAILWAY_VOLUME_REGION` שלא קיים, או חיפוש Volume ב-Railway UI).
**תיקון מוצע:** לשכתב את שלושת הסעיפים ב-`CLAUDE.md` ל-Dokploy: (1) "פריסה" - Dokploy, `application.deploy`/`redeploy` דרך ה-API המקומי, ענף `master`; (2) טבלת משתני סביבה - להחליף `RAILWAY_*` ב-`DOKPLOY_API_TOKEN`, `DOKPLOY_ENVIRONMENT_ID`, `DOKPLOY_GIT_URL`, `DOKPLOY_GIT_BRANCH`, `DOKPLOY_CLIENT_DOMAIN_SUFFIX`, `DOKPLOY_CLIENT_DOMAIN_HTTPS`, `DOKPLOY_API_URL`, ומשתני ה-`DOKPLOY_META_*`/`DOKPLOY_TWILIO_*`/`DOKPLOY_GOOGLE_*`; (3) "הקמת לקוחות מבודדות" - לתאר את הזרימה ב-`runProvision` (`application.create` → `mounts.create` → `postgres.create`+`deploy` → `saveBuildType`/`saveGitProvider`/`saveEnvironment` → `domain.create` → `deploy`), כולל שכל לקוח מקבל PostgreSQL נפרד (`postgres:18`) ו-`DATABASE_URL` פנימי. סיכון: אפס (תיעוד). **לא לבצע כחלק מ-QA זה - זו המלצה.**

---

## סיכום חומרה

| חומרה | ממצאים |
|---|---|
| **חוסם** | F2 (אין SIGTERM → אובדן נתונים + כפילויות בכל פריסה), F4-1 (אין HEALTHCHECK → 502 + downtime), G3-2 (`FLOW_RECOVERY_WINDOW_MS`=24h קשיח - מנוע ההצטברות של 31/8, טרם תוקן) |
| **חשוב** | G1 (אין ולידציית config, כשלים שקטים), G2-1 (`META_APP_SECRET` לא נדרש), G2-2 (crash loop אם deploy של Postgres נכשל), G2-3 (Service יתום בתגובת HTTP אבודה), G3-1 (`delayMs` פר-שלב לא נחסם ב-runtime), G3-3 (`FILE_DELIVERY_WAIT_TIMEOUT_MS`=20s חוסם slot), F1-a (Chromium 759MB/128s בכל בנייה), F3 (אין מגבלות/heap → OOM=SIGKILL), F4-2 (`redeploy-all` בלי retry/rollback), F4-3 (downtime מלא בפריסה), DOC-1 (`CLAUDE.md` על Railway) |
| **שיפור** | G1 (edge cases: `\|\| 0`, `FILE_DELIVERY_...=""`), G1-known (Baileys עדיין `'google'` כברירת מחדל), G2-4 (הגדרות קשיחות בהקמה), G3-4 (`META_MAX_CONCURRENT_SENDERS` לא env-tunable), F1-b/c/d (חיסכון בנייה) |
| **תקין (אומת)** | G1-known (Meta/Twilio → `'manual'`), G3-5 (`MAX_TRIGGER_AGE_MS` מיושר עם backoff) |

## מה לא נבדק (מחוץ להיקף / דורש גישה שאין ב-QA קוד)

- מגבלות `--memory`/`--cpus` בפועל ב-Dokploy UI (F3) - לא נראה מהריפו.
- timeout ה-SIGKILL בפועל של Dokploy (F2) - הגדרת פלטפורמה.
- זמן downtime מדוד בפריסה אמיתית (F4-3) - דורש פריסה, אסור ב-QA זה.
- האם 502 שנצפה קשור לפרוקסי ספציפי (Traefik config) - דורש גישה ל-Dokploy.
