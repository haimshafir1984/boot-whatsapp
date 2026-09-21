# שלב E — תוצאות C3: חיבור שני ה-Inboxes (2026-09-21)

מקומי בלבד. אין commit / push / פריסה. לא נגעתי בניתוב (`routeMetaGatewayInbound`, fail-closed), ב-`META_INBOX_MAX_ATTEMPTS` (נשאר 60), ב-Outbox מ-20–21.9, ב-`AsyncExpiringCache`. HEAD `098b94f`, עץ העבודה עם השינויים שלי בלבד; קבצים לא-קשורים (`META_API_SETUP.md`, `docs/ZOMEE_*`, `docs/service-bot-*`, `package.json`) לא נגעתי.

## 0. הודעה מפורשת לבעל המערכת — משתנה סביבה שהוגדר בקוד

**`INBOX_DATABASE_URL` מוגדר עכשיו בקוד** (`src/inbox/config.ts`). זו הוראת ההקמה לשער:

| משתנה | איפה | משמעות |
|---|---|---|
| `INBOX_BACKEND` | שער + לקוח | `json` (**ברירת מחדל — שום דבר לא משתנה בייצור עד שמפעילים במפורש**) או `postgres` |
| **`INBOX_DATABASE_URL`** | **שער (חובה כש-`INBOX_BACKEND=postgres`)**; לקוח (אופציונלי) | מחרוזת חיבור ל-PostgreSQL של ה-Inbox. לשער אין מסד אחר — **זה מה שצריך להקים**. לקוח, אם לא הוגדר, משתמש ב-`DATABASE_URL` שלו (טבלאות `inbox_*` נפרדות מה-snapshot). אין כתיבה של סיסמה ללוג |
| `INBOX_NAMESPACE` | אופציונלי | זהות בתוך מסד משותף (ברירת מחדל `gateway` / `client`) |
| `INBOX_DB_POOL_MAX` | אופציונלי | 10 |
| `INBOX_LEASE_MS` | אופציונלי | 120000 |
| `INBOX_DEDUPE_DAYS` / `INBOX_PAYLOAD_RETENTION_DAYS` | אופציונלי | 30 / 7 (D5) |
| `INBOX_SHUTDOWN_WAIT_MS` | אופציונלי | 5000 |
| `INBOX_GATEWAY_REQUIRED` | אופציונלי | `true` כופה שתהליך ייחשב שער גם בלי לקוחות מנוהלים |

התנהגות: `INBOX_BACKEND=postgres` בלי `INBOX_DATABASE_URL` בשער ⇒ **הפעלה נכשלת בקול** (`Refusing to fall back to JSON`). תהליך שאינו שער (אין לקוחות מנוהלים) ואין לו כתובת שער מקבל store שמסרב לקבלות (503) ולא דורש מסד שער. **לפיילוט בלבד:** להקים PostgreSQL לשער (שירות נפרד; גיבוי; דיסק), ולהגדיר `INBOX_BACKEND=postgres` + `INBOX_DATABASE_URL` בשירות `flowsbiz-admin-*`. עד אז ברירת המחדל JSON והמערכת ללא שינוי.

## 1. שלושת התנאים

### 1.1 `enable_seqscan=off` — **הוסר לצמיתות**
הרצתי את שערי C2 **בלי** האופציה (`docs/results-data/e-c2-sql-noseqscanoverride-2026-09-21.json`): **PASS בכל השערים** — זמן p95 ב-(50k,5k) מול (300,0): enqueue 0.72, claim 0.70, retry 0.70, complete 0.81; WAL ×1.07; שורות שנסרקו per-message ≤ 5 (claim / tick ריק: **0**); אינווריאנטות 0. בדיקת ה-repository 21/21 אחרי ההסרה. הקוד ב-`createInboxPool` כבר לא כולל override.
**גילוי נאות:** בריצה 3 (ללא override) תא אחד (H=300, B=0) בחר `Seq Scan` על טבלת שולחים זעירה (2,733 שורות, 0.23ms). זה שריד של סטטיסטיקה ישנה אחרי זריעה גורפת. **6 ריצות חוזרות** של התאים הקטנים (`e-c2-planrepeat-noseqscanoverride-*.json`) ו-2 המטריצות המלאות אחר כך בחרו `Index Scan idx_inbox_senders_due` תמיד. בשער C6 ה-plans ירוצו שוב (§ ב-`stage-e-c6-comparison-plan`).

