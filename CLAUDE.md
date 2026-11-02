# CLAUDE.md

מסמך עבודה למפתח/סוכן שעובד על הפרויקט. עודכן לאחרונה: 2026-09-29.

המטרה: להסביר מה המערכת עושה היום, איך היא בנויה ונפרסת, מה המגבלות, ומה חשוב לדעת לפני שמשנים קוד או נוגעים בפרודקשן.

> **מסמך הבסיס של הפרויקט הוא `PROJECT_HANDOFF.md`** — תמונת מצב, היסטוריה מלאה של השינויים ופתוחים. כל סבב עבודה מסתיים בעדכון שלו (סעיף "עדכון YYYY-MM-DD" בסוף + תמונת המצב בראש).
> מסמכי תכנון ותוצאות מפורטים (מתוארכים) נמצאים ב-`docs/`. הסיכום העדכני ביותר: `docs/load-testing-and-deploy-findings-2026-09-18.md`.

## תקציר המערכת

דשבורד ניהול + בוט קמפיינים ל-WhatsApp, רב-לקוחות.

- **שירות מנהל (admin)** — דשבורד בעלים שמקים ומנהל לקוחות, ומשמש גם **שער (gateway) מרכזי** למספר Meta המשותף.
- **שירות לקוח** — התקנה מבודדת לכל לקוחה (container + DB משלה), עם דשבורד בנייה של קמפיינים ב-`/client/`.

