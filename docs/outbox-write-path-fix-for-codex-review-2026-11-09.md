# מסמך העברה לקודקס: תיקון מסלול הכתיבה של ה-outbox (`OUTBOX_SNAPSHOT_FAST`) — סקירה חוזרת לפני פריסה

תאריך: 9.11.2026. ענף: `feature/returning-buttons-p3`. **לא נעשה commit, push או פריסה.** כל השינויים בעץ העבודה בלבד.

## 1. מה מבקשים ממך
1. לסקור את המימוש (`src/database.ts`) מול התוכנית שאישרת (`docs/outbox-write-path-fix-plan-for-codex-2026-11-08.md`, §10) ולוודא שכל שלושת שינויי התכנון שדרשת מומשו.
2. לסקור את הבדיקה החדשה (`scripts/test-snapshot-fast-path.js`): האם מכסה את מצבי הכשל הנכונים, והאם יש תרחיש חסר.
3. לפסוק על ממצאי ה-catastrophe (§5): האם המסקנה "הכפילויות אינן תלויות בדגל" מבוססת מספיק לפריסה עם הדגל כבוי.
4. לאשר או לדחות את תוכנית הפריסה (§7).

## 2. הרקע בקצרה
אחרי ההשקה הגדולה (7.11, לקוחה c02484f2, המספר המשותף) זמן התגובה הראשונה עלה מ-2.46 ל-3.0–3.4 שניות גם בעומס כמעט אפס. ניסוי מקומי (`scripts/experiment-outbox-growth.js`, 1,000 מול 20,000 שורות outbox) הראה שעלות הסנכרון של כל אצוות כתיבה גדלה פי ~11, והעברת השער ללקוחה פי ~6. הסיבה: `cloneSnapshotForTables` ו-`syncRowsDeltaTracked` ב-`src/database.ts` עושים מעבר O(n) על כל ה-outbox בכל כתיבה. פירוט: `docs/outbox-growth-experiment-2026-11-08.md`.

**חשוב:** ההאטה בייצור גדולה בערך פי 10 מהניסוי. התיקון מסיר את הסיבה שהוכחנו, אין הבטחה שהוא מסביר את כולה.

## 3. מה שונה (`src/database.ts`, בערך +200 שורות)
הכול מאחורי `OUTBOX_SNAPSHOT_FAST=1`. **ברירת מחדל: כבוי**, והתנהגות זהה למקור.

- `cloneSnapshotForTablesPlanned(...)` (חדש, מיוצא) מחזיר `{ snapshot, outboxPositions? }`. `cloneSnapshotForTables` נשארה עטיפה זהה בחתימתה.
- `cloneTrackedRowsFull` — המעבר המלא המקורי, הופרד לפונקציה בלי שינוי לוגי.
- `getOutboxIndex` — אינדקס `id→מיקום` ב-`WeakMap` לפי המערך החי (ה-outbox מצטבר רק בהוספה בסוף).
- `cloneOutboxRowsFast` — `previous.slice()` ושכפול רק של השורות המסומנות, מוצבות **במיקומן החי**. כל ספק (מזהה לא נמצא, שורה חדשה שלא סומנה, אי-יישור מול העותק הקודם, דגימה אקראית של מזהים, כפילות מזהה) מחזיר `null` וחוזר למעבר המלא.
- בדיקת צל כל `OUTBOX_SNAPSHOT_SHADOW_EVERY` אצוות (ברירת מחדל 50), **לפני** `writeSnapshotDelta`. באי-התאמה: כותבים את העותק המלא, מדפיסים `[SNAPSHOT_FAST_MISMATCH]`, ומכבים את המסלול המהיר בתהליך (`outboxFastDisabled`).
- `writeSnapshotDelta(..., outboxPositions?)` ← `syncOutboxMessagesDelta(..., positions?)` ← `syncRowsDeltaTracked(..., positions?)`. המיקומים עוברים כפרמטר מפורש (בלי Symbol). אימות יישור (גודל, `next >= prev`, התאמת מפתחות, מספר ההוספות) **לפני הכתיבה הראשונה**; בכל ספק — מסלול ישן.
- מכוסה רק `outboxMessages`. אינדקסים של Storage ו-retention מחוץ להיקף, בכוונה (סבב נפרד).