### 1.2 ראיות לריפו
כל קבצי המדידה של C1 ו-C2 (כולל ריצות 1–3, הלוג הגולמי של C1, ריצת smoke) ב-`docs/results-data/` עם `SHA256SUMS-stage-e.txt`. **מעכשיו כל סקריפט מדידה כותב לשם כברירת מחדל** (`--out` ברירת מחדל = `docs/results-data/...`).

### 1.3 תהליכי node תקועים — **לא נהרגו; המקור אינו הריפו הזה**
מצאתי 91 תהליכי node (4.8GB): **44 × Codex `cua_node` (`server.mjs` + ילדים), 44 × `npx @modelcontextprotocol/server-puppeteer`**, ועוד 3 של פרויקט `hadas site` (Next dev פעיל, 802MB — לא שלי). **אפס** מהם מריצות של הריפו `parpar sagol` (בדקתי שורת פקודה של כל אחד). לכולם הורה חי: **22 תהליכי `codex.exe`** + עטיפות `cmd.exe`; הוותיקים מ-20.9 08:50. כלומר כל סשן Codex מרים זוג (runtime + puppeteer MCP) ולא סוגר אותו כשהוא נגמר. **לא הרגתי אותם:** הם ילדים של סשני Codex חיים; הריגתם עלולה לשבור סשן אחר שלך. זיכרון: 4.8GB מתוך 30GB, ~0 CPU — לא משפיע על מדידה, אבל נרשם בכל מדידה.
- **פעולה שמאפשרת לך לנקות:** לסגור סשני Codex ישנים, או להריץ `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server-puppeteer|cua_node' }` ולהרוג לפי `ParentProcessId` של סשן שהסתיים — אני לא עושה זאת בלי אישורך.
- **מה כן נוסף:** `scripts/measure-preflight.js` נקרא בתחילת שני סקריפטי המדידה: **נכשל (exit 3) אם נותר תהליך node של הריפו**, ורושם בפלט זיכרון פנוי ומספר/MB של תהליכי node אחרים.
- **`test-referral-ranking`:** הרצתי אותו לבד — **יוצא אחרי 0.57s** (שורת הניקוי שהוספתי בו הייתה ב-commit `454da66`). לא שוחזר תלוי. הרגרסיה המלאה רצה עם timeout לכל בדיקה, ואחריה `measure-preflight` לא מצא אף תהליך של הריפו. אם ראית "passed" בלי יציאה — זה לא הופיע כאן; אשמח לשמע באיזו פקודה כדי לשחזר.

### 1.4 שתי המגבלות
נרשמו והוטמעו ב-`docs/stage-e-c6-comparison-plan-2026-09-21.md`: (1) ציר ה-backlog — **אין טענת שיפור בזמן**; ההכרעה נשענת על ציר ההיסטוריה; (2) **"50,000 מול 50,000" אינו בר-השוואה** (בסיס: `failed/held` בלבד, חדש: 40,000 `completed`), עם הגדרה מפורשת של על מה משווים (A/B/C) ומה מותר לטעון.

## 2. C3 — מה נבנה

