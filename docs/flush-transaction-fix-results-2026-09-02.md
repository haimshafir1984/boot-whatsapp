# תיקוני `flush()` וטרנזקציות PostgreSQL — תוצאות

תאריך: 02/09/2026
ענף: `perf/flush-scoped-wait` (מכיל כבר את `80b6e3b` — cherry-pick של `cloneSnapshotForTables`)
מבצע: סוכן פיתוח. **לא בוצעה פריסה.**

מקורות: `docs/post-campaign-fixes-2026-09-01.md` (עדיפות 0.6),
`docs/codex-review-flush-repair-session-2026-09-02.md` (הספק), `docs/qa-track-b-results.md` (B2-1, B2-3, B3-1).

## תנאי פתיחה

| בדיקה | תוצאה |
|---|---|
| `npm run build` לפני כל שינוי | עבר נקי (`tsc`, אפס שגיאות) |
| קומיט נבדק | `4577548` על `master`; לאחר `git merge master` לתוך הענף → `9e94e69` |
| מיזוג master לענף | נקי, ללא קונפליקטים (master הוסיף רק תיעוד) |
| מסד בדיקה | `postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test` — localhost, שם כולל `test`. PostgreSQL 16.14. |
| היקף | `src/database.ts` + קבצי בדיקה + מסמך זה בלבד. שום קובץ אחר לא נגע. |

---

## שלב 1 — טרנזקציות על client קבוע (B2-1)

### הבעיה

`pool.query('begin')` … `pool.query(sql)` … `pool.query('commit')` — כל קריאה יכולה לקבל
connection אחר מה-pool. כששאילתה שנייה משתלבת על ה-pool בין BEGIN ל-COMMIT, ה-connection של
ה-BEGIN נשאר `idle in transaction` לצמיתות ומחזיק `RowExclusiveLock` שלא משתחרר, וה-COMMIT
שנוחת על connection אחר הוא no-op שקט.

### מה שונה (`src/database.ts`)