לקוחה בונה קמפיין (טריגר + רצף שלבים: הודעות, מדיה, שאלות, איסוף שם/אימייל, קבוצות, דירוג וכו'), מקבלת לינק, ומי ששולח את הטריגר עובר את הזרימה אוטומטית. אנשי קשר נשמרים ל-Google Contacts / iCloud / רישום מקומי.

## ספקי WhatsApp (`WHATSAPP_PROVIDER`)

| ערך | קובץ | הערות |
| --- | --- | --- |
| `BAILEYS` (ברירת מחדל) | `src/providers/BaileysProvider.ts` | מכשיר מקושר דרך QR / pairing code. יכול להתנתק ולדרוש סריקה מחדש |
| `META_CLOUD_API` | `src/providers/MetaCloudProvider.ts` | API רשמי. רוב הלקוחות משתפים מספר אחד דרך שער המנהל (ראו למטה) |
| `TWILIO_API` | `src/providers/TwilioProvider.ts` | **לא בשימוש.** אומת 20.9.2026: אפס לקוחות Twilio בייצור. הקוד קיים אך מת — **אל תבנו עבורו** בשינויים חדשים |
| (legacy) | `src/providers/WebJsProvider.ts` | `whatsapp-web.js` + Chromium — המימוש המקורי. לא בשימוש |

**הרכב הצי בפועל (אומת 20.9.2026 מול `/health` של כל קונטיינר):** 11 לקוחות `META_CLOUD_API` (כולם על המספר המשותף) + 3–4 `BAILEYS`. אין Twilio ואין WebJs. שינוי במסלול השליחה צריך להתייחס ל-Meta ול-Baileys בלבד.

## מספר Meta משותף ושער מרכזי — חשוב במיוחד

מספר `1207335449126872` (תצוגה 972529771002) משותף לכ-11 לקוחות `META_CLOUD_API`. Meta שולחת webhook אחד לשירות המנהל (`/webhooks/meta/whatsapp`), והוא מנתב כל הודעה ללקוח הנכון (`routeMetaGatewayInbound` ב-`src/adminServer.ts`):

1. לכל הודעה — שאילתה חיה `/owner-api/meta-pending-route` ל**כל** הלקוחות על המספר (timeout 3s, ניסיון חוזר אחד), כדי לדעת למי יש שיחה פתוחה עם השולח.
2. כשטריגר חדש מתחיל שיחה אצל לקוח אחר — handover עיוור `/owner-api/meta-clear-pending` שמחייב תשובה `{cancelled:true}`.
3. העברה ללקוח דרך `/internal/meta/whatsapp`, שמכניס ל-`metaClientInbox` ומחזיר 202 מיד.

**העיקרון: fail-closed.** אם אי אפשר לוודא מי מחזיק את השיחה — לא מנתבים (עדיף עיכוב על ניתוב כפול / שיחה שבורה). המשמעות: **לקוח אחד שלא זמין מעכב הודעות של כל הקמפיינים על המספר.** לכן:

- ה-inbox של השער מנסה שוב עד `META_INBOX_MAX_ATTEMPTS = 60` (~4.5 דקות, backoff `min(500·2^(n-1), 5000)`ms) — מספיק ל-restart של Swarm (40-60 שנ'), ובתוך `MAX_TRIGGER_AGE_MS` (10 דק' ל-Meta, `src/messageFlow.ts`).
- כשל ב-pending-check של לקוח אחד מטופל כך שלא יחסום עמיתים במקרים שבהם אפשר (`41e164c`); התראה `meta-gateway-client-blocking-peers-<clientId>`.
- `META_MAX_CONCURRENT_SENDERS = 50` — נמדד, אינו צוואר בקבוק. אל תעלו בלי מדידה רב-תהליכית.
- לקוח שמת לצמיתות (מעל ~4.5 דק') עדיין גורם לאובדן הודעות לכל המספר — מכוון; מזוהה דרך התראות.

קבצים: `src/metaGatewayInbox.ts`, `src/metaGatewayReliability.ts` (`decideMetaFallbackRoute`, `AsyncExpiringCache`, `createSenderDrainer`), `src/metaCampaignRouting.ts`, `src/metaWebhookSignature.ts`.

רקע והיסטוריה: `docs/shared-number-resilience-*`, `docs/meta-gateway-lookup-failure-blast-radius-plan-2026-09-16.md`, `docs/load-testing-and-deploy-findings-2026-09-18.md`.

## מספר ייעודי ללקוחה — Embedded Signup (Coexistence)

לקוחה שרוצה מספר WhatsApp משלה (לרוב לבוט שירות לקוחות) מקבלת קישור חד-פעמי מדף הלקוחה בדשבורד המנהל (`POST /owner/api/clients/:id/meta-connect-link`, בתוקף 7 ימים), מתחברת לפייסבוק ב-`GET /connect/meta/:token`, ומאשרת. מכאן הכול אוטומטי, ללא מגע ידני: החלפת קוד לטוקן, גילוי `Phone Number ID` **על ידי השרת** (לא מהדפדפן — ראו למטה), בדיקת ייחודיות, מינוי webhooks, סנכרון Coexistence, שמירה ופריסה מחדש (`POST /connect/meta/:token/complete` ב-`src/adminServer.ts`, לוגיקת ה-Graph API ב-`src/metaEmbeddedSignup.ts`).

**הבוט פועל רק לפי משפט טריגר, גם על מספר ייעודי** — אין ניתוב בעלים בלעדי ואין בוט ברירת מחדל (הוצאו מהיקף בכוונה). מסלול Coexistence: הלקוחה ממשיכה לעבוד גם מאפליקציית WhatsApp Business בטלפון; לכן **אין קורא ל-`.../register`** — סנכרון `smb_app_data` (אנשי קשר + היסטוריה) מחליף אותו, וכשל שם לא חוסם את החיבור אבל מפעיל התראת critical אם לא נפתר תוך 20 שעות (Meta מנתקת בערך אחרי 24 שעות).

**ממצא חשוב (2026-09-29):** אירוע ה-`FINISH` של Coexistence (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) מכיל **רק `waba_id`, לא `phone_number_id`** — בניגוד למה שהונח בתחילת התכנון. השרת מגלה את המספר בעצמו דרך `GET /<wabaId>/phone_numbers`, ועוצר בשגיאה אם יש יותר ממספר אחד (בלי מסך בחירה). פירוט מלא: `docs/embedded-signup-coexistence-event-contract-finding-2026-09-29.md`.

**מגבלת אבטחה קיימת:** טוקני Meta (כולל אלה שהתקבלו מ-Embedded Signup) נשמרים גלויים (לא מוצפנים) בקובץ ה-JSON של אחסון המנהל בדיסק — זהה לאיך ש-`metaAccessToken` נשמר היום לכל לקוח. `exposeOwnerClient` מסיר אותם מתשובות ה-API לדשבורד, אבל לא מהאחסון עצמו.

קבצים: `src/metaEmbeddedSignup.ts` (קריאות Graph API + טוקן קישור), `owner-public/connect-meta.html` (דף הלקוחה), `docs/embedded-signup-automation-plan-2026-09-28.md` (תכנון מלא), `docs/customer-owned-whatsapp-number-meta-plan.md` (רקע ארוך-טווח).

## כפתורים חוזרים (Returning buttons) — ענף `feature/returning-buttons-p3`, **לא פרוס, לא ממוזג, כל הדגלים כבויים**

מטרה: (1) כפתור ישן שהמשתתפת כבר עברה — לחיצה עליו מחזירה אותה לענף שלו והזרימה ממשיכה בסדר הרגיל; (2) לחיצה שעות אחרי שנעצרה באמצע עדיין עובדת (24 שעות מרגע שליחת הכפתור). רק Meta (לא Baileys). מפרט: `docs/returning-buttons-implementation-spec-2026-11-01.md`; הגשות וביקורות קודקס: `docs/returning-buttons-for-codex-*.md`, `docs/returning-buttons-*-codex-review-*.md`.

**איך זה עובד.** כפתור חתום (`v1.<kid>.<client>.<result>.<step>.<option>.<rev>.<exp>.<routeSig>.<sig>`, עד 200 תווים, שתי חתימות HMAC). **השער** בודק רק את חתימת הניתוב ומעביר לחיצה תקפה ישירות ללקוח המנפיק — בלי `meta-pending-route` ובלי handover (לכן גם מהיר יותר). **הלקוח** מאמת הכול: חתימה מלאה, תוקף, שהתוצאה שייכת לשולחת ושהיא ההרצה הנוכחית (`getCurrentRun`, לא `supersededAt`), קמפיין פעיל, שלב ואפשרות, ו-`rev` (חותמת מבנה הקמפיין, `src/flowRev.ts`; שינוי טקסט תצוגה לא מבטל כפתורים, שינוי מבני כן). מזהה שמתחיל ב-`v1.` שאינו תקף **נזרק** — לעולם לא יורד למסלול הישן. מזהה ישן (לא v1) עובד בדיוק כמו קודם.

**שלבים והדגלים (הכול כבוי כברירת מחדל):**

| דגל | איפה | מה עושה |
| --- | --- | --- |
| `META_RESUMABLE_HANDOVER=1` | שער | handover שמבטל גם הרצות שניתן לחדש; השער נכשל סגור אם לקוח כלשהו על המספר (כולל לקוח היעד) לא מדווח `resumable-v1` + `durable-supersede-v1`. מפעיל גם את דחיפת אישור הצי. |
| `META_BUTTON_V1_ISSUE=1` | לקוח | הנפקת כפתורים חתומים. דורש `META_BUTTON_CLIENT_ID` + מפתחות, ו**אישור צי בתוקף** מהשער; בלי אישור נשלחים כפתורים רגילים והלקוח מתריע. אתחול נכשל אם ההגדרה חלקית. |
| `META_BUTTON_JUMP=1` + `allowJumpBack` בקמפיין | לקוח + קמפיין | קפיצה לכפתור ישן (עד 10 לשעה ו-30 ל-24 שעות להרצה; הצטרפות לקבוצה דרך קפיצה: פעם בדקה, 3 ל-24 שעות). הדלקת `allowJumpBack` משנה את ה-`rev` ומבטלת כפתורים שכבר נשלחו. **לכל הקמפיינים של לקוח בבת אחת (בלי לערוך כל קמפיין): `META_BUTTON_JUMP_ALL=1` בלקוח** (עדיין דורש `META_BUTTON_JUMP=1`; אין מתג בממשק, ו-`allowJumpBack` בקמפיין נקבע רק דרך ה-API). |

**משתני סביבה:** שער/מנהל — `META_BUTTON_ROUTE_MASTER_KEYS`, `META_BUTTON_FULL_MASTER_KEYS` (`kid:מפתח,...`; הראשון לנתב והאימות בשער, השני רק להקצאה), `META_BUTTON_REVOKED_KIDS`, `META_BUTTON_LEASE_TTL_MS` (ברירת מחדל 180000), `META_BUTTON_LEASE_PUSH_MS` (60000). לקוח — `META_BUTTON_CLIENT_ID`, `META_BUTTON_ROUTE_KEYS`, `META_BUTTON_FULL_KEYS`, `META_BUTTON_ISSUE_KID`, `META_BUTTON_REVOKED_KIDS`, `JUMP_MAX_PER_HOUR/DAY`. מנהל ל-provisioner — `DOKPLOY_BUTTON_V1_ISSUE=1` (אחרת ה-provisioner מקצה מפתחות אבל לא מדליק הנפקה).

**הקצאת מפתחות:** לקוח חדש מקבל את שלושת המשתנים מה-provisioner (`src/buttonKeys.ts`, נגזרים דטרמיניסטית משני טבעות המאסטר — אותם ערכים בכל redeploy). ללקוחות קיימים: `node scripts/button-keys-export.js` (כותב קובץ עם סודות לתיקיית temp, לא מדפיס מפתחות; הדבקה ידנית ב-Dokploy). **שינוי env של לקוח קיים = פריסה (Deploy) שלו.**

**נקודות קצה:** `GET /owner/api/button-v1/readiness` (מנהל; `ready=true` רק כשהשער מריץ את ה-handover, יש מפתחות, וכל לקוח על המספר המשותף נגיש, מדווח יכולות, יודע את ה-ID שלו, עובר self-test ומחזיק בדיוק את מפתח הניתוב שהשער גוזר לו), `GET /owner-api/button-v1/status`, `POST /owner-api/button-v1/lease` (לקוח).

**סדר הפעלה מומלץ (הדרגתי, אחרי Deploy ידני של הקוד והקצאת מפתחות):** (1) בדיקת `/health` — אין קמפיין פעיל; (2) `META_RESUMABLE_HANDOVER=1` בשער + לבדוק readiness; (3) `META_BUTTON_V1_ISSUE=1` בלקוח ניסוי **אחד** (בלי אישור צי הוא ממילא לא ינפיק); (4) `META_BUTTON_JUMP=1` + `allowJumpBack` על קמפיין אחד בלבד. כל שלב — מעקב בלוג: `[META_GATEWAY_V1_ROUTED]`, `[META_V1_BUTTON_ANSWER]/_RESUME/_JUMP`, `[META_GATEWAY_V1_REJECTED]`, `[META_V1_BUTTON_REJECTED]`, `[JUMP_REJECTED]`, `[JUMP_RECONCILE]`, `[BUTTON_V1_LEASE_WITHHELD]`. כיבוי: להוריד את הדגל; כפתורים שכבר נשלחו ממשיכים לעבוד עד שיפוגו (24 שעות).

**אחרי קריסה באמצע קפיצה:** היומן (`CampaignResult.jumps`) נכתב לפני השליחה הראשונה. סריקת `deliveryRecovery` או אותו webhook שחוזר משלימים את אותה קפיצה בלי רשומה חדשה ובלי לצרוך מכסה; הודעה שכבר נשלחה לא נשלחת שוב (מפתחות `jump:<id>:<n>`); תוצאה לא ודאית נשארת `uncertain` ולא נשלחת שוב; הרצה שהוחלפה → `abandoned`.

**מדידות (סימולטור `scripts/measure-peak-3campaigns.js`, אפשרות `--signed-buttons`):** דגלים כבויים — אין האטה לעומת `master` (3 ריצות מול 3). דגלים דולקים — תגובה ללחיצה וסיום זרימה זהים (בתוך הרעש) גם בהיסטוריה גדולה וגם עם לקוח איטי; ניתוב בשער p99 גבוה ב-14–37ms (כנראה בדיקת הצי כל 2 שניות בסימולטור, בייצור כל דקה — לא הוכח). לא נמדד: קפיצה בעומס, תדירות ייצור של בדיקת הצי.

## פקודות

```bash
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm run dev        # ts-node
```

בדיקות: כ-29 סקריפטי `npm run test:*` (בדיקות יחידה/אינטגרציה של זרימות, outbox, Postgres, שער Meta, provisioner, התראות ועוד), ועוד ~70 סקריפטים ב-`scripts/test-*.js`. רוב הבדיקות רצות על `dist/` — להריץ `npm run build` קודם.

בדיקות עומס (מקומיות, לא נוגעות בפרודקשן):

```bash
node scripts/test-load-gateway-noisy-vs-quiet.js
node scripts/test-load-client-responsiveness.js --count=100
node scripts/test-load-multiprocess-focus.js
```

כללי מדידה: להריץ **ברצף, לא במקביל**; לא למדוד latency בתהליך Node יחיד (תחרות CPU מדומה); תרחיש אחד לכל תהליך; outage = connection refused, לא hang. פירוט ב-`docs/load-testing-and-deploy-findings-2026-09-18.md`.

### ניתוח לוגים של קמפיין (לקוחה מול שער)

להוריד לוג מלא דרך SSH (`docker service logs --timestamps`), **לפני כל פריסה** (לוג נמחק כשהקונטיינר מוחלף), ולהריץ `scripts/compare-gateway-client.js` ו-`scripts/analyze-focus-failures.js`. פירוט, פרמטרים, שאילתות PostgreSQL לגיבוי כשהלוג נמחק, רשימת כתובות `/health` לניטור חיצוני: `docs/runbook-campaign-log-download-and-analysis.md`.

## פריסה (Production)

- ריפו: `haimshafir1984/boot-whatsapp`, ענף **`master`** (לא לשנות ל-`main` בלי החלטה מפורשת).
- פלטפורמה: **Dokploy על Docker Swarm**, שרת `169.58.236.130` (SSH עם `~/.ssh/flowsbiz_hetzner_ed25519`). שירות המנהל: `flowsbiz-admin-akr2zu`. קוד כל אפליקציה על השרת: `/etc/dokploy/applications/<app>/code`.
- הקמת לקוחה חדשה נעשית מדשבורד המנהל דרך `src/dokployProvisioner.ts`.

### ⚠️ Deploy מול Redeploy

- **"Deploy"** פר-אפליקציה ב-UI של Dokploy — עושה clone מחדש ובונה קוד עדכני. **זה מה שצריך אחרי push.**
- **"Redeploy"** / כפתור "Redeploy all clients" בדשבורד המנהל (`redeployExistingClient` → `application.redeploy`) — בונה מחדש מהקוד שכבר על השרת ו**לא מושך commits חדשים**. ב-2026-09-18 התגלה שכל 15 הלקוחות רצו על קוד ישן בגלל זה.
- אחרי פריסה — לאמת קומיט בפועל בכל אפליקציה (`git -C /etc/dokploy/applications/<app>/code log -1`) ו-`/health`, לא להסתמך על סטטוס ה-UI.

### כללי עבודה מול פרודקשן

- לא לעשות push או deploy בלי אישור מפורש מהמשתמש באותו רגע. לחיצות Deploy בפרודקשן מבצע המשתמש.
- לפני נגיעה בפרודקשן — לבדוק ב-`/health` שאין קמפיין פעיל (חלון שקט).
- ב-Swarm `docker stop` גורם ל-restart אוטומטי; לעצירה אמיתית: `docker service scale <svc>=0`.
- Meta Graph API (נכון ל-2026-09-18): quality_rating GREEN, throughput STANDARD.

## אחסון

- `DATABASE_URL` מוגדר → **PostgreSQL** (`src/database.ts`); אחרת JSON מקומי (`src/storage.ts`, `STORAGE_PATH`). בפרודקשן — Postgres. `src/storageFactory.ts` בוחר.
- כתיבות snapshot הן delta append-only (`writeSnapshotDelta`, לוקח חיבור ייעודי מה-pool — mocks בבדיקות צריכים `connect()`).
- מצב שיחה נשמר אטומית לדיסק (`src/conversationState.ts`, `CONVERSATION_STATE_PATH`) ומשוחזר אחרי restart.
- הודעות יוצאות עוברות outbox עמיד (`src/outboxDispatcher.ts`).
- שמירת אנשי קשר בתור רקע (`src/contactQueue.ts`) — הבוט לא מחכה ל-Google/iCloud.
- מיגרציה: `npm run db:migrate` (dry-run), `db:migrate:apply`, `db:export`.

## מבנה קוד עיקרי

| קובץ | תפקיד |
| --- | --- |
| `src/index.ts` | נקודת כניסה: storage, שרת, outbox, תורים, ספק WhatsApp, graceful shutdown |
| `src/adminServer.ts` | Express: דשבורד מנהל/לקוח, API, webhooks, שער Meta, `owner-api`, `internal` |
| `src/messageFlow.ts` | מנוע זרימת הקמפיין (טריגרים, שלבים, עיכובים, גיל טריגר מקסימלי) |
| `src/triggerDetector.ts` | זיהוי טריגר: אחרי ניקוי תווים בלתי נראים והתעלמות מאותיות גדולות/קטנות, ההודעה **מכילה** את משפט הטריגר (`includes`; אם כמה מתאימים — הארוך מנצח). ללא fuzzy |
| `src/serviceBot.ts`, `src/serviceBotFollowUpDispatcher.ts` | בוט שירות |
| `src/systemAlerts.ts` | התראות מערכת במייל (`notifySystemAlert`, throttle 30 דק' לכל key) |
| `src/ownerStorage.ts` | נתוני דשבורד המנהל (לקוחות, ניתוב) |
| `src/whatsappLifecycle.ts` | watchdog וחיבור מחדש |
| `src/metaEmbeddedSignup.ts` | Embedded Signup למספר ייעודי (Graph API, טוקן קישור חד-פעמי) |
| `src/buttonToken.ts`, `src/buttonVerify.ts`, `src/buttonIssuer.ts`, `src/buttonLease.ts`, `src/buttonKeys.ts`, `src/flowRev.ts` | כפתורים חוזרים (חתימה, אימות בשער/לקוח, הנפקה, אישור צי, הקצאת מפתחות, חותמת מבנה) — ראו הסעיף למעלה |
| `public/index.html`, `public/login.html` | ה-frontend — HTML יחיד בלי build |

## מודל קמפיינים

- **בוט** — הלקוחה כותבת טריגר; סיומת קבועה לשם איש הקשר (למשל ` - (Bot)`).
- **המלצה** — משפט בסיס + שם ממליץ יוצרים טריגר מלא; סיומת עם שם הממליץ.

זיהוי הטריגר הוא התאמת תת-מחרוזת (`includes`) אחרי נרמול, לא fuzzy: שינוי מילה בתוך המשפט = לא מזוהה; הודעה שמכילה את המשפט בתוספת טקסט — מזוהה.

## משתני סביבה עיקריים

| משתנה | תפקיד |
| --- | --- |
| `PORT` | ברירת מחדל 3001 |
| `WHATSAPP_PROVIDER` | ראו טבלת ספקים |
| `DATABASE_URL` | Postgres |
| `OWNER_ACCESS_TOKEN` / `CLIENT_ACCESS_TOKEN` | סיסמאות דשבורד מנהל / לקוחה |
| `META_*` | `ACCESS_TOKEN`, `APP_SECRET`, `VERIFY_TOKEN`, `PHONE_NUMBER_ID`, `DISPLAY_PHONE_NUMBER`, `GRAPH_API_VERSION`, `GATEWAY_BASE_URL` |
| `META_APP_ID`, `META_EMBEDDED_SIGNUP_CONFIG_ID` | Embedded Signup למספר ייעודי (שירות מנהל בלבד) — חסר אחד מהם מסתיר את כפתור הקישור ומחזיר 404 מ-`/connect/meta/*` |
| `DOKPLOY_*` | ערכי ברירת מחדל שהמנהל מעביר ללקוחות חדשים (Meta/Twilio) + גישת API |
| `TWILIO_*` | הגדרות Twilio |
| `GOOGLE_*` | OAuth של Google Contacts |
| `SYSTEM_ALERT_EMAIL_TO/FROM`, `SMTP_*` / `ALERT_SMTP_*` | התראות מערכת |
| `STORAGE_PATH`, `SESSION_PATH`, `CONVERSATION_STATE_PATH`, `UPLOADS_PATH` | נתיבי נתונים (volume) |

## מגבלות ידועות ופתוחים

1. לקוח Meta שמת לצמיתות חוסם את המספר המשותף אחרי ~4.5 דק' (fail-closed מכוון).
2. כפתור "Redeploy all clients" לא מושך קוד — לתקן אחרי ההשקה, בזהירות.
3. לקוחות Baileys עלולים להיכנס ללולאת QR ולדרוש סריקה מחדש (נכון ל-2026-09-18: "רות", `1e970c66`).
4. `AsyncExpiringCache` מוחק רשומה כשרענון נכשל — מועמד ל-grace period.
5. סף ה-SLO של `scripts/test-load-shared-campaign-isolation.js` (median 7s) לא יציב בין ריצות.
6. Embedded Signup למספר ייעודי (`docs/embedded-signup-automation-plan-2026-09-28.md`) עדיין לא נבדק מול Meta עם לקוחה אמיתית/ניסיונית — Configuration אמיתי ב-`boot1` טרם הוקם. ניתוב בעלים בלעדי ובוט ברירת מחדל הוצאו מהיקף בכוונה (הבוט פועל רק לפי טריגר, גם על מספר ייעודי).

## הערות פיתוח

- לא לשלוח vCard בלי בקשה מפורשת.
- שינוי defaults ב-`src/config.ts` לא משפיע על לקוחות קיימים שההגדרות שלהם כבר שמורות ב-DB.
- לא להניח ש-Google המחובר שייך לבעל המערכת — זה החשבון שחובר בדשבורד.
- אחרי שינוי frontend: `npm run build` ובדיקה בדפדפן.
- קבצים לא מחויבים רבים בעץ העבודה (docs/scripts/.migration) שייכים לעבודות אחרות — לא לכלול אותם בקומיטים בלי בקשה.
- mocks בבדיקות מתיישנים כשה-API הפנימי משתנה — כשבדיקה "עוברת" לוודא שהיא באמת מבצעת את מה שהיא בודקת.
