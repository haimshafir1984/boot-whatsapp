# שלב E — תכנון (C0): Inbox עמיד + שבירת לולאת ההצטברות

תאריך: 2026-09-21. HEAD שנבדק: `098b94f19aadec4545232c71cbefd09762a906b9`. עץ העבודה: 4 קבצים לא-קשורים ששונו (`META_API_SETUP.md`, `docs/ZOMEE_*`, `docs/service-bot-*`, `package.json`) — לא נגעתי בהם.
מקור מחייב: `docs/stage-e-independent-review-and-plan-2026-09-21.md` (Codex; גובר בסתירה). רקע: `docs/stability-plan-2026-09-01.md`, `docs/stage-e-inbox-durability-brief-2026-09-21.md`.
**מסמך תכנון בלבד. לא נכתב קוד מימוש. לא בוצע commit / push / פריסה.** נוספו רק: שני סקריפטי מדידה (`scripts/measure-convstate-hotpath.js`, `scripts/measure-convstate-drain.js`), נתוני מדידה תחת `docs/results-data/`, ומסמך זה.

מוסכמה: **[הוכח]** = נמדד/נקרא בקוד ב-HEAD. **[הנחה]** = מסקנה שלא נבדקה בהרצה. **[לא נבדק]** = במפורש.

---

## 0. תקציר החלטות שמחכות לך (ראה §9)

| # | החלטה | ההמלצה שלי |
|---|---|---|
| D1 | `processing` שפג lease בלקוח (crash אחרי שייתכן שבוצעה פעולה) — ריצה חוזרת אוטומטית, או בדיקה ידנית? | **בדיקה ידנית כברירת מחדל** (`review`). הוכחת-בטיחות אוטומטית (P1) רק אחרי שמדדנו ב-C6 כמה פריטים כאלה נוצרים ב-restart |
| D2 | האם פריט `review` (עמום) גם מציב את השולח ב-`needs_review` הקיים? | כן, בלקוח — כדי שהודעות הבאות יילכדו כ-held ולא ירוצו על מצב לא ידוע |
| D3 | מסד בדיקות ייעודי: ליצור `flowsbiz_inbox_test` על 5433 (אם יש הרשאה), אחרת סכמה ייעודית ב-`flowsbiz_test_18` | ליצור מסד ייעודי |
| D4 | PostgreSQL לשער בייצור (היום אין לו) — מי מקים ואיפה | החלטה תשתיתית; חוסמת פיילוט, לא חוסמת C0–C6 |
| D5 | ברירות מחדל: חלון dedupe 30 יום, ניקוי payload של `completed` אחרי 7 ימים | לאשר |
| D6 | Replay/requeue מחדש-מסדר את הפריט **מאחורי** עבודה פעילה (מונע overtaking) — שינוי מכוון מההתנהגות הנוכחית (שם הוא חוזר לפי createdAt וקופץ לפני חדשים) | לאשר |
| D7 | להסיר את קובץ ה-shadow של conversationState ומסלול ה-snapshot המלא **במצב PostgreSQL בלבד** (JSON נשאר כמו שהוא) — בכפוף להוכחות ב-C4 | לאשר את הכיוון; ההכרעה הסופית ב-C4 אחרי שההוכחות עברו |

---

## 1. ממצאים שנבדקו מול הקוד (אישור / תיקון / תוספת)

### 1.1 מאושר
- **כתיבה מלאה סינכרונית:** `MetaGatewayInbox.persistData` (`src/metaGatewayInbox.ts:245`) = `writeFileSync(tmp)` + `copyFileSync(bak)` + `renameSync`, על כל `enqueue` / `claimBatch` / `update`. שני ה-Inboxes (`adminServer.ts:1277-1278`) הם אותה מחלקה על קובצי JSON, בלי קשר ל-backend הראשי.
- **קריאה לינארית:** `claimBatch` = `slice().sort()` על כל הפריטים + מעבר על כולם; `enqueue` = `find` + `pruneCompletedItems` (filter+sort) + העתקת המערך; `update` = `find` + `map` על הכול; `counts()`, `cancelPendingForPhone`, `resolveHeldForSender` = מעבר מלא. **הבעיה אינה רק הכתיבה** — גם הקריאה. העברת אותו מסמך ל-DB לא תועיל.
- **שימור לא-completed:** `pruneCompletedItems` נוגע רק ב-`completed` (עד 300 / 2 שעות). `failed` / `held` / `retry` / `processing` אינם נגזמים. **[הוכח בקוד]**.
- **הלולאה:** כל retry = `update()` = כתיבת קובץ מלא; עם 60 ניסיונות לפריט — כל retry משלם על כל הקובץ.
- **stale נספר כ-completed:** `messageFlow.ts:1643` — `stale trigger ignored` הוא `return` שקט; `adminServer.ts:2189` קורא `markCompleted` אחרי חזרה מהמטפל. **[הוכח בקוד]**.
- **מסלול conversationState לא נסגר:** ראה §5.

### 1.2 תוספות שלא היו במסמכי הבסיס
- **F1 — עלות שנייה, שווה בגודלה, שלא נזכרה:** `cloneSnapshotForTables` (`database.ts:~535`) מכיל טיפול מיוחד ב-4 טבלאות row-tracked; `conversationStateSnapshot` **אינו ברשימה**, ולכן בכל drain-cycle הוא נעתק **במלואו** (`JSON.parse(JSON.stringify(...))` + `sanitizeJsonForPostgres`) — סינכרונית על ה-event loop, מעל ה-deep-clone של `Storage.saveConversationStateSnapshot` ומעל כתיבת הקובץ. נמדד ב-§5.2.
- **F2 — reclaim של `processing` מריץ מחדש בשקט.** `isClaimable` מחזיר `true` ל-`processing` ישן (2 דקות) → הפריט רץ שוב, כולל **פעולות קמפיין אמיתיות בלקוח**. אין שום דבר שמונע שליחה כפולה. זה בדיוק הפער שדרשת לבדוק. **[הוכח בקוד]**; יישום מחדש דורש החלטה (D1).
- **F3 — זהות הפריט = `wamid` בלבד**, לא מקוננת ב-`phone_number_id`. המפרט דורש `role + phoneNumberId + messageId`. בפריטים קיימים ה-`phone_number_id` נשלף מה-payload (`entry[0].changes[0].value.metadata`); חסר → נדווח בדוח ה-dry-run, לא נמציא.
- **F4 — הסדר היום = `createdAt` (מחרוזת ISO ברזולוציית ms) + יציבות ה-sort.** שתי הודעות באותו ms נשענות על סדר הכנסה. במבנה החדש הסדר = `sender_seq` מונוטוני מוקצה תחת נעילת שורת השולח (§3).
- **F5 — `handledMessageIds` (1000, בזיכרון) ו-`inFlightMessages` ב-`messageFlow.ts`** הם שכבת הדדופ היחידה אחרי ש-completed נגזם; אחרי restart היא ריקה. המבנה החדש נותן dedupe עמיד (זהות נשמרת 30 יום).
- **F6 — `cancelPendingForPhone` (רק בלקוח) ו-`resolveHeldForSender` מתאימים לפי `from` בלבד, בלי יעד.** נשמר: `sender_phone` נפרד + אינדקס.

