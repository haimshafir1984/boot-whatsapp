# QA מסלול B — נתונים ומסד — תוצאות

תאריך הרצה: 2026-09-01
מבצע: סוכן בדיקה (קריאה בלבד — לא בוצעו תיקונים, לא בוצעה פריסה)

## תנאי פתיחה

| בדיקה | תוצאה |
|---|---|
| `npm run build` | עבר נקי (`tsc`, אפס שגיאות) |
| קומיט נבדק | `8fff225` — "Record what the concurrency fix leaves behind" (ענף `master`) |
| 5 הקומיטים מ-01/09 שצוינו | קיימים בהיסטוריה: `1b469c1`, `5e5db25`, `46e40db`, `53e3254`, `7344c9b` |
| מסד בדיקה מקומי | `postgres://…@localhost:5432/flowsbiz_test` — זמין, שם כולל `test`, שימש לבדיקות הרסניות בלבד |

עץ העבודה מכיל שינויים לא מקומיטים ב-`META_API_SETUP.md`, `docs/ZOMEE_SERVICE_BOT_SETUP.md`,
`docs/service-bot-implementation-plan.md` וקבצים לא-במעקב — לא נגעתי בהם.

### כלי ראיה

הרצתי שלושה probes (מחוץ לחבילת הבדיקות, נמחקו אחרי ההרצה). כולם מול mock pool או קבצים
זמניים או מסד ה-`test` המקומי. הפלטים משובצים בממצאים למטה.

---

## סיכום ממצאים

| # | חומרה | תחום | כותרת |
|---|---|---|---|
| B1-1 | חשוב (סמוי) | B1 | רשת הביטחון של `syncRowsDeltaTracked` לא תופסת שינוי תוכן בשורה לא-מתויגת ששומרת על מספר השורות |
| B2-1 | חשוב | B2 | `BEGIN`/`COMMIT`/`ROLLBACK` מונפקים דרך `pool.query()` ולא דרך client נעול — הטרנזקציה פיקטיבית |
| B2-2 | שיפור | B2 | טבלת `scheduled_jobs` מחווטת לגמרי אבל אף אחד לא כותב אליה — סכימה מתה |
| B2-3 | שיפור | B2 | מיגרציה שנופלת באמצע יכולה להשאיר חלק מה-DDL מקומיט (נובע מ-B2-1) |
| B3-1 | חשוב | B3 | `outbox_messages` לא מנוקה לעולם — `sent`/`failed` נצברים לכל חיי הפריסה |
| B3-2 | חשוב | B3 | `campaign_events` גדל ב-~פי-6 ממספר המשתתפים, מתנקה רק ב-reset/delete |
| B3-3 | חשוב | B3 | `contact_queue` — משימות `saved`/`failed` לא נמחקות לעולם |
| B3-4 | חשוב (ידוע — אומת) | B3 | `MetaGatewayInbox.pruneCompleted` לא מנקה `failed` לעולם |
| B3-5 | שיפור | B3 | `campaign_results` — שורה למשתתף, לצמיתות בין קמפיינים |
| B4-1 | חשוב | B4 | `conversation-state.json` נכתב לא-אטומית, בלי `.bak` — קריסה באמצע כתיבה = אובדן כל השיחות הממתינות |
| B4-2 | חשוב (ידוע — אומת) | B4 | כתיבת `conversation-state.json` היא O(n) סינכרונית בכל שינוי, וגם במצב Postgres |
| B4-3 | שיפור | B4 | `meta-*-inbox.json` עמידים לקריסה, אבל אין נעילה מול ריצה רב-תהליכית |

מה שנבדק ונמצא **תקין**: התאמת עמודות `tableColumns()` מול בוני הפרמטרים; יעד ה-`on conflict`
של dedupe מול האינדקס; קיום אינדקסים על `conversation_state.jid`, `outbox_messages.id`,
`idempotency_key`, dedupe של `campaign_events`; אטומיות של `writeSnapshotDelta` פר-flush;
parity של round-trip טעינה-מחדש במסלול הרגיל (ראה B1 למטה).

---

## B1 — התאמה בין זיכרון למסד