| דרישה | מימוש | בדיקה | תוצאה |
|---|---|---|---|
| חוזה אסינכרוני אחד לשני ה-Inboxes | `src/inbox/store.ts`: `InboxStore` + `PostgresInboxStore` + `JsonInboxStore` (מחלקת ה-legacy מאחורי אותו ממשק) + `DisabledInboxStore`; `createSenderDrainer` מקבל `claim` אסינכרוני | חוזה משותף על **שניהם** (Part A) | ✅ |
| שני ה-drainers ממתינים לשמירה מתמשכת | `adminServer.ts`: כל `claim/complete/retry/hold/fail/review` מחכה ל-commit; lease מתחדש (שליש lease) בזמן ש-handler רץ | runtime B (drainers רצים על PG אמיתי) | ✅ |
| **אין ACK לפני commit** | webhook: `await enqueueMany` (טרנזקציה אחת לכל ההודעות) ורק אז `200`; קבלת לקוח: `202` רק אחרי commit; כשל ⇒ `503` | B receipt (השורה קיימת כשחוזר 200/202; כפילות ⇒ שורה אחת); **W1/W2** | ✅ |
| **כשל SQL אינו רשות ליפול ל-JSON** | `inboxReady` נכשל ⇒ 503 + alert, אף קובץ לא נוצר; `INBOX_BACKEND=postgres` בלי כתובת ⇒ הפעלה נכשלת; כשל כתיבת תוצאה ⇒ הפריט נשאר במקומו (לא רץ שוב) + alert | B "PostgreSQL unreachable" + "no JSON files" + config | ✅ |
| מסלולי HTTP, פעולות מנהל, כיבוי | `/internal/meta/whatsapp`, `/webhooks/meta/whatsapp`, `meta-clear-pending` (cancel), `POST /api/needs-review/:jid/resolve` (+`reviewItemsAction`, `acknowledgeDuplicateRisk`), נתיבי delivery-recovery (release/superseded) — כולם אסינכרוניים; כיבוי: `getAdminInboxWorker()` בשרשרת `shutdown.ts` (עוצר claim → ממתין ל-claims ול-handlers בטיסה → סוגר pools) | B shutdown + **race** דטרמיניסטי (claim איטי בטיסה בעת `stop()`); **W6** | ✅ |
| שימור held/replay/ביטול, כולל הודעות הבאות כ-held | `held` אינו חוסם את השולח; ההודעה הבאה נתפסת ונלכדת כ-held (`SenderHeldForReviewError`); requeue **מאחורי** עבודה פעילה; cancel כולל `processing` | Part A (שני ה-stores) + B held (h1, h2 שניהם `held`) + C2 | ✅ |
| תוצאת stale מפורשת | `src/inboundOutcome.ts` (AsyncLocalStorage) + שורת דיווח אחת ב-`messageFlow.ts:1643`; ה-drainer: `stale_trigger` ⇒ `review` (payload נשמר, alert), **לא** `completed`, לא retry; מדיניות התפוגה וה-timestamp המקורי לא שונו; הקמפיין **לא** רץ | B: פריט בן 11 דק' ⇒ `review/stale_trigger`, 0 תוצאות קמפיין; **W3** | ✅ |
| D1/D2: פריט עמום ⇒ `review`, לא ריצה חוזרת, השולח ב-`needs_review` | repository (C2) + `holdSenderForAmbiguousInbox` (`messageFlow.ts`) + alert `inbox-ambiguous-<id>` | B AMBIGUOUS: worker "מת" אחרי **אפקט עסקי** (`recordCampaignTrigger`) ⇒ הפריט `review(ambiguous_processing)`, ה-handler לא רץ, **תוצאת קמפיין אחת בלבד**, השולח `needs_review` (`source=inbox`); **W4** | ✅ |
| מדדים/התראות | health: `metaGatewayInbox`, `metaClientInbox`, `inboxOldestDueAgeMs` (טיימר 5s, לא שאילתה בכל בקשה); אזהרה ב-30s, התראה קריטית ב-120s; `inbox-db-unavailable`, `inbox-store-failed`, `inbox-stale-trigger` | קוד; **[לא נבדק]** משלוח מייל התראה בפועל | ⚠ חלקי |
| ניקוי | `cleanup()` (dedupe/payload) בטיימר 10 דק' בקבוצות מוגבלות | C2 (`cleanup`) — הטיימר עצמו לא נבדק בנפרד | ⚠ חלקי |

