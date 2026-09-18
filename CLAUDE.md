# CLAUDE.md

מסמך עבודה למפתח/סוכן שעובד על הפרויקט. עודכן לאחרונה: 2026-09-18.

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
| `TWILIO_API` | `src/providers/TwilioProvider.ts` | |
| (legacy) | `src/providers/WebJsProvider.ts` | `whatsapp-web.js` + Chromium — המימוש המקורי |

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
| `src/triggerDetector.ts` | התאמת טריגר מדויקת אחרי ניקוי תווים בלתי נראים (ללא fuzzy) |
| `src/serviceBot.ts`, `src/serviceBotFollowUpDispatcher.ts` | בוט שירות |
| `src/systemAlerts.ts` | התראות מערכת במייל (`notifySystemAlert`, throttle 30 דק' לכל key) |
| `src/ownerStorage.ts` | נתוני דשבורד המנהל (לקוחות, ניתוב) |
| `src/whatsappLifecycle.ts` | watchdog וחיבור מחדש |
| `public/index.html`, `public/login.html` | ה-frontend — HTML יחיד בלי build |

## מודל קמפיינים

- **בוט** — הלקוחה כותבת טריגר; סיומת קבועה לשם איש הקשר (למשל ` - (Bot)`).
- **המלצה** — משפט בסיס + שם ממליץ יוצרים טריגר מלא; סיומת עם שם הממליץ.

זיהוי הטריגר הוא exact match. שינוי מילה/סימן = לא מזוהה.

## משתני סביבה עיקריים

| משתנה | תפקיד |
| --- | --- |
| `PORT` | ברירת מחדל 3001 |
| `WHATSAPP_PROVIDER` | ראו טבלת ספקים |
| `DATABASE_URL` | Postgres |
| `OWNER_ACCESS_TOKEN` / `CLIENT_ACCESS_TOKEN` | סיסמאות דשבורד מנהל / לקוחה |
| `META_*` | `ACCESS_TOKEN`, `APP_SECRET`, `VERIFY_TOKEN`, `PHONE_NUMBER_ID`, `DISPLAY_PHONE_NUMBER`, `GRAPH_API_VERSION`, `GATEWAY_BASE_URL` |
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

## הערות פיתוח

- לא לשלוח vCard בלי בקשה מפורשת.
- שינוי defaults ב-`src/config.ts` לא משפיע על לקוחות קיימים שההגדרות שלהם כבר שמורות ב-DB.
- לא להניח ש-Google המחובר שייך לבעל המערכת — זה החשבון שחובר בדשבורד.
- אחרי שינוי frontend: `npm run build` ובדיקה בדפדפן.
- קבצים לא מחויבים רבים בעץ העבודה (docs/scripts/.migration) שייכים לעבודות אחרות — לא לכלול אותם בקומיטים בלי בקשה.
- mocks בבדיקות מתיישנים כשה-API הפנימי משתנה — כשבדיקה "עוברת" לוודא שהיא באמת מבצעת את מה שהיא בודקת.