### מה נבדק
`writeSnapshotDelta` כותב דלתא. בניתי תרחיש: סדרת שינויים דרך `Storage` האמיתי מול backend
Postgres מקומי → `flush()` → `createPostgresBackend` חדש → `loadSnapshot()` → השוואת ספירות.
בנוסף בחנתי את מסלול המהירות ברמת-שורה (`syncRowsDeltaTracked`, `syncConversationStateDelta`).

### B1-1 — רשת הביטחון לא תופסת שינוי-תוכן לא-מתויג ששומר על ספירת השורות · חומרה: חשוב (סמוי)

**איפה:** `src/database.ts:717-750` (`syncRowsDeltaTracked`), הרשת ב-`:730-732`;
אותו דפוס ב-`src/database.ts:864-876` (`syncConversationStateDelta`).

**מה:** כש-`touchedIds` הוא קבוצה קונקרטית, הפונקציה משווה **רק** את השורות שברשימה.
הבדיקה היחידה על שאר הטבלה היא השוואת **מספר** השורות הלא-נגועות
(`untouchedPreviousCount !== untouchedNextCount`). לכן שינוי **תוכן** בשורה לא-מתויגת
שלא משנה את מספר השורות — לא נתפס, והשורה לא נכתבת ל-DB. ה-DB מתפצל מהזיכרון בשקט.

ה-docstring ב-`:713-716` וב-`:750` טוען שהבדיקה תופסת "any untouched row's content differs
for a reason we don't know about" — הטענה שגויה עבור שינוי ששומר על הספירה.

**ראיה** (probe 1, mock pool):
```
PROBE 1: upserted rows = ["r1"]
PROBE 1: r2 changed in memory (pending -> saved) but was NOT written to DB => SILENTLY DROPPED (divergence)
PROBE 1b: conversation upserts = ["j1"] (j2 step-9 change dropped if only [j1])
```
התרחיש: `previous=[r1:pending, r2:pending]`, בזיכרון שניהם עברו ל-`saved`, אבל הקריאה
תייגה רק `['r1']`. הספירה של הלא-נגועות זהה (1=1), אז אין fallback, ו-`r2` לא נכתב.

**סטטוס טריגר:** עברתי על כל קוראי ה-`persist()` שנוגעים בטבלאות ב-`ROW_TRACKED_TABLES`
(`markContactSaved`, `enqueueContactSave`, `markContactSaveFailed`, `retryFailedContactSaves`,
`ensureCampaignResultReferralCode`, `recordCampaignEvent`, כל ה-mutators של `conversationState`).
כולם מעבירים כרגע את הסט המלא של המזהים שנגעו בהם, או משמיטים אותו לגמרי (→ `'all'` → סריקה מלאה).
לכן זה **סמוי** — אין באג פעיל בעץ הנוכחי, אבל כל קריאת `persist()` עתידית שתתייג תת-קבוצה
תיצור פיצול שקט. זו גם נקודת השבירה של A3 ("עקביות מעקב השורות").

**תיקון מוצע (סיכון נמוך):** להוסיף לרשת הביטחון בדיקת-תוכן זולה על החלק הלא-נגוע —
למשל checksum מצטבר (`JSON.stringify` של השורות הלא-מתויגות, או hash של כל שדה `updated_at`)
והשוואתו בין `previous` ל-`next`; חוסר התאמה → `fullSync()`. עלות: O(n) על שדה קטן אחד לשורה
במקום O(n) על השוואת עומק — עדיין הרבה פחות מהמצב שלפני האופטימיזציה. חלופה: תמיד `fullSync`
כשאורך הטבלה מתחת לסף (למשל < 200 שורות). לתקן במקביל את ה-docstring.

### B1-2 — מסלול ה-round-trip הרגיל תקין · חומרה: (חיובי)

**ראיה** (probe 3, מסד `test` מקומי, קמפיין של 4,000 משתתפים × 6 שלבים):
```
B3 row counts (all never-pruned): {"campaignResults":4000,"campaignEvents":24000,"outboxMessages":4000}
B3 reload parity: {"campaignResults":true,"campaignEvents":true,"outboxMessages":true}
```
`scripts/test-postgres-delta.js` ו-`scripts/test-postgres-dirty-tables.js` עוברים על הקומיט הנבדק.
`writeSnapshotDelta` עוטף כל flush ב-`begin`/`commit` יחיד (`src/database.ts:591-656`), כך
שקריסה באמצע flush (אין מטפל SIGTERM) מגלגלת אחורה נקי — אין כתיבה חלקית ל-Postgres.
הפיצול היחיד שמצאתי הוא הסמוי שב-B1-1.