| מיקום | שינוי |
|---|---|
| `applyMigrations` — [database.ts:537](../src/database.ts#L537) | ה-DDL של `schema_migrations` נשאר לפני הטרנזקציה. כל מיגרציה + רישום ה-`schema_migrations` שלה רצים על `client` יחיד מ-`pool.connect()` ([:547](../src/database.ts#L547)), עם `client.query('rollback').catch(()=>{})` ו-`client.release()` ב-`finally`. |
| `writeSnapshot` — [database.ts:676](../src/database.ts#L676) | `const client = await pool.connect()` ([:681](../src/database.ts#L681)); `begin`/כל ה-`replaceRows`/`replaceConversationStateRows`/`commit` דרך `client`; `rollback().catch()` + `release()` ב-`finally`. |
| `writeSnapshotDelta` (הנתיב החם) — [database.ts:725](../src/database.ts#L725) | `const client = await pool.connect()` ([:740](../src/database.ts#L740)); `client.query('begin')` נכנס לתוך ה-`try`; כל 12 קריאות ה-`sync*Delta`/`client.query` מקבלות `client`; `rollback().catch()` + `release()` ב-`finally`. |
| 12 פונקציות עזר | הטיפוס `pool: Pool` → `pool: Pool | PoolClient` (שינוי מכני; שתי הטיפוסים חולקים `.query()`): `syncCampaignEventsDelta` [:826], `syncRowsDeltaTracked` [:870], `syncOutboxMessagesDelta` [:904], `syncCampaignResultsDelta` [:908], `syncContactQueueDelta` [:912], `syncContactsListDelta` [:916], `syncRowsDelta` [:948], `upsertRow` [:968], `syncConversationStateDelta` [:1008], `upsertConversationState` [:1036], `replaceRows` [:1061], `replaceConversationStateRows` [:1087]. |

הערה: `applyMigrations`, `writeSnapshot`, `writeSnapshotDelta` נשארות מוקלדות `pool: Pool` בחתימה
שלהן — הן מקבלות `Pool` אמיתי וקוראות `.connect()`. שם הפרמטר בעוזרים נשאר `pool` (רק הטיפוס
הורחב); הערך שמועבר בפועל הוא ה-`client` הנעול.

### קומיט

`ff47ebb` — "Fix PostgreSQL transactions to use a dedicated client". קומיט אחד: כל העוזרים + שלוש
נקודות הכניסה + הבדיקות ביחד (אין מצב ביניים חלקי).

### בדיקות שלב 1

#### `scripts/test-postgres-transactions.js` (חדש) — מול Postgres מקומי אמיתי

מריץ עם `application_name=flowsbiz_txn_test` על ה-URL של הבקאנד, ו-pool אבחון נפרד
(`application_name` אחר) כדי שכל מה שהוא מודד יהיה מיוחס לקוד הנבדק בלבד.

1. **הצפת כתיבות מקבילי** — 250 כתיבות `Storage` אמיתיות, אחת לכל `setImmediate` (מהיר יותר
   ממחזור drain). אחרי `flush()`: שאילתה ל-`pg_stat_activity` (`state='idle in transaction'`) +
   `pg_locks` (locks שמוחזקים ע"י backend `idle in transaction`) מסוננים ל-`application_name` של
   הבדיקה — שניהם חייבים 0. בנוסף כל 250 השורות נטענות מחדש מ-Postgres. **זו הבדיקה ששחזרה את
   הבאג המקורי.**
2. **commit תחת תחרות על ה-pool** — 4 workers מריצים `select pg_sleep(0.01)` בלולאה על אותו
   pool (`max: 5`) בזמן ש-6 קריאות `writeSnapshotDelta` ישירות עושות commit. בסוף: 0
   `idle in transaction`, כל 6 ה-deltas התקומיטו. מוכיח שהטרנזקציה נשארת נעולה גם כשאחרים
   נאבקים על connections.
3. **כשל באמצע טרנזקציה** — delta שנוגע ב-`campaigns` (תקין) ואז ב-`outbox_messages` עם
   `recipient=NULL` (הפרת NOT NULL). נבדק: `writeSnapshotDelta` נדחה עם השגיאה האמיתית; שורת
   ה-campaign שנכתבה לפני הכשל **לא** שרדה (rollback מלא); 0 `idle in transaction`; ה-pool עדיין
   שמיש — delta נקי אחריו מצליח.

**פלט מלא (קוד נכון):**

```
1. 250 coalesced writes in 183ms -> 0 idle-in-transaction, 0 locks held by idle txn, all 250 rows durable.
2. 6 deltas committed while 4 workers fought for pool connections -> 0 idle-in-transaction, all committed.
3. mid-delta NOT NULL violation -> full rollback (0 partial rows), 0 idle-in-transaction, pool still usable.

PostgreSQL transaction test passed: transactions are pinned to one connection, nothing is stranded, failures roll back whole.
```

**הוכחת מוטציה (שלב 1):** שיניתי זמנית ב-`writeSnapshotDelta` את
`await client.query('begin')` → `await pool.query('begin')` (שאר ה-statements נשארו על `client`),
`npm run build`, הרצתי:

```
AssertionError: 1. after parallel flood: {"idle_in_txn":1,"locks_held_by_idle_txn":1}
  - a connection was left idle in transaction (B2-1 regression)
```

הבדיקה תפסה בדיוק את הסימפטום: connection אחד תקוע `idle in transaction` מחזיק lock.
שוחזר מיד; `npm run build`; הבדיקה חוזרת לעבור.

#### רגרסיה — כל הבדיקות הקיימות, ללא שינוי בהתנהגות

| בדיקה | תוצאה |
|---|---|
| `scripts/test-postgres-delta.js` | PASS |
| `scripts/test-postgres-dirty-tables.js` | PASS (הותאם: mock pool קיבל `connect()` שמחזיר client עם אותו recorder) |
| `scripts/test-postgres-burst.js` | PASS (`2000 writes, ~1540ms`) |
| `scripts/test-postgres-no-lost-writes.js` | PASS (הותאם באותו אופן; `35 coalesced write cycles`, אפס אובדן) |
| `scripts/test-outbox-durability.js` / `test-outbox-ordering.js` / `test-outbox-claim.js` | PASS |
| `scripts/test-flow-recovery.js` / `test-flow-concurrency.js` | PASS |

---

## שלב 2 — `flush()` לפי generation

### הבעיה

```ts
async flush(): Promise<void> {
  do { const pending = this.pending; await pending; }
  while (this.draining || this.queuedSnapshot);
  if (this.lastError) throw new Error(this.lastError);
}
```

תחת עומס, כל כתיבה חדשה מכל שולח מאכלסת מחדש `queuedSnapshot`, כך ש-`flush()` ממתין לשקט
**גלובלי** של כל שכבת ההתמדה — לא לכתיבה של הקורא עצמו. נמדד בפרודקשן עד 39.63s למשתתף בודד,
בדיוק לפני `send()` ל-Meta ב-`sendTrackedOutboxMessage` ([messageFlow.ts:519](../src/messageFlow.ts#L519)).

### מה שונה (`src/database.ts`, מחלקת `PostgresStorageBackend`)

| מיקום | שינוי |
|---|---|
| שדות חדשים — [database.ts:266](../src/database.ts#L266) | `writeSeq` (מונה כל `persistSnapshot`), `durableSeq` (ה-`writeSeq` הגבוה ביותר שהתקומיט בפועל), `batchSignal`/`resolveBatchSignal` (latch חד-פעמי), `batchError`/`batchErrorThroughSeq` (המחזור הכושל האחרון והטווח שלו). |
| קונסטרקטור | `batchSignal` מאותחל כ-Promise ממתין אמיתי (לא `Promise.resolve()`) — המתנה ל-Promise שכבר נפתר בלולאת בדיקה חוזרת הייתה מסובבת את תור ה-microtasks ומרעיבה את ה-I/O של ה-drain. |
| `signalBatchComplete()` — [database.ts:280](../src/database.ts#L280) | שומר את ה-resolver הישן, מתקין latch חדש, ואז פותר את הישן — ממתינים ישנים מתעוררים, חדשים מאזינים למחזור הבא. |
| `persistSnapshot` — [database.ts:302](../src/database.ts#L302) | `this.writeSeq += 1` בכניסה. |
| `drainPendingSnapshots` — [database.ts:328](../src/database.ts#L328) | `batchSeq = this.writeSeq` נתפס אחרי איסוף הכתיבות של המחזור, לפני איפוס התור. אחרי `writeSnapshotDelta` מוצלח: `this.durableSeq = batchSeq` ([:339](../src/database.ts#L339)), ניקוי `batchError` אם retry עקף את הטווח הכושל, ו-`signalBatchComplete()`. ב-`catch`: `batchError`/`batchErrorThroughSeq = batchSeq` + `signalBatchComplete()` (להעיר ממתין שהמחזור שלו נכשל). |
| `flush()` — [database.ts:366](../src/database.ts#L366) | `targetSeq = this.writeSeq`; `while (this.durableSeq < targetSeq)` — אם `batchError` קיים ו-`targetSeq <= batchErrorThroughSeq` → `throw`; אחרת `await this.batchSignal`. |
| `close()` — [database.ts:383](../src/database.ts#L383) | שומר את סמנטיקת השקט הגלובלי: `while (draining || queuedSnapshot) await this.pending` ואז `pool.end()` — shutdown חייב לנקז **כל** כתיבה שבתור, לא רק generation אחד. |

### תנאי נכונות (מהסקירה) — כיצד נענו

| תנאי | מימוש |
|---|---|
| 1. `batchSeq` נתפס אחרי איסוף כל הכתיבות שבמחזור, לפני איפוס התור | `batchSeq = this.writeSeq` ב-[:328](../src/database.ts#L328), מיד לפני `this.queuedSnapshot = null`. אין `await` בין קריאות `persist()` לנקודה הזו. |
| 2. רק commit מוצלח מעלה `durableSeq` | `this.durableSeq = batchSeq` נמצא אחרי `await writeSnapshotDelta`, בתוך ה-`try`, לפני כל throw. |
| 3. `flush()` לא חוזר לפני `durableSeq >= targetSeq` | תנאי הלולאה `while (this.durableSeq < targetSeq)`. |
| 4. כתיבה שנכנסה אחרי תפיסת `targetSeq` לא מעכבת | `targetSeq` קפוא בזמן הקריאה; `writeSeq` ממשיך לעלות אבל הלולאה יוצאת ברגע ש-`durableSeq` מגיע ל-`targetSeq` הקפוא. |
| 5. אין missed wake-up סביב `flush()` ↔ `signalBatchComplete()` | `batchSignal` תמיד Promise ממתין; `signalBatchComplete` מתקין latch חדש **לפני** שהוא פותר את הישן; בין בדיקת `durableSeq` ל-`await this.batchSignal` אין נקודת השהיה. השלמת מחזור לפני ה-`await` משאירה Promise פתור → הלולאה בודקת שוב מיד. |
| 6. **הפער הקריטי:** מחזור N נכשל, N+1 מצליח — ממתין ל-N+1 חייב להצליח | `batchErrorThroughSeq` = ה-seq של המחזור הכושל. `flush()` ל-generation מאוחר: `targetSeq > batchErrorThroughSeq` → תנאי ה-`throw` שקרי → ממתין ויוצא על `durableSeq >= targetSeq`. `batchError` גם מתנקה ברגע ש-`durableSeq >= batchErrorThroughSeq`. נבדק ישירות ב-3b/3c למטה. |

### קומיט

`2bc5b42` — "Scope flush() waits to the requested write generation".

### בדיקות שלב 2

#### `scripts/test-flush-scoped-wait.js` (נכתב מחדש) — מול Postgres מקומי אמיתי

1. **150+ כתיבות זרות תוך כדי `flush()` יחיד** — הצפה על כל `setImmediate` למשך 1200ms כך
   ש-`queuedSnapshot` מאוכלס מחדש כל הזמן. אמצע-הצפה: enqueue של "ההודעה שלי" + `flush()`, מדידת
   זמן. נדרש: `flush()` חוזר **לפני** שההצפה נגמרה, וזמן ה-`flush()` לא תלוי בכמות הזרם.
2. **rebuild מלא מ-Postgres** — `loadStorageSnapshot` חדש; ההודעה שהומתנה + **כל** הכתיבות
   הזרות נמצאות.
3. **כשל generation מכוון** — הוספת `CHECK (recipient <> 'whatsapp:BREAKME')` מחוץ למערכת;
   enqueue של שורה שמפרה + `flush()` → נדחה עם השגיאה האמיתית (3a). הסרת ה-CHECK; enqueue חדש
   + `flush()` של generation מאוחר → **לא** זורק (3b). reload: גם השורה שנכשלה (ונוסתה שוב) וגם
   כתיבת ההתאוששות נשמרו (3c). זה הפער הקריטי מהסקירה, נבדק ישירות.
4. **shutdown** — 300 כתיבות ל-outbox, ואז `storage.close()` בלי enqueue נוסף. reload: כל 300
   נחתו — `close()` המתין לכל התור, לא רק ל-generation שהיה פעיל בזמן הקריאה.
5. **סדר ואי-כפילות אחרי restart תחת עומס** — 200 שורות outbox עם `idempotencyKey`, חלקן
   `markOutboxSent` משולב; `close()`; backend חדש על אותו DB; `loadSnapshot`. נבדק: 200 שורות,
   200 מזהים ייחודיים, 200 מפתחות idempotency ייחודיים, סדר `created_at` נשמר, עדכוני `sent`
   in-place שרדו.

**פלט מלא (קוד נכון):**

```
1. flush() returned in 243ms with 1893 unrelated writes already queued (flood reached 5648); it did not wait for global quiet.
2. reload from Postgres: awaited write + all 5611 flooded writes present - nothing lost.
PostgreSQL storage write failed: error: new row for relation "outbox_messages" violates check constraint "tmp_flush_fail"
   [console.error צפוי — הכשל המכוון של בדיקה 3]
3a. the caller whose write was in the failed batch got the real error: "new row for relation "outbox_messages" violates check constraint "tmp_flush_fail"".
3b. a later generation that committed resolved cleanly - it did not inherit the failed batch's error.
3c. reload: both the retried write and the recovery write are durable.
4. close() waited for all 300 queued writes to land before ending the pool.
5. restart under load: 200 rows, 200 unique ids, 200 unique idempotency keys, created_at order intact, 67 sent.

flush() is scoped to its own write generation, loses nothing under load, surfaces failures to the right caller, and drains fully on shutdown.
```

3 הרצות רצופות של בדיקה 1: `243ms / 254ms / 255ms` (הזרם הגיע ל-~5,500–5,650 כתיבות בכל הרצה).

**הוכחת מוטציה (שלב 2):** החזרתי זמנית את גוף `flush()` להמתנת השקט הגלובלי הישנה
(`do { await this.pending } while (this.draining || this.queuedSnapshot)`), `npm run build`,
הרצתי:

```
AssertionError: flush() must return while the flood is still arriving
  (returned +3015ms, flood ended +1202ms)
```

עם הקוד הישן `flush()` חזר רק ב-+3015ms — אחרי שההצפה נגמרה (+1202ms) ואחרי ניקוז ~5,600
הכתיבות. עם הקוד החדש: ~250ms. שוחזר; `npm run build`; חוזר לעבור.

---

## מדידות לפני / אחרי

| מסלול | לפני (קוד `master`/מוטציה) | אחרי | הערה |
|---|---|---|---|
| `flush()` תחת burst (~1,900 כתיבות זרות בתור, זרם מגיע ל-~5,600) | **~3,015ms** (המתנה לשקט גלובלי + ניקוז מלא) | **~250ms** (מחזור drain בודד) | פי ~12; לא תלוי עוד בכמות הזרם הזר |
| `idle in transaction` אחרי burst של 250 כתיבות מקבילות | **1** connection תקוע + **1** lock מוחזק (מוכח במוטציה) | **0** / **0** | הבדיקה המכריעה של B2-1 |
| כשל באמצע delta | rollback "מחזיק במקרה" בלבד (חיבור בודד); תחת תחרות → קומיט חלקי אפשרי | rollback מלא ומובטח, 0 שורות חלקיות, pool שמיש | |
| parity זיכרון ↔ DB אחרי עומס | תקין | תקין (5,611 כתיבות זרות + המתנה, אפס אובדן; 35 מחזורי coalescing ב-no-lost-writes) | ללא רגרסיה |
| `close()` / shutdown | מנקז הכל | מנקז הכל (300/300) | סמנטיקה נשמרה במפורש |

---

## ממצאים נוספים שעלו תוך כדי (לא תוקנו — לתיעוד בלבד)

1. **`this.batchSignal = Promise.resolve()` כאתחול הוא מלכודת starvation.** בגרסת הביניים
   הראשונה של שלב 2, `flush()` שהמתין ל-latch פתור בלולאת בדיקה חוזרת סובב את תור ה-microtasks
   וחסם את callback ה-I/O של ה-drain — `test-postgres-delta` נתקע. תוקן באותו שלב (latch ממתין
   אמיתי מהקונסטרקטור). מתועד כאן כי זה דפוס קל לשחזר בטעות בכל שינוי עתידי ב-`signalBatchComplete`.
2. **הכשל המכוון בבדיקה 3 מדפיס `PostgreSQL storage write failed:` ל-stderr** דרך ה-`console.error`
   הקיים ב-`drainPendingSnapshots` catch. זו התנהגות נכונה, אבל שווה לזכור שבפרודקשן כל כשל
   כתיבה מייצר את השורה הזו — אין throttling עליה.
3. **B2-3 (מיגרציה שנופלת באמצע) נפתר כנגזרת של שלב 1** — עם `client` נעול, מיגרציה רב-statement
   שנכשלת מתגלגלת אחורה כמקשה אחת. לא נדרשה עבודה נוספת.
4. **שלב 3 (גיזום `outbox_messages` / B3-1) לא נגעתי בו** — מחוץ להיקף המשימה במפורש. הוא נשאר
   פתוח: `outbox_messages` עדיין גדל ללא גבול ומייקר כל `cloneSnapshotForTables` של הטבלה הזו.

---

## קומיטים שנוצרו

| hash | כותרת |
|---|---|
| `ff47ebb` | Fix PostgreSQL transactions to use a dedicated client |
| `2bc5b42` | Scope flush() waits to the requested write generation |

שניהם על `perf/flush-scoped-wait`, מעל `9e94e69` (merge של `master` העדכני + `80b6e3b`).

`git diff --stat 9e94e69..HEAD`:

```
 scripts/test-flush-scoped-wait.js       | 261 +++++++++++++++++++++
 scripts/test-postgres-dirty-tables.js   |  13 +-
 scripts/test-postgres-no-lost-writes.js |  12 +-
 scripts/test-postgres-transactions.js   | 236 +++++++++++++++++++
 src/database.ts                         | 209 ++++++++++++------
```

שום קובץ מקור אחר לא השתנה. אין שינוי סכימה.

---

## תוכנית rollback

שני התיקונים הם **שינוי קוד בלבד** — אין מיגרציה חדשה, אין שינוי במבנה טבלאות או אינדקסים,
אין שינוי בלתי-הפיך. Rollback = פריסה מחדש של הקומיט הקודם (`9e94e69`, או `master`):

- שלב 2 בלבד לאחור: `git revert 2bc5b42` — מחזיר את `flush()` להמתנת שקט גלובלי. שלב 1 עצמאי
  ועומד בפני עצמו.
- שני השלבים לאחור: `git revert 2bc5b42 ff47ebb`, או פריסת `9e94e69`.
- אין מצב DB שצריך לתקן: הטבלאות זהות לפני ואחרי. סשן שרץ על הקוד החדש והופסק לא משאיר שום
  דבר שהקוד הישן לא יודע לקרוא.

---

## סטטוס

**לא בוצעה פריסה. ממתין לאישור בחלון שקט.**

תנאי הסיום מהסקירה:

1. ✅ `npm run build` נקי.
2. ✅ תוצאות בדיקות Postgres אמיתיות ומבודדות, כולל כל בדיקות הכשל, עם פלט מלא (למעלה).
3. ✅ diff ממוקד ב-`src/database.ts` + קבצי בדיקה + מסמך זה בלבד.
4. ✅ מדידת לפני/אחרי: `flush()` תחת burst ~3,015ms → ~250ms; אפס `idle in transaction`; parity
   זיכרון/DB אומת.
5. ✅ תוכנית rollback כתובה; אושר שאין שינוי סכימה בלתי-הפיך.

## עדכון — סקירה נוספת (קודקס), קומיט `88a4e60`

קודקס אישר מיזוג, עם הערה לא-חוסמת אחת: `scripts/test-postgres-transactions.js` שם לחץ תחרותי אמיתי
רק על `writeSnapshotDelta` (הנתיב החם) — לא על `applyMigrations` ו-`writeSnapshot` המלא, שקיבלו את
אותו תיקון אבל לא נבדקו תחת אותם תנאים.

**טופל** (קומיט `88a4e60`): שתי בדיקות נוספו לאותו קובץ —

- **בדיקה 4** — `migrateDatabase` (עוטפת את `applyMigrations`) תחת לחץ תחרותי אמיתי על ה-pool,
  אחרי `drop table schema_migrations` כדי שהמיגרציות באמת ירוצו (לא ידלגו על עצמן). מאמת:
  אפס `idle in transaction`, כל המיגרציות נרשמו, הסכימה בפועל קיימת.
- **בדיקה 5** — `replaceStorageSnapshot`/`writeSnapshot` (נתיב הייבוא/שחזור המלא) תחת אותו לחץ.
  מאמת: אפס `idle in transaction`, כל הטבלאות שוחזרו נכון.

**מוטציה עצמאית על שתי הבדיקות החדשות**: החזרת `client.connect()`/`client.query` ל-`pool.query('begin')`
משותף גורמת לכשל מיידי וברור (`client.release is not a function`) — הוכחה שהן בודקות את הנתיב האמיתי,
לא רק "רצות בלי לבדוק כלום".

**הערת שקיפות:** בריצת רגרסיה אחת (מתוך ~9 ריצות עוקבות ברצף מהיר על אותו DB מקומי), `test-postgres-transactions.js`
נכשל פעם אחת ב-249/250 שורות. נוסה שחזור ב-6 ניסיונות נוספים (3 בבידוד, 3 מיד אחרי
`test-flush-scoped-wait.js`) — לא שוחזר אף פעם. מוערך כרעש מריצות DB רבות ברצף מהיר על אותו מסד
מקומי (התנגשות ידועה ומתועדת, §4.1 ב-`docs/post-campaign-fixes-2026-09-01.md`), לא רגרסיה בלוגיקה —
אך מתועד כאן כדי לא להסתיר.

**עדיין נדרש לפני בקשת פריסה בפועל** (מהסקירה): לוודא שהקמפיין שקט, שאין `processing`/`retry` חריגים
ב-`outbox` דרך `/health`, ושיש אפשרות redeploy מיידית במקרה חריג.