### יישום שלושת שינויי התכנון שדרשת
| דרישה | איפה |
| --- | --- |
| שורות חדשות מוצבות לפי מיקום חי, לא לפי סדר סימון | `cloneOutboxRowsFast`; בדיקה 3 |
| ספק בסדר ← מעבר מלא; בדיקות reorder/replace באותו אורך | בדיקות 5 ו-6 |
| צל לפני הכתיבה, כתיבת העותק המלא באי-התאמה, מיקומים כפרמטר מפורש | שורות ~603–613 ב-`database.ts` |

## 4. בדיקות
- **חדש:** `scripts/test-snapshot-fast-path.js` (`npm run test:snapshot-fast-path`, נוסף ל-`scripts/regression-manifest.txt`): 25 seeds אקראיים של הוספה/עדכון/אצווה שנכשלה, ועוד תרחישים: שימוש במסלול המהיר, סדר סימון שונה מסדר הוספה, שורה חדשה לא מסומנת, reorder פנימי, החלפה באותו אורך, מחיקה, כשל COMMIT + restart + retry, דגל כבוי. ה-mock מדמה את טבלת `outbox_messages` עם סמנטיקת טרנזקציה אמיתית, וכל צעד משווה snapshot וטבלה לנתונים החיים. עבר 5 ריצות רצופות.
- **קיימות:** outbox, postgres-dirty-tables, row-snapshot, attempts, uncertain, delta, no-lost-writes, transactions, burst, evidence, delivery-recovery — עוברות, גם עם `OUTBOX_SNAPSHOT_FAST=1` וצל על כל אצווה, מול PostgreSQL מקומי.
- **מגבלה:** ה-mock של pg מדמה רק את `outbox_messages`; טבלאות אחרות מוחזרות ריקות. הבדיקה לא מוכיחה התנהגות מול PostgreSQL אמיתי תחת עומס. זה כוסה ברצות הסימולטור (§5, §6).

## 5. תוצאות מדידה (מקומי)

### ניסוי הגדילה, 1,000 ← 20,000 שורות
| מדד | לפני | אחרי |
| --- | --- | --- |
| חסימה סינכרונית לאצווה | 2.0 ← 22.4ms (×11) | 0.2 ← 0.5ms |
| commit p50 | 2 ← 15ms | 2 ← 2ms |
| העברת שער←לקוחה p50 / p95 / p99 | 10/19/27 ← 63/198/287ms | 12/26/35 ← 17/57/94ms |
| המתנה לחריץ p95 | 4 ← 77ms | 5 ← 11ms |
| השהיית סטטוסים ללקוחה p50 | 8 ← 123ms | 8 ← 16ms |
| תגובה ראשונה p50 | 1550 ← 1709ms | 1559 ← 1590ms |

תגובה ראשונה השתפרה רק כ-7%, בתוך רעש של 10–20% בין ריצות — לא להסתמך עליה. אפס `SNAPSHOT_FAST_MISMATCH`, אותו סט כשלי SLO/ביקורת מוכרים (5) כמו בבסיס, אפס הודעות אבודות או כפולות בריצה בלי תקלות.

### `--preset catastrophe` (scale 0.25, 5 לקוחות, כפתורים חתומים), 3 ריצות לכל צד
| ריצה | lost | duplicate | reordered | short |
| --- | --- | --- | --- | --- |
| fast1 | 80 | 3 | 1 | 28 |
| fast2 | 81 | 0 | 0 | 26 |
| fast3 | 79 | 0 | 0 | 26 |
| base1 | 101 | 0 | 0 | 27 |
| base2 | 80 | 1 | 0 | 26 |
| base3 | 81 | 2 | 1 | 28 |

- כפילויות וסידור מופיעים בשני הצדדים (עם דגל: 1 מתוך 3 ריצות; בלעדיו: 2 מתוך 3). כולם מסווגים "שליחה חוזרת אחרי ניסיון שנענה בהצלחה, בלי תקלה מוזרקת שמסבירה" — המנגנון המוכר של הריגה בין קבלת Meta לרישום `sent` (CLAUDE.md מגבלה 6).
- הודעות אבודות ≈ 80 בשני הצדדים (חריגה: base1 עם 101).
- `SNAPSHOT_FAST_MISMATCH`: אפס. נבדק בריצות fast2 ו-fast3 (צל על כל אצווה). ל-fast1 לא ספרתי שוב מהלוג; נבדק כשרצה.
- **הסתייגויות:** n=3 לכל צד, אין הוכחה סטטיסטית שהדגל "ניטרלי", רק שלא נראה הבדל. שני תרחישי תקלה (`idle1`, `idle2`) לא רצו בכלל בגלל 5 לקוחות ("selector not found") — זהה בכל הריצות. התרחיש חלש יותר ממה ששמו מרמז.
- כל הריצות נכשלות באימות המחמיר (קוד יציאה 1) גם בבסיס. זה צפוי בתרחיש הריגה.
- תיקון כלי (לא קוד ייצור): ב-`scripts/measure-peak-3campaigns.js` נוספו `on('error')` ל-3 pools, כי `db-outage` הפיל את התהליך בשני המצבים.