---

## B2 — שלמות סכימה

### B2-1 — טרנזקציה דרך `pool.query()` במקום client נעול · חומרה: חשוב

**איפה:**
- `src/database.ts:405-420` — `applyMigrations` (`pool.query('begin')` … `pool.query(migration.sql)` … `pool.query('commit')`/`'rollback'`)
- `src/database.ts:536-573` — `writeSnapshot` (import/rollback מלא)
- `src/database.ts:579-661` — `writeSnapshotDelta` (הנתיב החם)
- לשם השוואה: `src/database.ts:488-501` — `loadRuntimeSnapshot` **כן** עושה זאת נכון עם `pool.connect()` + `client.query`.

**מה:** `pg` מבודד טרנזקציה ל-client בודד. קריאה ל-`pool.query('begin')` לוקחת חיבור
כלשהו מה-pool, מריצה `BEGIN`, ומחזירה אותו. הקריאה הבאה `pool.query(sql)` עלולה לקבל חיבור
**אחר** — אז ה-`BEGIN` "פתוח" על חיבור אחד וה-DDL/הכתיבות רצות על חיבור אחר בלי טרנזקציה,
כלומר כל statement autocommit. `ROLLBACK` שמגיע לחיבור בלי טרנזקציה פתוחה הוא no-op שקט.

**ראיה** (probe 2, מסד `test` מקומי, `new Pool` עם ברירות מחדל של הספרייה):
```
B2 probe A: sequential pool.query() backend PIDs = [ 26792, 26792 ] (same conn here — pinning is incidental, not guaranteed)
B2 probe B: migration failed as expected: duplicate key value violates unique constraint "qa_txn_probe_pkey"
B2 probe C: after failed+"rolled back" migration, qa_txn_probe table still present => no (rollback held)
```
כרגע זה **מחזיק במקרה**: בעליית המערכת ובזמן ריצה השימוש ב-pool מסודר טורית על חיבור idle
בודד (אותו PID, ה-rollback החזיק). זה נשבר ברגע ששאילתה שנייה משתלבת על אותו pool בזמן
מיגרציה/כתיבה — למשל אם יתווסף צרכן pg שני, אם `pool` יעלה למקביליות, או אם תרוץ
`migrateDatabase` בזמן שה-app חי. אז DDL של מיגרציה שנופלת באמצע (ראה B2-3) יכול להתקומיט חלקית.

**תיקון מוצע (סיכון נמוך, מכני):**
```ts
const client = await pool.connect();
try {
  await client.query('begin');
  // … כל ה-statements דרך client.query …
  await client.query('commit');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  client.release();
}
```
זהה למה ש-`loadRuntimeSnapshot` כבר עושה.

### B2-2 — טבלת `scheduled_jobs` מתה · חומרה: שיפור

**איפה:** מוגדרת ב-`src/database.ts:186-197` (מיגרציה 002), מסונכרנת ב-`:641-643`, נטענת
ב-`:446` + `:479`, נחשפת ב-`src/storage.ts:1099-1104` (`getDurableTimerHealth`).
`grep -rn "scheduledJobs|ScheduledJob|scheduled_jobs" src/*.ts` מחוץ ל-`storage.ts`/`database.ts` → **אפס תוצאות**.

**מה:** אין שום יצרן שכותב שורת `scheduledJobs`. `getDurableTimerHealth().jobs` תמיד 0.
כל התשתית (טבלה, אינדקסים `idx_scheduled_jobs_status_run_at`, sync, load) קיימת ללא שימוש.

**ראיה:** grep לעיל + קריאה של כל 15 קוראי `this.persist([...])` ב-`storage.ts` — אף אחד לא מזכיר `scheduledJobs`.

**תיקון מוצע:** או להסיר את הטבלה/השדה/`getDurableTimerHealth` (מיגרציה חדשה, לא לגעת ב-002),
או לחווט אליהם את פיצ'ר הטיימרים העמידים שהם נועדו לו. הערכת סיכון: הסרה בטוחה — אין תלות קוד.

### B2-3 — מיגרציה שנופלת באמצע · חומרה: שיפור

**איפה:** `src/database.ts:405-420`.