### 1.3 תיקון לניתוח הגורמים
הגורמים 3–4 (event loop חסום ע"י הקובץ; לולאת הצטברות) **מאושרים כמנגנון** — אבל הקישור ל-`CLIENT_SKIPPED` הוא [הנחה] עד C1/C6 (Codex סעיף 4: TimeoutError לבדו לא מזהה מי האשם). C1 בנוי כך שיבדוק את המנגנון (סריקה+כתיבה) בנפרד מהטענה על ה-timeout, ו-C6 ימדוד lag של השער בתהליך נפרד.

---

## 2. סכימה מלאה (א)

עיקרון: **טבלאות ה-Inbox נמצאות במסלול מיגרציה משלהן** (`inbox_schema_migrations`), אינן חלק מ-`StorageData`, ו-`writeSnapshotDelta` / import / export לא מכירים אותן ולכן לא יכולים למחוק אותן. השער: מחבר ייעודי (`INBOX_DATABASE_URL`). לקוח: אותו מסד של הלקוח, טבלאות `inbox_*` נפרדות (הרכב הטבלאות של ה-snapshot אינו משתנה). אין fallback ל-JSON בכשל SQL.

### 2.1 DDL

```sql
create table inbox_schema_migrations (id text primary key, applied_at timestamptz not null default now());

-- One row per sender (namespace + role + sender_key). This is the SCHEDULER row (see section 3).
create table inbox_senders (
  namespace     text   not null,                   -- storage identity: 'gateway' or the client id
  role          text   not null check (role in ('gateway','client')),
  sender_key    text   not null,                   -- `${phone_number_id}:${from}` == metaPayloadSenderKey()
  sender_phone  text   not null,                   -- digits of `from` (admin resolve / cancel match on this)
  next_seq      bigint not null default 1,         -- next sender_seq to hand out; allocated under THIS row's lock
  head_id       bigint,                            -- inbox_items.id of the first OUTSTANDING item; NULL = none
  head_status   text check (head_status in ('queued','retry','processing')),
  due_at        timestamptz,                       -- when the head next needs a worker (invariant I3)
  updated_at    timestamptz not null default clock_timestamp(),
  primary key (namespace, role, sender_key)
);
create index idx_inbox_senders_due   on inbox_senders (namespace, role, due_at) where head_id is not null;
create index idx_inbox_senders_phone on inbox_senders (namespace, role, sender_phone);

create table inbox_items (
  id               bigint generated always as identity primary key,
  namespace        text   not null,
  role             text   not null check (role in ('gateway','client')),
  phone_number_id  text   not null,                -- destination (metadata.phone_number_id); 'unknown' only for migrated rows, reported
  message_id       text   not null,                -- Meta wamid
  sender_key       text   not null,
  sender_phone     text   not null,
  sender_seq       bigint not null,                -- per-sender order (assigned under the sender row lock)
  status           text   not null check (status in ('queued','processing','retry','completed','failed','held','review')),
  attempts         int    not null default 0,
  payload          jsonb,                          -- original single-message envelope; nulled by payload retention once terminal
  provider_ts      timestamptz,                    -- message.timestamp (NEVER overwritten)
  received_at      timestamptz not null default clock_timestamp(),
  first_claimed_at timestamptz,                    -- queue-wait = first_claimed_at - received_at
  next_attempt_at  timestamptz,
  lease_token      uuid,
  lease_expires_at timestamptz,
  claimed_by       text,                           -- worker id (audit)
  effects_state    text   not null default 'none' check (effects_state in ('none','possible')),
  last_error       text,
  resolution       text,                           -- outcome vocabulary, see 4.3
  resolution_detail jsonb,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  completed_at     timestamptz,
  unique (namespace, role, phone_number_id, message_id),      -- identity / dedupe
  unique (namespace, role, sender_key, sender_seq)            -- order
);

create index idx_inbox_items_outstanding on inbox_items (namespace, role, sender_key, sender_seq)
  where status in ('queued','retry','processing');
create index idx_inbox_items_review on inbox_items (namespace, role, status, updated_at, id)
  where status in ('failed','held','review');
create index idx_inbox_items_held_phone on inbox_items (namespace, role, sender_phone, sender_seq)
  where status in ('held','failed','review');
create index idx_inbox_items_actionable_age on inbox_items (namespace, role, received_at)
  where status in ('queued','retry');
create index idx_inbox_items_completed_cleanup on inbox_items (namespace, role, updated_at, id)
  where status = 'completed';
create index idx_inbox_items_payload_purge on inbox_items (namespace, role, updated_at, id)
  where status = 'completed' and payload is not null;

create table inbox_meta (               -- backend state, migration marker, cleanup cursors
  namespace text not null, role text not null, key text not null, value jsonb not null,
  updated_at timestamptz not null default now(), primary key (namespace, role, key)
);
create table inbox_import_ledger (      -- idempotent migration ledger, keyed by source identity + checksum
  source_id text primary key, source_sha256 text not null, status text not null,
  counts jsonb not null, started_at timestamptz not null default now(), finished_at timestamptz
);
create table inbox_admin_audit (        -- replay / discard / review resolution / import: who, what, when
  id bigint generated always as identity primary key, at timestamptz not null default clock_timestamp(),
  actor text not null, action text not null, item_id bigint, from_status text, to_status text, detail jsonb
);
create index idx_inbox_admin_audit_item on inbox_admin_audit (item_id);
```

לא נוסף FK בין `head_id` ל-`inbox_items` (עלות נעילה בכל מעבר); העקביות נאכפת ע"י הטרנזקציה + בודק אינווריאנטות (§3.4).

### 2.2 כל אינדקס והשאילתה שהוא משרת

| אינדקס | שאילתה | ציפייה לתוכנית |
|---|---|---|
| `inbox_items` PK | גישה לפי id אחרי claim / עדכון עם token | Index Scan, 1 שורה |
| `unique(ns, role, phone_number_id, message_id)` | dedupe ב-enqueue (`ON CONFLICT DO NOTHING`), חיפוש לפי wamid | Index Scan, ≤1 שורה |
| `unique(ns, role, sender_key, sender_seq)` | סדר / שלמות סדר לשולח | — (אכיפה + סריקות יזומות בבדיקות) |
| `idx_inbox_items_outstanding` | **קביעת head חדש אחרי מעבר**: `where status in (...) order by sender_seq limit 1` לשולח | Index Scan, קצר: ה-partial מכיל רק פריטים פעילים, לכן **לא תלוי בהיסטוריה**; בדיקת plan: שורות שנסרקו ≤ מספר הפעילים של אותו שולח |
| `idx_inbox_senders_due` | **claim ו-idle poll**: `where head_id is not null and due_at <= now() order by due_at limit K for update skip locked` | Index Scan עם עצירה בשורה הראשונה שלא-due ⇒ tick ריק עולה O(1), גם עם אלפי retries שטרם הגיע זמנם |
| `idx_inbox_senders_phone` | `cancelForPhone`, `resolveHeldForPhone` (מציאת שורות שולח לפי טלפון, ללא תלות ביעד) | Index Scan |
| `idx_inbox_items_held_phone` | פריטי held/failed/review של טלפון (requeue/discard, תצוגת מנהל) | Index Scan |
| `idx_inbox_items_review` | רשימה מדופדפת של held/failed/review לפי סטטוס וזמן; ספירות; התראות | Index Scan עם keyset (`updated_at,id`) |
| `idx_inbox_items_actionable_age` | מדד "הודעה פעילה הישנה ביותר" = `min(received_at)` | Index-only, שורה אחת |
| `idx_inbox_items_completed_cleanup` | ניקוי completed ישנים בקבוצות מוגבלות (`updated_at < now()-30d limit 1000`) | Index Scan מוגבל, לא סריקת טבלה |
| `idx_inbox_items_payload_purge` | איפוס `payload` ל-completed אחרי חלון השימור | Index Scan מוגבל |
| `idx_inbox_admin_audit_item` | תצוגת ביקורת לפריט | — |

שערי הקבלה דורשים `EXPLAIN (ANALYZE, BUFFERS)` לכל שאילתה בטבלה זו ב-300/5,000/50,000 (§8).

---

## 3. שורת ה-scheduler (ב)

### 3.1 מה זה ולמה
`inbox_senders` הוא ה"תור" בפועל. ה-claim לא סורק פריטים: הוא קורא את שורות השולחים שה-`due_at` שלהן הגיע (אינדקס חלקי, עצירה בשורה הראשונה שלא-due), נועל אותן (`SKIP LOCKED`), וממש **בתוך אותה טרנזקציה** מקדם את ה-head של כל שולח. זה מה שהופך את עלות הפעולה לבלתי-תלויה בהיסטוריה ובגודל ה-backlog הכולל — **ומצביע שגוי = הודעה שלא מעובדת לעולם**, ולכן האינווריאנטות והבודק חיוניים.

### 3.2 אינווריאנטות
- **I1** לשולח יש לכל היותר פריט `processing` אחד, והוא ה-head.
- **I2** `head_id` = ה-`id` של הפריט עם `sender_seq` הנמוך ביותר בין פריטי השולח בסטטוסים `queued|retry|processing` ("outstanding"), ו-`NULL` **אם ורק אם** אין כאלה. `held|failed|review|completed` **אינם** outstanding (כמו היום: `held` לא תופס את משבצת השולח — ההודעה הבאה נכנסת ל-handler ונלכדת כ-held).
- **I3** `head_status` = סטטוס ה-head, ו-`due_at` נגזר ממנו: `queued` ⇒ `received_at`; `retry` ⇒ `next_attempt_at`; `processing` ⇒ `lease_expires_at`; `NULL` כש-`head_id IS NULL`.
- **I4** `sender_seq` מוקצה ע"י `insert … on conflict (namespace,role,sender_key) do update set next_seq = inbox_senders.next_seq + 1 returning next_seq - 1` — הפעולה **נועלת את שורת השולח עד commit**, ולכן טרנזקציה מאוחרת יותר לאותו שולח ממתינה ל-commit של הקודמת: **הודעה מאוחרת לא יכולה להתפרסם לפני הודעה מוקדמת שטרם נעשה לה commit.** ב-webhook עם מספר הודעות: טרנזקציה אחת, מיון לפי `sender_key` (סדר נעילה עקבי — אין deadlock).
- **I5** כל מעבר בצד ה-worker הוא `… where id=$1 and status='processing' and lease_token=$2` — 0 שורות ⇒ worker ישן, המעבר נזרק (נרשם בלוג).
- **I6** כל מעבר שמשנה סטטוס של פריט outstanding, **ואת ה-pointer של שורת השולח, מתבצעים בטרנזקציה אחת** תחת נעילת שורת השולח.
- **I7** פריט שאינו terminal לעולם אינו נמחק, בלי קשר לגיל.
- **I8** שורת שולח נמחקת (GC) רק כשאין לו שום פריט שנשמר (אחרי ניקוי הזהות) — אחרת `next_seq` יתאפס והייחודיות `(sender_key, sender_seq)` עלולה להתנגש.

### 3.3 מה קורה למצביע בכל אירוע

| אירוע | פריט | שורת שולח (באותה טרנזקציה) |
|---|---|---|
| **enqueue** (חדש) | `queued`, `sender_seq=next_seq` | `next_seq+1`. אם `head_id IS NULL` ⇒ `head_id=חדש, head_status=queued, due_at=received_at`. אחרת לא נוגעים ב-head (הישן קדם) |
| **enqueue כפול** (זהות קיימת) | לא משתנה | לא משתנה (ON CONFLICT DO NOTHING; מוחזר "duplicate") |
| **claim** | `queued/retry(due)` ⇒ `processing`, `attempts+1`, `lease_token` חדש, `lease_expires_at=now+lease`, `first_claimed_at` אם ריק, `effects_state='possible'` (לקוח) | `head_status='processing'`, `due_at=lease_expires_at` |
| **renew** (token) | `lease_expires_at` מוארך | `due_at` מוארך |
| **retry** (token) | `retry`, `next_attempt_at`, `last_error` | נשאר head; `head_status='retry'`, `due_at=next_attempt_at` |
| **מעבר סופי / non-outstanding** — `completed` / `failed` / `held` / `review` (token) | הסטטוס החדש, `resolution` | **head חדש** = `select … from idx_inbox_items_outstanding … order by sender_seq limit 1` (או `NULL`); `head_status`,`due_at` נגזרים ממנו |
| **ביטול** (`cancelForPhone`) | outstanding של הטלפון ⇒ `failed`, `resolution='superseded'` (גם `processing`, כמו היום; ה-worker שרץ יימנע מכתיבה ע"י I5) | head מחושב מחדש לכל שולח מושפע |
| **replay / requeue** (מנהל) | `held/failed/review` ⇒ `queued`, `attempts=0`, **`sender_seq` חדש** (D6) — לפי הסדר המקורי | `next_seq` מתקדם; אם אין head — הפריט הראשון שהוחזר; אחרת עומד **מאחורי** העבודה הפעילה |
| **reclaim** (lease פג) | ראה §4.2 — שער: `processing` חדש (attempts+1); לקוח: `review` (או ריצה חוזרת אם הוכחה בטוחה) | כמו claim / כמו מעבר סופי |
| **discard** (מנהל) | `held/review ⇒ failed`, `resolution='admin_discarded'`, נרשם ב-audit | head מחושב מחדש אם היה outstanding (אינו) — לרוב אין שינוי |

### 3.4 מה מבטיח שהמצביע לא מתיישן
1. **כל** שינוי סטטוס עובר דרך פונקציות ה-repository היחידות; אין UPDATE מחוץ להן (בדיקת grep/lint ב-C2).
2. טרנזקציה אחת + נעילת שורת השולח (I6). אין dual-write ואין "עדכון pointer אחר-כך".
3. **בודק אינווריאנטות** `checkInvariants(limit)` (repository + endpoint מנהל): מחשב לכל שולח פעיל את ה-head האמיתי (partial index על outstanding בלבד) ומשווה ל-`head_id/head_status/due_at`; מדווח: (a) שולח עם outstanding ובלי head, (b) head שאינו outstanding, (c) head שאינו הנמוך ביותר, (d) `due_at` שאינו נגזר נכון. **עלות: O(#outstanding), לא O(היסטוריה).**
4. **reconciler** בתדירות נמוכה (ברירת מחדל 60s, keyset, קבוצות ≤500) שמריץ את הבודק ותיקון + התראה `inbox-scheduler-drift` בכל סטייה. **בבדיקות C2/C6 סטייה אחת = כישלון**, לא "תוקן ע"י ה-reconciler".
5. בדיקות מבוססות-מודל (property tests): רצף אקראי של enqueue/claim/renew/retry/complete/hold/review/cancel/replay/crash-restart + בדיקת I1–I8 אחרי כל צעד (C2).

---

## 4. מכונת המצבים (ג)

### 4.1 מצבים × אירועים → מעבר / תופעת לוואי / persist

| מצב \ אירוע | claim | renew | complete | retry | hold | review (stale/ambiguous) | exhaust (attempts≥60) | cancel | lease פג | requeue (מנהל) | discard | cleanup |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **(אין)** | — | — | — | — | — | — | — | — | — | — | — | — |
| **queued** | ⇒processing | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ⇒failed | — | ✗ | ✗ | ✗ |
| **processing** | ✗ | lease+ | ⇒completed | ⇒retry | ⇒held | ⇒review | ⇒failed+התראה | ⇒failed | שער: ⇒processing (attempts+1) · לקוח: ⇒review | ✗ | ✗ | ✗ |
| **retry** | ⇒processing (אם due) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ⇒failed | — | ✗ | ✗ | ✗ |
| **held** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | — | ⇒queued (seq חדש) | ⇒failed | ✗ (לא נגזם) |
| **failed** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | — | ⇒queued (מפורש, מאומת) | — | ✗ (לא נגזם) |
| **review** | ✗ | ✗ | ⇒completed רק ע"י ה-token המקורי (§4.2) | ✗ | ✗ | ✗ | ✗ | ✗ | — | ⇒queued (אישור סיכון כפילות) | ⇒failed | ✗ (לא נגזם) |
| **completed** | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | — | ✗ | ✗ | ⇒נמחק אחרי 30 יום (payload מתאפס אחרי 7) |

נקודות persist: **כל** מעבר = טרנזקציה אחת שמסתיימת ב-COMMIT לפני שהקוד ממשיך (אין ACK, אין 200, אין חיווי ל-worker לפני commit). קבלת webhook: 200 רק אחרי commit של כל הפריטים.

**מעברים אסורים** (נאכפים ב-SQL וב-tests): `completed → *` (מלבד מחיקת cleanup); `failed → completed` ישיר; `held/review/failed → processing` ישיר (רק דרך requeue ⇒ queued); כל מעבר worker בלי token תקף; `queued → completed` (חייב לעבור claim); כתיבה לפריט terminal ע"י worker ישן.

### 4.2 שני התפקידים

**שער (`role='gateway'`).** ה-worker מנתב ומעביר ללקוח. reclaim של `processing` שפג ⇒ **ריצה חוזרת** (כמו היום), ובטוחה כי (i) העברה ללקוח אידמפוטנטית לפי זהות הפריט בלקוח (dedupe 30 יום, ולא זיכרון של 1000) ו-(ii) הניתוב נשאר fail-closed. **[הנחה]** — כולל שהחזרה על handover (`meta-clear-pending`) אחרי crash לא מזיקה; זה ייבדק ב-C6 כבדיקה בלבד (ללא שינוי בקוד הניתוב; אם נכשלת — ממצא חוסם, לא תיקון).

**לקוח (`role='client'`).** ה-worker מריץ את מנוע הקמפיין; יש **פעולות שאינן ניתנות לביטול** (שליחות). `claim` מסמן `effects_state='possible'` (שמרני: חלון claim→התחלת handler הוא מילישניות). כשה-lease פג בלי complete:
- `effects_state='possible'` ואין הוכחת-בטיחות ⇒ **`review`** (`resolution='ambiguous_processing'`), התראה קריטית, ו-(D2) הצבת השולח ב-`needs_review` הקיים כדי שהודעות הבאות יילכדו כ-held. **לא מריצים שוב את הקמפיין.**
- **השלמה מאוחרת:** אם ה-worker המקורי סיים בפועל (איטי, לא מת) ו-`complete(id, tokenOriginal)` מגיע כשהפריט `review` עם אותו token — הוא הופך `completed` (`resolution='processed_late'`). בטוח כי אף אחד אחר לא הריץ אותו. זה מקטין נטל ידני.
- **הוכחת בטיחות P1 (אופציונלית, כבויה כברירת מחדל — D1):** "לא נוצר שום עקבות מתמשכות" — אין `campaign_results` / שורת `outbox_messages` / שינוי ב-`conversation_state` לשולח מאז `first_claimed_at`. איננה מוחלטת (יש שליחות שלא עוברות outbox — מופו בשלב B2) ולכן איננה מופעלת עד שנמדוד ב-C6 כמה `review` עמומים נוצרים ב-restart אמיתי ונבחן שלמות העקבות.

**token מגדר כתיבה, לא שליחה.** ה-token מונע מ-worker ישן לשנות את ה-DB; הוא **לא** מונע ממנו לקרוא לרשת. לכן ההגנה מפני שליחה כפולה היא "לא מריצים פעם שנייה" (review), לא ה-token.

### 4.3 תוצאה סופית מבוקרת (resolution)
`processed`, `forwarded` (שער), `processed_late`, `sender_held` (held), `stale_trigger` (review), `ambiguous_processing` (review), `exhausted` (failed), `superseded` (failed), `admin_discarded` (failed). כל פריט terminal/review נושא סיבה; אין "completed" שלא באמת טופל.

### 4.4 תוצאת stale מפורשת (Codex §3)
`messageFlow.ts:1643` יקבל דיווח תוצאה (`reportInboundOutcome({kind:'stale_trigger', ageMs, campaignId})` דרך `AsyncLocalStorage`, no-op מחוץ ל-scope) — **שינוי מינימלי של שורה אחת + הרחבה קטנה**, בלי לגעת במדיניות התפוגה ובלי לדרוס `provider_ts`. ה-drainer עוטף את המטפל; תוצאת `stale_trigger` ⇒ `review` (payload נשמר, `resolution='stale_trigger'`, התראה מצטברת מוגבלת-קצב), **לא** `completed` ולא retry. אין הרצה אוטומטית של קמפיין שפג. **[הנחה]** שאין מסלולי "התעלמות" אחרים שצריכים אותו טיפול — יישאלו ב-C4 (מיפוי כל ה-`return` השקטים ב-handleIncoming).

---

## 5. conversationState — חקירה (ה)

### 5.1 מה הקוד עושה בפועל **[הוכח בקריאה]**
- **`persist()`** (`conversationState.ts:~616`) על כל שינוי: בונה snapshot של **כל** השיחות (`stripDecisionFlow`), קורא ל-`backend.saveConversationStateSnapshot` (`Storage`: `JSON.parse(JSON.stringify(snapshot))` על הכול, ואז `persist()` ל-PG שמעדכן רק שורות מושפעות), ואז `JSON.stringify(snapshot,null,2)` + `writeFileSync` **סינכרוני של הקובץ המלא — גם ב-PostgreSQL** (`conversationState.ts:654`, "secondary copy").
- **מצב JSON (`isPrimaryConversationStore()===true`, כלומר אין backend):** הקובץ הוא מקור האמת היחיד; כתיבה אטומית (tmp → bak → rename); כשל כתיבה **נזרק** לקורא. **יישמר כמו שהוא.**
- **מצב PG:** שורות `conversation_state` הן מקור האמת; נכתבות אסינכרונית ב-drain מתואם (`persistSnapshot`); ההצלחה של הודעה מותנית ב-`await storage.flush()` (קיים).
- **שחזור (`restore`):** `backend.loadConversationStateSnapshot() ?? readSnapshotFile()`. ב-PG: `loadConversationStateSnapshot` מחזיר את השורות שנטענו מה-DB (`database.ts:743`: `undefined` **רק** כשאין שום שורה) — **הקובץ נקרא ב-PG אך ורק כשה-DB ריק**. טיימרים, needs_review, recovery, heldMessages משוחזרים מאותו snapshot.
- **צרכנים נוספים של הקובץ:** אין בקוד. כלי הגיבוי (`scripts/ops/backup.js`) מעתיק את הקובץ רק כ-volume כללי לפי קונפיגורציה; ה-dump של PG מכיל את השורות. `export-postgres-to-json` קורא מה-DB.

### 5.2 מדידה מחדש ב-HEAD (מכונה: AMD Ryzen 7 PRO 5850U, 16 threads, 30GB, Node v24.16.0; PG 18.6 מקומי; **לא חומרת ייצור**)
עלות סינכרונית של שינוי שיחה **אחת** מעל N שיחות שוכנות (state: `expired-decision`, זרימה של 8 צעדים בזיכרון; 60 דגימות; תהליך נקי לכל N). נתונים: `docs/results-data/convstate-hotpath-baseline-2026-09-21.json`, `convstate-drain-baseline-2026-09-21.jsonl`.

| N | קובץ | `set()` חציון / p95 / max (ms) | מתוכו: build / deep-clone / stringify מוזח / כתיבה | **F1**: `cloneSnapshotForTables` בכל drain, חציון / p95 (ms) | **סה"כ ≈** |
|---|---|---|---|---|---|
| 100 | 26KB | 0.68 / 1.03 / 2.02 | 0.28 / 0.15 / 0.07 / 0.42 | 0.32 / 0.64 | ~1.0 |
| 1,200 | 318KB | 5.08 / 7.72 / 16.84 | 1.64 / 2.11 / 1.36 / 0.60 | 3.82 / 5.88 | ~8.9 |
| 5,000 | 1.3MB | 18.74 / 24.30 / 43.71 | 5.12 / 8.80 / 5.24 / 1.15 | 18.09 / 29.23 | ~36.8 |
| 20,000 | 5.3MB | 77.41 / 105.68 / 172.70 | 19.21 / 36.29 / 23.05 / 3.53 | 86.28 / 115.53 | ~164 |

- **הישן 110ms / 47.5ms / 13MB הם היסטוריה** (נמדדו לפני `changedJids` ו-`stripDecisionFlow`). היום ב-1,200 שיחות: ~5ms ב-`set()` ועוד ~4ms ב-drain (F1) — **אבל העלות עדיין לינארית ב-N** (~4µs לשיחה בכל אחד משני המסלולים) ומגיעה ל-~160ms ב-20,000 שיחות שוכנות. ה-24 שעות של `expired-decision` (1,075 מתוך 1,214 בתקלה המקורית) עדיין הופכות את N לגדול.
- **[לא נמדד]:** עלות ה-`syncConversationStateDelta` (סריקת `Object.keys` ×2) ועלות ה-commit ל-DB; lag של event loop בפועל תחת עומס — ייכנסו ל-C1/C6.

### 5.3 ההצעה
**PostgreSQL בלבד:**
1. `ConversationStateManager` יעבור ל-API של **שורות**: `upsertRow(jid, lean)` / `deleteRow(jid)` — עותק עמוק של **שיחה אחת** בלבד (µs), בלי בניית snapshot מלא, בלי deep-clone מלא, בלי כתיבת קובץ.
2. `Storage` יקבל `upsertConversationRow/deleteConversationRow` שמסמנים `conversationStateSnapshot` כ-dirty לפי jid; ו-`cloneSnapshotForTables` יטפל ב-`conversationStateSnapshot` כטבלת שורות (כמו outbox) — **סוגר את F1**.
3. שחזור: **רק מהשורות ב-DB**. `readSnapshotFile()` נשאר **רק** למצב JSON.
4. שמירה: מסלול ה-flush-before-success, שחזור טיימרים, `needs_review` עמיד, `recovery`/`heldMessages` — ללא שינוי.

**אני מציע להסיר** את קובץ ה-shadow ואת מסלול ה-snapshot המלא ב-PG **רק אם ההוכחות הבאות עוברות ב-C4** (אחרת לא מסירים, ואומר זאת):
- **T1** הודעה הושלמה (flush) → kill → restart מ-DB בלבד, **קובץ ה-shadow נמחק** ⇒ אותן שיחות, אותם טיימרים, אותו needs_review.
- **T2** נפילת DB באמצע שינוי ⇒ ה-flush נכשל (לא success), ה-inbox לא נחתם, אין שיחה שנראית עמידה בלי להיות עמידה.
- **T3** N=20,000 שיחות נטושות ⇒ עלות שינוי שיחה אחת לא גדלה עם N (מכוון: ≤2× מ-N=100; מדידת רשת: ראה §8).
- **T4** שיחזור ממסד ריק: אין פתאום "עלייה" של שיחות ישנות (מצב שבו היום הקובץ עלול להחזיר שיחות מיושנות כשה-DB ריק).
- **T5** מצב JSON: אותן בדיקות קיימות + הכשל שנזרק — ללא שינוי.
- **T6** הגיבוי/ייצוא: `db:export` ו-`backup.js` עדיין מכילים את השיחות (מה-DB).

**מה שלא ברור לי ואמרתי במפורש:** [1] האם קיימות בדיקות/סקריפטים שמניחים את קיום הקובץ ב-PG (יימנו ב-C4 בעזרת grep+ריצה, ויתוקנו במקום להיעלם); [2] האם יש מפעילים שקוראים את הקובץ ידנית בפריסות קיימות — לא נבדק, ולכן נעדכן את קונפיגורציית הגיבוי/הדוקומנטציה ולא נמחק קבצים קיימים בשרתים. אם ההוכחות לא מלאות — ההצעה נסוגה ל: "שורות בלבד אבל הקובץ נשאר ככתיבה אסינכרונית מחוץ למסלול החם", ואודיע.

---

## 6. ניתוח מרוצים (ד)

| # | תרחיש | מה קורה | מה מגן |
|---|---|---|---|
| R1 | שני workers מנסים לתפוס אותו שולח | שורת השולח ננעלת ב-`FOR UPDATE SKIP LOCKED`; השני מדלג | נעילה + I1 |
| R2 | שני webhooks במקביל, אותו שולח | הקצאת `sender_seq` תחת נעילת שורת השולח: הסדר = סדר ה-commit | I4 |
| R3 | webhook עם N הודעות, כשל באמצע | טרנזקציה אחת: הכול או כלום ⇒ 503, Meta מנסה שוב, dedupe בזהות | atomic enqueue + unique identity |
| R4 | reclaim בזמן שהישן עדיין רץ (איטי) | שער: ריצה שנייה; כל כתיבה של הישן נדחית (token). לקוח: `review`, אין ריצה שנייה; אם הישן מסיים — `processed_late` בעזרת ה-token המקורי | I5 + §4.2 |
| R5 | crash אחרי הפעולה, לפני סימון completed (לקוח) | `effects_state='possible'` ⇒ `review`, לא ריצה חוזרת | §4.2 |
| R6 | crash אחרי commit של claim, לפני שה-handler התחיל | לקוח: `review` (שמרני). שער: ריצה חוזרת | §4.2 |
| R7 | commit הצליח אך התשובה אבדה (חיבור נפל) | ה-worker רואה שגיאה; ה-retry/complete הבא הוא token-conditioned ⇒ 0 שורות (הפריט כבר לא `processing`) ⇒ no-op. ב-enqueue: ניסיון חוזר ⇒ `ON CONFLICT` ⇒ duplicate | I5 + זהות |
| R8 | DB נופל בזמן עיבוד | אין claim חדש; קבלות נכשלות ב-503; ה-worker שכבר החזיק פריט מקבל כשל ב-complete — לא מסמן הצלחה; אחרי חזרה: lease פג ⇒ §4.2 | אין fallback ל-JSON; זמן ה-lease נמדד ב-`clock_timestamp()` של ה-DB, לא בשעון האפליקציה |
| R9 | שער נופל אחרי שהעביר ללקוח, לפני completed | redelivery מהשער (attempt חדש) ⇒ הלקוח דוחה כפילות לפי זהות | dedupe עמיד בלקוח |
| R10 | requeue של מנהל בזמן שיש עבודה פעילה לשולח | הפריט חוזר עם `sender_seq` חדש ⇒ **אחרי** הפעילים | D6 / I2 |
| R11 | `cancelForPhone` בזמן שה-worker רץ | הפריט `failed('superseded')`; ה-worker שרץ יפסיד ב-complete/retry (token) — אך פעולותיו (כבר בוצעו) לא מתבטלות; הביטול נקרא אחרי `stopCampaignWork` (קיים) | אין שינוי בסמכות הניתוב |
| R12 | `held` → הודעה הבאה של אותו שולח | `held` לא outstanding ⇒ ההודעה הבאה נתפסת, עוברת ב-handler, נלכדת כ-held (כמו היום) | I2 |
| R13 | lease פג בגלל GC ארוך / event-loop חסום בלקוח | renew מחזיר false; ראה R4 | renewal כל lease/3 |
| R14 | הבודק מזהה pointer סטייה | התראה `inbox-scheduler-drift` + תיקון; בבדיקות = כישלון | §3.4 |
| R15 | crash באמצע migration (C5) | ledger אידמפוטנטי לפי checkpoint; אין שני כותבים (marker) | §7 |

---

## 7. מיגרציה וחזרה (תחום C5, כאן רק העיצוב)
תואם לתכנית Codex: pause workers ⇒ גיבוי immutable + checksum ⇒ dry-run (ספירות סטטוסים, זהויות חסרות, כפילויות, timestamps לא תקינים, payload פגום — **לא נבחר "מנצח" בכפילות**) ⇒ ייבוא ב-batches טרנזקציוניים עם ledger לפי `source_id+sha256` ⇒ אימות ספירות/צ'קסאם ⇒ סימון SQL כפעיל (`inbox_meta.active_backend='sql'` **וגם** marker בקובץ המקור: הקובץ נשמר ומקבל שם `.migrated-<ts>`) ⇒ הפעלת workers. **הפעלה כפולה של שני backends נחסמת בעלייה** (env=json + marker SQL ⇒ סירוב; env=sql + קובץ JSON עם פריטים לא מיובאים ⇒ סירוב). פריטים `processing` ביבוא עוברים סיווג (לקוח ⇒ `review`; שער ⇒ `retry`), לא "הצלחה". חזרה: לפני שכתיבה ראשונה ל-SQL — הפעלת המקור ללא שינוי; אחרי — עצירה + ייצוא מאומת ל-JSON (לא "החלפת backend"). **פיילוט/פריסה = הרשאה נפרדת.**

---

## 8. ספי מדידה וסביבת מדידה (ו) — **נקבעים כאן, לפני כל הרצה**

### 8.1 סביבה ובידוד
- **בסיס השוואה:** `098b94f`, נבנה בנפרד מ-`git archive` לתיקייה חיצונית (כמו `headbase`), בלי נגיעה בעץ העבודה. גרסה מתוקנת = עץ העבודה. אותו תרחיש, אותו seed, אותם ספים, אותה מכונה, ריצות מתחלפות (interleaved) ותהליך נקי לכל ריצה.
- **חומרה:** המכונה הנוכחית (מפורטת ב-§5.2); כל דו"ח יכלול CPU/RAM/Node/PG/`shared_buffers`. **המספרים המוחלטים הם של המכונה הזו, לא של הייצור**; ההכרעה נשענת על **יחסים וספירות** (סריקה, בייטים, שורות) שאינם תלויי חומרה.
- **מסד:** PG 18.6 על `localhost:5433` בלבד; מסד ייעודי `flowsbiz_inbox_test` (D3) או סכמה ייעודית; כל ריצה מדפיסה `current_database() / inet_server_port() / version()` ומסרבת אם אינו 5433 עם שם שמכיל `test`. **5432 (PG 16) — אסור.**
- שער ולקוחות **בתהליכים נפרדים**; תרחישים ברצף בלבד; אין SKIP שקט — היעדר DB ⇒ exit 3 (BLOCKED, לא ירוק).
- **אימות ספירות בפועל:** כל ריצה רושמת `counts()` לפי סטטוס **לפני, באמצע ואחרי** הפעולות, ואחרי כל ניקוי; **המספר שדווח כ"היסטוריה" הוא זה שנמצא בפועל**, לא מה שנזרע. ב-baseline ה-`pruneCompletedItems` גוזם `completed` ל-300 בכל enqueue — לכן היסטוריה של 5,000/50,000 ב-baseline נבנית מפריטים **שאינם נגזמים** (`failed`/`held`, ובנוסף backlog `retry`) ומדווחת ככזו; `completed` ב-baseline מדווח כ-≤300 (נמדד, לא הנחה). בגרסה החדשה `completed` נשמר (חלון dedupe) ולכן ההיסטוריה שם באמת 50,000 — והדוח מציין את ההבדל.

### 8.2 C1 — קריטריונים (נקבעו לפני הרצה)
**מטריצה:** היסטוריה H ∈ {300, 5,000, 50,000} × backlog פעיל B ∈ {0, 500, 5,000} (retry שטרם הגיע זמנם) × התרחישים: (א) שולח חסום עם 200 הודעות אחריו; (ב) 500 שולחים חסומים; (ג) retry שטרם הגיע זמנו (tick ריק); (ד) היסטוריית held/failed. בכל תא: 100 פעולות מכל סוג (`enqueue`, `claim`, `markRetry`, `markCompleted`, tick ריק).
**מדדים לכל פעולה:** (m1) זמן קיר p50/p95/max; (m2) בייטים שנכתבו לדיסק (מונה ב-`fs.writeFileSync/copyFileSync/renameSync`) ובייטים שהוסדרו (`JSON.stringify`); (m3) אלמנטים שנסרקו (מונה על גישות למערך הפריטים); (m4) lag של event loop (`monitorEventLoopDelay`) בתהליך השער תחת גל של 150 קבלות.
**"הידרדרות שוחזרה" אם (בגרסת הבסיס, כל התנאים על פעולת עדכון בודדת `markRetry`):**
1. **בייטים לפעולה** ב-(H=50,000,B=5,000) ≥ **50×** מ-(H=300,B=0);
2. **אלמנטים שנסרקו לפעולה** ≥ **0.9 × (H_בפועל + B)** (כלומר סריקה מלאה);
3. **זמן p95** ב-(50,000, 5,000) ≥ **10×** מ-(300, 0).
**שני תנאים ראשונים מוכיחים את המנגנון גם אם חומרה מהירה מסתירה את הזמן.** אם 1+2 מתקיימים ו-3 לא — מדווח "מנגנון הוכח, חריגת זמן לא נצפתה על החומרה הזו". אם 1 או 2 לא מתקיימים — עוצרים ומדווחים מה הוכח ומה חסר. **אין שינוי ספים כדי לייצר כישלון.**
**מגמת הלולאה (feedback):** עלות `markRetry` יחיד כפונקציה של B (H קבוע=300) — נדרש שיפוע חיובי מובהק (יחס ≥ 5× בין B=5,000 ל-B=0); זה מראה שיותר retry ⇒ כל retry יקר יותר.
**בדיקה מחייבת נפרדת (C1/C3):** crash אחרי פעולת קמפיין ולפני סימון completed — ראה §4.2/R5; מבוצעת גם על הבסיס (להראות ריצה חוזרת) וגם על המתוקן (להראות `review`, ללא שליחה שנייה).

### 8.3 שערי קבלה (מהמסמך של Codex — **ספי קבלה מוצעים, לא מדידות**)
- p95 של `enqueue`/`claim`/מעבר ב-H=50,000 ≤ **2×** מ-H=300, **וגם** ≤ **100ms**, בחומרה הקבועה. **בנוסף (שלי):** שורות שנסרקו לפעולה ≤ 50 ללא תלות ב-H/B; בייטים שנכתבו לפעולה קבועים (±20%) — נקרא מ-`EXPLAIN (ANALYZE,BUFFERS)` לכל שאילתה בטבלת §2.2.
- שער: lag של event loop p99 < 100ms, max < 500ms (בריא); receipt→handler p99 < 5s, max < 30s; אין stale drops; אין timeout ניתוב לא מוסבר.
- 100 במקביל / 150 stress / 1,000 על פני שעתיים + שעה שלישית עם 30–40% נטישה והיסטוריית שיחות מוזרעת; כולל סטטוסי מדיה ו-compaction של יומן הסטטוסים. **ריצה מלאה של 3 שעות = פעם אחת בסוף (C6)**; לפני כן גרסה דחוסה (1,000 על פני ~20 דקות) כשער רגיל — אודיע על ההבדל.
- הפסקות 60s/180s של לקוח ו-DB: עבודה מוגבלת, ניקוז backlog, שום הודעה לא נעלמת ולא מוצגת כ-completed; תפוגה מעבר ל-`MAX_TRIGGER_AGE_MS` ⇒ תוצאת review גלויה.
- מדדים: ההודעה הפעילה הישנה ביותר, אחוזוני queue-wait; **התראות:** אזהרה ב-30s, קריטי ב-120s (מוצעים), וכשל persist / attempts שמוצו / stale — מיידיות. הדשבורד/metrics לא סורקים היסטוריה בכל הודעה (ספירות: אינדקסים חלקיים בלבד).
- רגרסיות קיימות חייבות לעבור: inbox, סדר שולחים, בידוד ניתוב, חתימה, PG delta, שחזור שיחות, shutdown, held/replay, Outbox recovery, וכל הסוויטה (67 ב-HEAD: 66 עוברות, 1 BLOCKED ידוע — `test-backup-tool`).

---

## 9. הערכת מאמץ לפי נקודות הביקורת (ז)

| נק' | תוכן | ימי עבודה (הערכה ראשונית) | סיכון עיקרי |
|---|---|---|---|
| C0 | תכנון + מדידות conversationState (בוצע) | 0.5 | — |
| C1 | harness הצטברות, baseline מ-`098b94f`, מטריצה 3×3, בדיקת crash-אחרי-פעולה על הבסיס | 1–1.5 | זמן ריצה של המטריצה; אימות ספירות בפועל |
| C2 | repository אסינכרוני + סכימה + scheduler, מבודד; property/model tests; query plans | 2.5–3 | תקינות ה-scheduler (הליבה); התאמת JSON-adapter לחוזה האסינכרוני |
| C3 | חיבור שני ה-Inboxes: drainer אסינכרוני, HTTP receipts, admin, shutdown, stale outcome, review/D1/D2 | 2 | שינוי `createSenderDrainer` וה-handlers; אי-נגיעה בניתוב |
| C4 | conversationState (שורות, F1, הסרת shadow ב-PG) + סיווג stale | 1.5–2 | מבחני T1–T6; בדיקות קיימות שמניחות קובץ |
| C5 | כלי מיגרציה/חזרה/dry-run/ledger, סימולציית קטיעה | 1.5–2 | מקרי קצה של קבצים פגומים; "שני כותבים" |
| C6 | עומס, fault injection, רגרסיה מלאה, soak 3 שעות | 2–3 (+ זמן קיר) | ממצאי crash-window מרחיבים היקף |
| **סה"כ** | | **≈ 11–14 ימים** | גבוה מ-6–10 של Codex: הוספתי C1 כשלב עצמאי, F1, ומטריצת ה-fault/soak המלאה |

הערכה ראשונית, לא התחייבות; אינה כוללת פיילוט/פריסה/זמן תצפית.

---

## 10. מה לא נעשה / לא נבדק (במפורש)
- לא נכתב קוד מימוש; לא נבדק EXPLAIN של הסכימה המוצעת (יישום ב-C2).
- **[לא נבדק]** שאין קוד נוסף (מחוץ ל-`adminServer.ts`) שכותב ישירות ל-`meta-*-inbox.json`. grep ראשוני: סקריפטי `audit-*`, `measure-inbox-retention-cost.js`, `test-*inbox*`, `test-load-burst-*` משתמשים במחלקה — יומרו/יישארו על ה-adapter של JSON ב-C2–C3.
- **[הנחה]** ש-`groupMetaItemsBySender` תמיד מקבל פריט אחד לשולח (claim מציע פריט אחד לכל key), ולכן הלולאה `deferred` ב-`metaGatewayDrainer` ריקה בפועל — יאומת ב-C3.
- לא נבדק מול ייצור: מספר הפריטים בקבצי ה-inbox האמיתיים; קיום `PostgreSQL` לשער; גרסאות/יכולות הלקוחות הרצים (Codex סעיף 6). כל אלה בסיכון המיגרציה/פריסה.
- עלות `syncConversationStateDelta` וה-commit ל-DB, ו-lag event loop אמיתי — ב-C1/C6.
- `AsyncExpiringCache`: **לא נוגעים** (fail-closed נשאר; ההחלטה נפרדת, כפי שהוגדר).

---

## 11. נעצר כאן (C0)
מחכה לאישור מפורש **לפני C1**, ולהכרעה בסעיפים D1–D7 (במיוחד D1, D2, D3, D7).