**מוטציות (`MUT_SET=c3`): 6/6 נתפסו**, שחזור SHA מאומת (`mutation-inbox-c3-2026-09-21.json`): W1/W2 (ACK לפני commit — שער / לקוח), W3 (stale נרשם completed), W4 (עמום בלי hold), W5 (held נרשם completed), W6 (כיבוי מתעלם מ-claim בטיסה). W6 ניצל בהתחלה מבדיקה הסתברותית — הוקשחה לבדיקה דטרמיניסטית.
**באג אמיתי שנמצא בדרך:** `stop()` סגר את ה-pools כש-`claim` היה עדיין בטיסה, וה-item שחזר אחר כך הורץ מול pool סגור (`INBOX_STORE_FAILED`). תוקן ב-`pendingInboxClaims`.
**JSON כברירת מחדל:** כל בדיקות ה-inbox/ניתוב/עומס הקיימות רצות על ה-adapter של JSON — ראה רגרסיה מטה.

## 3. החלטות ושינויי התנהגות שכדאי שתראה
1. **ה-store של JSON שומר `review` כ-`failed` עם סיבה** (`[REVIEW:stale_trigger] ...`) — לקובץ הישן אין מצב review; לא נרשם כ-completed לעולם. (מצב JSON הוא legacy.)
2. **התנהגות ה-reclaim ב-JSON לא שונתה** (ריצה חוזרת לאחר 2 דק'), כלומר נתיב השליחה הכפולה נשאר בייצור **עד המעבר ל-PostgreSQL**. במעבר: לקוח ⇒ `review`.
3. **תהליך שאינו שער** ב-PG מקבל `DisabledInboxStore` (מסרב, לא מאשר, לא זורק); שער נקבע לפי קיום לקוחות מנוהלים או `INBOX_GATEWAY_REQUIRED=true`.
4. `resolve` של המנהל: אם הסרת ה-hold הצליחה אך עדכון ה-inbox נכשל ⇒ 503 עם הסבר (ה-hold כבר הוסר — הפריטים נשארים held).
5. **לא נוסף** endpoint GET לרשימת פריטי review (הרפוזיטורי כולל `listReview`); נדרש לפני פיילוט.

## 4. רגרסיה
**71 סוויטות: 70 עברו, 0 נכשלו, 1 BLOCKED** (`test-backup-tool.js` — דורש `BACKUP_TEST_PG_URL`, כמו קודם; לא קשור). כל בדיקות ה-inbox/ניתוב/עומס הקיימות עברו על ה-adapter של JSON (ברירת המחדל). נתונים: `docs/results-data/regression-e-c3-2026-09-21.json`. אחרי הריצה `measure-preflight`: 0 תהליכי node של הריפו.

## 5. הוכח / הונח / לא נעשה
**הוכח (PG אמיתי, שרת אמיתי):** ה-ACK אחרי commit בשני הנתיבים; אי-נפילה ל-JSON; stale ל-review; held (כולל ההודעה הבאה); עמום ⇒ לא רץ שוב + hold; כיבוי כולל race דטרמיניסטי; חוזה זהה על JSON ו-PG; 15/15 בדיקות runtime + 6/6 מוטציות; שערי C2 בלי override.
**הונח:** ש-handler בפועל שמקבל SIGKILL נראה כמו "worker שמת" (נבדק בסימולציה של lease שפג, לא ב-kill אמיתי — C6); שהחזרה על handover בשער בטוחה (C6).
**לא נעשה:** GET review endpoint; מיגרציה מ-JSON (C5); conversationState (C4); משלוח התראות בפועל; מדידת D1 (C6); שער בתהליך נפרד מול לקוחות אמיתיים (C6); reconciler כלולאה רצה.

**עצור כאן. C4–C6 דורשים אישור.**