**מה:** כל מיגרציה בנויה מ-`create table if not exists` / `create index if not exists` /
`alter table … add column if not exists`, ומוגנת בשורת `schema_migrations`. הרצה חוזרת בטוחה
כשלעצמה. אבל בגלל B2-1, מיגרציה בעלת כמה statements שנופלת באמצע (המועמד היחיד שאינו
אידמפוטנטי-לחלוטין: `create unique index if not exists idx_campaign_events_dedupe` — ייכשל אם
כבר קיימות שורות כפולות) עלולה להשאיר את ה-statements הקודמים מקומיטים בזמן ש-`schema_migrations`
לא עודכן, כך שהאתחול הבא מריץ שוב את כל הבלוק. ברוב המקרים זה נרפא לבד דרך `if not exists`.

**ראיה:** probe 2 probe C מראה שכרגע הגלגול-אחור מחזיק (חיבור בודד); התרחיש למעלה הוא מה
שקורה כשהתנאי של B2-1 נשבר.

**תיקון מוצע:** נגזר מ-B2-1 — עם client נעול, מיגרציה שנופלת מתגלגלת אחורה כמקשה אחת.

### B2-4 — עקביות עמודות/אינדקסים · חומרה: (תקין)

בדקתי `tableColumns()` (`src/database.ts:920-933`) מול בוני הפרמטרים
(`outboxMessageParams`, `campaignResultParams`, `contactQueueParams`, `contactsListParams`,
`upsertConversationState`): סדר ומספר העמודות תואמים בכל אחת. יעד ה-`on conflict` של
`campaign_events` (`:820-828`) תואם ל-`idx_campaign_events_dedupe` (`:114`). קיימים אינדקסים
ל-`conversation_state.jid` (pk) + `sender_phone`/`campaign_id`/`scheduled_at`,
`outbox_messages.id` (pk) + `idempotency_key` + `status` + `recipient` + `next_attempt_at`.
אין ממצא חוסר-אינדקס.

---

## B3 — גידול בלתי מוגבל

מדד ייחוס (probe 3, מסד `test`, קמפיין יחיד 4,000 משתתפים × 6 שלבים):
```
B3 build: 4000 participants x 6 steps in 7799 ms
B3 row counts (all never-pruned): {"campaignResults":4000,"campaignEvents":24000,"outboxMessages":4000}
B3 scan: getCampaignResultSummary()  ->  9.83 ms
B3 scan: getCampaignEvents(campaignId) -> 42.00 ms (24000 events)
B3 scan: getPendingOutboxMessages()  ->  6.00 ms (50 due)
B3 scan: getOutboxHealth()           ->  0.50 ms
```

### B3-1 — `outbox_messages` לא מנוקה לעולם · חומרה: חשוב

**איפה:** `src/storage.ts` — אין שום `this.data.outboxMessages = …filter` / `.splice` /
מחיקה. `syncRowsDelta` (`src/database.ts:805-809`) מוחק רק שורות שכבר נעלמו מהמערך שבזיכרון,
וזה לא קורה אף פעם. `grep -rn "outboxMessages.filter\|outboxMessages.splice\|outboxMessages = "
src/*.ts` → אפס.

**מה:** כל הודעה שאי-פעם נשלחה (`sent`) או נכשלה סופית (`failed`) נשארת במערך ובטבלה לכל חיי
הפריסה. `getPendingOutboxMessages` (`src/storage.ts:998-1015`) עושה `slice().sort()` על **כל**
המערך בכל tick של ה-dispatcher (`src/outboxDispatcher.ts`, interval). `readRuntimeSnapshot`
טוען את כולן לזיכרון בכל restart.

**ראיה:** 4,000 שורות אחרי קמפיין אחד; 6ms סריקה. לינארי וקבוע. שנה של קמפיין שבועי ל-~1,000
נמענים × 6 שלבים ≈ רבע מיליון שורות שיושבות בזיכרון ונסרקות פר-tick.

**תיקון מוצע:** ג'וב תקופתי `delete from outbox_messages where status='sent' and updated_at < now() - interval '72 hours'`
(האינדקס `idx_outbox_messages_status` כבר קיים) + שמירת `failed` לחלון מוגבל; **וחשוב** — לספלַיס
אותן החוצה מ-`this.data.outboxMessages` כדי שהסריקות בזיכרון יתכווצו. סיכון: בינוני — צריך לוודא
שאין קורא שמצפה למצוא הודעה ישנה לפי `providerMessageId` אחרי חלון ה-retention (בדיקת delivery
receipts ב-`adminServer.ts:1524`).