## 6. מה לא נבדק
- מדידה בייצור. אין עדיין נתוני event-loop lag או `snapshot_ms` בייצור, וההאטה שם גדולה פי ~10 מהניסוי.
- התנהגות מול outbox גדול מ-20,000 שורות.
- דגל דולק מול כמה תהליכים שחולקים אותו outbox (הנחת המסלול: תהליך כותב יחיד לכל לקוחה).
- Storage lookup indexes ו-retention (בכוונה מחוץ להיקף).

## 7. תוכנית פריסה מוצעת (לאישורך; הפריסה עצמה בידי המשתמש)
1. commit סלקטיבי של קבצי התיקון בלבד: `src/database.ts`, `scripts/test-snapshot-fast-path.js`, שורת `package.json`, `scripts/regression-manifest.txt`, מטפלי השגיאה ב-`scripts/measure-peak-3campaigns.js`, מסמכי התוצאות. קבצים אחרים בעץ שייכים לעבודות אחרות.
2. **הדגל כבוי בפריסה הראשונה.** הקוד מגיע לייצור כשהוא לא פעיל.
3. פריסה משולבת עם דוח העלויות (committed ב-`652db0e`, מקומי בלבד): השער ← לקוחה קטנה אחת ← שאר הלקוחות ← הלקוחה הגדולה אחרונה. רק בחלון שקט, אחרי בדיקת `/health` שאין קמפיין פעיל. "Deploy" ולא "Redeploy".
4. אחרי יציבות: הדלקת `OUTBOX_SNAPSHOT_FAST=1` על לקוחה קטנה אחת (env + Deploy נוסף), מעקב אחר `[SNAPSHOT_FAST_MISMATCH]`, ורק אז הרחבה.
5. הוספת מדדי event-loop lag ו-`snapshot_ms` לייצור כדי למדוד את ההשפעה האמיתית.

**לא לפרוס לפני** שהקמפיין הקטן (7330b047) רץ ועברו 24 שעות ממנו.

## 8. שאלות ספציפיות
1. האם דגימת המזהים האקראית ב-`cloneOutboxRowsFast` מספיקה כשער נוסף מעבר לצל (שרץ רק כל 50 אצוות בברירת המחדל)? האם להוריד את ברירת המחדל של `OUTBOX_SNAPSHOT_SHADOW_EVERY` בהדלקה הראשונה בייצור?
2. כיבוי המסלול ל-`outboxFastDisabled` הוא בתהליך בלבד ונעלם ב-restart. האם מקובל, או שצריך להתריע (`notifySystemAlert`) באי-התאמה ראשונה?
3. האם להפריד את ה-commit של דוח העלויות מה-commit של התיקון (מומלץ מבחינתי: שני commits נפרדים, פריסה משולבת)?
4. האם ריצות ה-catastrophe מספיקות כראיה, או שנדרש seed קבוע / n גדול יותר לפני הפריסה?

## 9. קבצים
- קוד: `src/database.ts`
- בדיקה: `scripts/test-snapshot-fast-path.js`, `package.json` (`test:snapshot-fast-path`), `scripts/regression-manifest.txt`
- כלי מדידה: `scripts/measure-peak-3campaigns.js`, `scripts/experiment-outbox-growth.js`
- תוכנית ואישור קודם: `docs/outbox-write-path-fix-plan-for-codex-2026-11-08.md` (§10)
- ניסוי וממצאים: `docs/outbox-growth-experiment-2026-11-08.md`, `docs/accumulating-slowdown-big-launch-2026-11-08-for-codex.md`
- תוצאות מפורטות: `docs/outbox-write-path-fix-results-2026-11-08.md` (עדיין מציג n=1 ל-catastrophe; הנתונים העדכניים במסמך הזה)
- נתוני ריצה גולמיים: `docs/results-data/peak-cat-{fast,base}{1,2,3}-*.json` ו-`outbox-growth-experiment-fix1.json` (לא ב-git)