### B3-2 — `campaign_events` גדל ב-~פי-6 ממספר המשתתפים · חומרה: חשוב

**איפה:** נוסף רק (`src/storage.ts:1612` push), נמחק רק ב-`resetCampaignData` (`:1645`) וב-
`deleteCampaign`. `getCampaignEvents` (`:1628-1633`) ו-`getCampaignResultSummary` (`:1691-1746`)
מסננים+ממיינים את כל המערך.

**ראיה:** 24,000 אירועים לקמפיין אחד; `getCampaignEvents(campaignId)` = 42ms. קמפיינים
היסטוריים מצטברים בלי תקרה פר-קמפיין ובלי תקרת גיל. הדשבורד קורא לזה בכל רינדור.

**תיקון מוצע:** תקרה על אירועים שמורים פר-`campaignResult` (הסיכומים משתמשים ב-`uniqueCount`
פר-`type`, אז מספיק לשמור את האחרון פר-type), או קיפול אירועים של קמפיין שהסתיים לשורת aggregate
אחת. סיכון: בינוני — לוודא שכל ספירות ה-summary עדיין נכונות אחרי הקיפול.

### B3-3 — `contact_queue` — `saved`/`failed` לא נמחקים · חומרה: חשוב

**איפה:** `grep` → הסינון היחיד של `this.data.contactQueue` הוא ב-`resetCampaignData`
(`src/storage.ts:1648`), ורק לג'ובים שקשורים ל-`campaignResultIds` של הקמפיין שאותחל.

**מה:** שורה למשתתף לכל קמפיין, לצמיתות. `getDueContactSaveJob` (`:1181-1192`) ו-
`getContactQueueStats` (`:1236-1242`) סורקים את כל המערך.

**ראיה:** אותו probe — `enqueueOutboxMessage` נקרא 4,000 פעם; `contact_queue` היה נטען ל-4,000
שורות באותה מידה אילו הקמפיין השתמש בשמירת אנשי קשר. אין נתיב מחיקה.

**תיקון מוצע:** למחוק ג'ובים `saved` אחרי חלון חסד קצר; retention מוגבל ל-`failed`.

### B3-4 — `MetaGatewayInbox` לא מנקה `failed` לעולם · חומרה: חשוב (ידוע — אומת)

**איפה:** `src/metaGatewayInbox.ts:122-130` (`pruneCompleted`).

**מה:** `const active = this.data.items.filter((item) => item.status !== 'completed')` —
`failed`, `queued`, `processing`, `retry` כולם נשמרים ללא תנאי; רק `completed` מקבל תקרה
(300 פריטים / שעתיים, `:34-35`). אין שום נתיב אחר שמנקה `failed`
(`grep -rn "markFailed\|\.items =" src/*.ts` — רק ההוספה עצמה).

**ראיה:** קריאת הקוד + ה-76 פריטי `failed` מ-27/8 שמוזכרים במסמך ה-QA עדיין רלוונטיים.
`persist()` (`:147-155`) כותב מחדש את **כל** הקובץ (`writeFileSync`+`copyFileSync`+`renameSync`)
בכל `enqueue`/`claimBatch`/`update` — כל פריט `failed` שנשמר מנפח כל כתיבה עתידית.

**תיקון מוצע:** להוסיף age-out ל-`failed` (למשל 24ש') בתוך `pruneCompleted` או בקריאה מקבילה;
הנכונות מוגנת ע"י `rememberMessage()` ב-`messageFlow.ts` כפי שמעיר הקובץ עצמו (`:31-33`).
חלופה: להעביר `failed` לקובץ נפרד מוגבל לבדיקה ידנית. סיכון: נמוך.

### B3-5 — `campaign_results` — לצמיתות בין קמפיינים · חומרה: שיפור

**איפה:** push ב-`src/storage.ts:1368`; מחיקה רק ב-`resetCampaignData`/`deleteCampaign`.

**מה:** שורה למשתתף. מוגבל פר-קמפיין אבל קבוע בין קמפיינים. מעקב רמת-השורה
(`syncCampaignResultsDelta`) שומר על ה**כתיבה** זולה, אבל `readRuntimeSnapshot` טוען כל שורה
לזיכרון בכל restart, וכמה נתיבי summary/leaderboard סורקים את כל המערך
(`generateUniqueReferralCode` ב-`:1749-1767`, `getCampaignResultBatchSummaries` ב-`:1305-1332`).

**ראיה:** 4,000 שורות/קמפיין ב-probe; `getCampaignResultSummary` = 9.83ms.

**תיקון מוצע:** אותה שאלת retention כמו B3-2; דחיפות נמוכה יותר.

### הערכת גודל ל-6 ו-12 חודשים

בהנחת קמפיין שבועי ל-~1,000 נמענים, ~6 שלבים, ללא reset:

| טבלה | ל-6 חודשים (~26 קמפיינים) | ל-12 חודשים (~52) | מה מנקה היום |
|---|---|---|---|
| `outbox_messages` | ~156k שורות | ~312k | כלום |
| `campaign_events` | ~156k–900k (תלוי בצפיפות אירועים) | ~312k–1.8M | reset/delete של קמפיין בלבד |
| `contact_queue` | ~26k | ~52k | reset בלבד, וגם אז חלקית |
| `campaign_results` | ~26k | ~52k | reset/delete בלבד |
| `meta-*-inbox.json` `failed` | מצטבר ללא הגבלה | ללא הגבלה | כלום |
| `conversation_state` | חסום ע"י שיחות פעילות + נטישות עד timeout (30ד'–24ש') | כנ"ל | remove/timeout |

כל אלה יושבים גם בזיכרון (`readRuntimeSnapshot` טוען הכל ב-restart) וגם נסרקים בנתיבים חמים.

---

## B4 — קבצי JSON

### B4-1 — `conversation-state.json` נכתב לא-אטומית ובלי גיבוי · חומרה: חשוב

**איפה:** `src/conversationState.ts:392` —
`if (this.filePath) fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), 'utf-8');`
בלי temp+rename, בלי `.bak`. השווה ל-`src/storage.ts:897-903` ול-`src/metaGatewayInbox.ts:147-155`
ששניהם עושים temp → `copyFileSync`(→`.bak`) → `renameSync`.

**מה:** קריסה/`SIGKILL` באמצע הכתיבה (אין מטפל SIGTERM — ראה למטה) משאירה קובץ קטוע.
`restore()` (`:329-355`) עושה `JSON.parse` שזורק, תופס ב-`:350`, מדפיס warning, ומחזיר 0 →
כל שיחה ממתינה אובדת ב-restart הזה, בלי `.bak` ליפול אליו.

**ראיה** (probe 1, קובץ זמני קטוע ל-60%):
```
PROBE 3: truncated file parse => throws ("Unexpected end of JSON input")
PROBE 3: .bak present for recovery => false
PROBE 3: conversationState.restore() catches this and returns 0 => all pending conversations lost on that restart
```
במצב Postgres זה ממוסך (`restore` קורא קודם מ-`backend.loadConversationStateSnapshot()`
שמגיע מטבלת `conversation_state`), אבל הכתיבה הקטועה עדיין קורית בכל פעם.

**תיקון מוצע:** לכתוב ל-`${filePath}.tmp` ואז `fs.renameSync`, ולשמור `.bak` אחד כמו שני
הכותבים האחרים; או לדלג על כתיבת הקובץ לגמרי כשיש backend Postgres. סיכון: נמוך.

### B4-2 — כתיבת `conversation-state.json` היא O(n) סינכרונית בכל שינוי, וגם ב-Postgres · חומרה: חשוב (ידוע — אומת)

**איפה:** `src/conversationState.ts:370-396` (`persist`), נקרא מכל mutator
(`set`/`remove`/`pause`/`removeByPhone`/`removeByCampaign`). `src/index.ts:55` תמיד מעביר
גם `filePath` וגם `backend`, ו-`:391-392` קוראים גם ל-`backend.saveConversationStateSnapshot`
**וגם** ל-`fs.writeFileSync` — ללא תנאי.

**מה:** `persist()` מסריאל את **כל** מפת השיחות (`JSON.stringify(snapshot, null, 2)` —
עם הזחה) וכותב סינכרונית בכל שינוי של שיחה בודדת. קומיט `46e40db` ("Track conversation_state
changes per row") אופטימז רק את נתיב הדלתא של Postgres; כתיבת הקובץ הזו לא נגעו בה והיא עדיין
O(n) חוסמת-event-loop בכל מעבר שלב.

**ראיה** (probe 1, קבצים זמניים):
```
PROBE 2:  200 conversations ->   102 KB/write,  1.68 ms/write
PROBE 2:  700 conversations ->   358 KB/write,  4.13 ms/write
PROBE 2: 1366 conversations ->   699 KB/write,  7.37 ms/write
PROBE 2: 3000 conversations ->  1537 KB/write, 15.05 ms/write
```
7.37ms ב-1366 שיחות — תואם למדידת "7.7ms ב-1366" שבמשימה. במצב Postgres זו עבודה כפולה
(גם דלתא ל-DB, גם רימוט מלא של הקובץ), וזמן ה-15ms ב-3,000 שיחות מצטבר על כל שלב של כל משתתף
בדיוק כמו שקרה באירוע 31/8.

**תיקון מוצע:** לדלג על כתיבת הקובץ כשיש backend Postgres; או debounce/הפיכה לאסינכרוני;
או לוג-append של ה-jids ששונו במקום rewrite מלא. סיכון: נמוך אם רק מדלגים במצב Postgres
(המקור-אמת שם הוא הטבלה).

### B4-3 — `meta-gateway-inbox.json` / `meta-client-inbox.json` — עמידים לקריסה, לא לריצה רב-תהליכית · חומרה: שיפור

**איפה:** `src/metaGatewayInbox.ts:132-155`.

**מה:** `persist()` עושה temp → `copyFileSync`(→`.bak`) → `renameSync`; `load()` (`:132-145`)
נופל ל-`.bak` על כשל parse. עמיד מול קריסה באמצע כתיבה של תהליך יחיד (Node חד-תהליכי,
`writeFileSync` חוסם — אין כתיבה מקבילית תוך-תהליכית). הסיכון הנותר הוא רב-תהליכי: אם הקונטיינר
יורחב אי-פעם ליותר מ-replica אחד על Volume משותף, שני תהליכים שכותבים מחדש את אותו קובץ
(וגם `contacts.json` במצב JSON) ישחיתו זה את זה — אין נעילת קובץ.

**ראיה:** קריאת הקוד; אין `flock`/lockfile בשום מקום ב-`src/`. `CLAUDE.md` מציין Volume יחיד ב-Railway.

**תיקון מוצע:** הערה ל-F3/תשתית — לוודא replica יחיד, או לעבור לנעילת advisory של Postgres
כשהוא מוגדר. לא באג קוד היום.

---

## אימות פריטים "ידועים ומתועדים" (רק אימות שעדיין נכון)

| פריט | סטטוס בקומיט `8fff225` |
|---|---|
| אין מטפל SIGTERM בשום מקום | **אומת.** `src/index.ts:23` — רק `process.on('unhandledRejection', …)`. `grep -rn "SIGTERM\|SIGINT" src/` → אפס. כל פריסה = SIGTERM באמצע כתיבות. `writeSnapshotDelta` מתגלגל אחורה נקי, אבל `conversation-state.json` (B4-1) וכל עבודת `contactQueue`/outbox באוויר לא עוברים flush. |
| `new Pool` בלי `max` / `connectionTimeoutMillis` / `idleTimeoutMillis` | **אומת, ועכשיו 5 מופעים ולא 4:** `src/database.ts:226, 233, 509, 527` + `src/adminServer.ts:3593`. אף אחד לא מעביר אופציות. |
| `pruneCompleted` לא מנקה `failed` לעולם | **אומת.** ראה B3-4. |
| `persist()` ב-`conversationState.ts` O(n) בכל שינוי, ~7.7ms ב-1366 | **אומת.** ראה B4-2 — 7.37ms ב-1366. המנגנון הוא ה-`fs.writeFileSync` המסודר-יפה שרץ ללא תנאי, גם במצב Postgres; לא טופל ע"י `46e40db`. |

---

## מה לא נבדק (מחוץ למסלול B או דורש הרצת עומס)

- מדידת חסימת event-loop מצטברת פר-שלב תחת עומס אמיתי — מסלול C.
- התנהגות `routeMetaGatewayInbound` ובידוד רב-לקוחות — A5.
- הרצת `db:migrate:force` עם snapshot והשוואת counts — נמנע לפי כלל בטיחות 3.
