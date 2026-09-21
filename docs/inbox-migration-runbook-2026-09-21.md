# הוראות פריסה ומיגרציה של ה-Inbox (שלב E) — 2026-09-21

מסמך תפעולי. **לא בוצעה שום פריסה או מיגרציה.** הכלי נבדק מקומית מול PostgreSQL 18.6 (`flowsbiz_inbox_test`). פריסה ומיגרציה בייצור = הרשאה נפרדת.

---

## ⚠️ 0. הערות פריסה שחייבות להופיע כאן (לפי בקשתך)

### 0.1 `conversation-state.json` יישאר על השרת ויפסיק להתעדכן (מצב PostgreSQL)
מהגרסה הזו, בלקוח שרץ על **PostgreSQL** שיחות ממתינות נשמרות **רק** בטבלת `conversation_state`; הקוד **לא כותב יותר** ל-`./data/conversation-state.json` ולא קורא ממנו (ב-`restore`).
- **הקובץ שכבר קיים על השרתים לא נמחק** — הוא נשאר כפי שהיה ביום השדרוג, **ולא יתעדכן עוד**.
- **מי שיפתח אותו ידנית יראה קובץ ישן, ועלול לחשוב שהמערכת תקועה או שהשיחות "נעלמו". זה לא נכון:** המצב האמיתי נמצא ב-PostgreSQL (`select count(*) from conversation_state`) ובדשבורד (`/health` → `conversations.pending`).
- אין צורך למחוק אותו. אם רוצים לצפות בשיחות: `npm run db:export` (מייצא מה-DB), לא את הקובץ.
- גיבויים: תצורת הגיבוי שמפרטת `volumes.conversationState` ממשיכה לעבוד (volume חסר נרשם כ-`missingVolumes` ואינו מכשיל); ה-dump של PostgreSQL הוא מקור השחזור.
- מצב **JSON** (לקוחות ללא PostgreSQL): ללא שינוי — הקובץ הוא מקור האמת.

### 0.2 מקרה פתוח שנשאר ברשימה (לא נשכח)
**תשובה להחלטה שפגה כשהקמפיין נמחק — חוזרת בשקט**, בלי תגובה למשתתף ובלי רישום (`messageFlow.ts` ~שורה 1447: `if (campaign) await sendBotMessage(...staleFlowReplyText...); return;`). זו **החזרה השקטה היחידה שנותרה** אחרי C3 (טריגר שפג כבר נכנס ל-`review`). מקרה נדיר וקטן; לא שונה בכוונה; **נשאר ברשימת הפתוחים** (ראה §6) עד החלטה אם לרשום אותו כתוצאת `review` או כהודעה קבועה למשתתף.

---

## 1. סדר הפעולות (לכל Inbox: שער / כל לקוח)

**עקרונות:** הכלי נותן dry-run בלי שינוי כלשהו; גיבוי מאומת לפני כל כתיבה; אימות ספירות ותוכן **לפני** הפעלה; המקור **לא נמחק** לעולם; ותוכנית חזרה שלא מאבדת הודעות.

### שלב א — הכנה (חובה לפני הפעלת PostgreSQL)
1. שער: להקים PostgreSQL ייעודי (שירות נפרד; גיבוי; דיסק). להגדיר `INBOX_DATABASE_URL`. לקוח: אפשר `DATABASE_URL` שלו (טבלאות `inbox_*` נפרדות).
2. **אל** להפעיל עדיין `INBOX_BACKEND=postgres`: ה-startup guard מסרב להפעיל PostgreSQL מעל קובץ JSON שלא הועבר (כדי שלא יתעלם ממנו בשקט).

### שלב ב — dry-run (לא משנה כלום)
```bash
node scripts/inbox-migrate.js dry-run --role client --source-file /data/meta-client-inbox.json --database-url "$INBOX_DATABASE_URL"
```
מדווח: ספירות לפי סטטוס, פריטים שחסרה להם זהות (`phone_number_id`), **כפילויות** (זהות זהה — לא נבחר "מנצח"), timestamps לא תקינים, payload פגום, ואיך `processing` יסווג (לקוח → `review`, **לא** ירוץ שוב; שער → `retry` מיידי). קורא את היעד רק ב-transaction `READ ONLY`. **הוכח בבדיקה:** אף בייט בקובץ/בתיקייה/בטבלאות (insert/update/delete) לא משתנה. `apply` **מסרב** אם יש בעיה חוסמת (`blocking > 0`).

### שלב ג — apply (בחלון שקט)
1. לעצור **כל** כותב של ה-inbox (workers וקבלות HTTP) ולהמתין; הכלי בודק שהקובץ שקט ומסרב אם הוא זז.
2. `node scripts/inbox-migrate.js apply --role client --source-file ... --backup-dir /backups/inbox --confirm-stopped`
3. הכלי: גיבוי immutable + `sha256` (מאומת בקריאה חוזרת) → ledger `importing` → batches טרנזקציוניים ואידמפוטנטיים → שורות scheduler → **אימות**: ספירות לפי סטטוס, digest של (זהות, סטטוס, attempts, סדר, payload קנוני) מול המקור, ואינווריאנטות → **רק אז** הפעלה: קובץ marker `.sql-active`, שינוי שם המקור ל-`.migrated-<ts>` (**לא נמחק**), ורשומת `inbox_meta`.
4. קריסה באמצע (בכל batch): המקור לא נגע, אין marker, ה-ledger `importing`; **להריץ שוב את אותה פקודה** — ממשיך בלי כפילויות (נבדק בכל checkpoint).
5. רק אחרי `imported, verified and activated` להפעיל `INBOX_BACKEND=postgres`.

### שלב ד — חזרה (rollback)
| מצב | מה קורה |
|---|---|
| **SQL לא עבד עדיין** (הנתונים זהים לייבוא) | `rollback --confirm-stopped`: הקובץ המקורי (`.migrated-*`) מוחזר **בייט-בייט** (נבדק sha מול הרישום), ה-marker נמחק, `inbox_meta=json`. שורות ה-SQL נשארות לביקורת |
| **SQL כבר קיבל/עיבד עבודה** | `rollback` **מסרב** ("would LOSE it") — חזרה לקובץ הישן הייתה מאבדת הודעות חדשות ומריצה מחדש הודעות שכבר טופלו. במקום: `export --out FILE --confirm-stopped` (קובץ בפורמט הישן עם **כל** ההודעות, מאומת: זהויות + ספירות), ואז `rollback --use-export FILE`. פריט `review` מיוצא כ-`failed` עם סיבה `[REVIEW:...]`; `processing` בשער ⇒ `retry`, בלקוח ⇒ `failed`+סיבה (לא ירוץ שוב) |
**נבדק:** בשני המקרים אף הודעה לא אבדה (השוואת קבוצת מזהים מלאה).

### שלב ה — ללא שני כותבים
- `INBOX_BACKEND=json` כשקיים `.sql-active` ⇒ ההפעלה **נכשלת בקול**.
- `INBOX_BACKEND=postgres` כשקיים קובץ JSON לא-ריק שלא הועבר ⇒ ההפעלה **נכשלת בקול**.
- אין dual-write.

## 2. משתני סביבה
ראה `docs/stage-e-c3-results-2026-09-21.md` §0 (`INBOX_BACKEND`, **`INBOX_DATABASE_URL`**, `INBOX_NAMESPACE`, `INBOX_DB_POOL_MAX`, `INBOX_LEASE_MS`, `INBOX_DEDUPE_DAYS`, `INBOX_PAYLOAD_RETENTION_DAYS`, `INBOX_SHUTDOWN_WAIT_MS`, `INBOX_GATEWAY_REQUIRED`).

## 3. פריטים שדורשים תשומת לב אחרי המעבר
- **review מוצג עכשיו:** `GET /api/inbox/review` (לקוח) ו-`GET /owner/api/inbox/review?role=gateway|client` (בעלים): סטטוס, סיבה, טלפון השולח, תצוגה מקדימה של הטקסט (**לא** ה-payload), דפדוף. פתרון: `POST /api/inbox/review/resolve` / `/owner/api/inbox/review/resolve` עם `action` **מפורש** (`requeue`|`discard`, אין ברירת מחדל). פריט "עמום" (worker מת אחרי שייתכנו אפקטים) מוחזר לתור **רק** עם `acknowledgeDuplicateRisk:true`. כל פעולה נרשמת ב-`inbox_admin_audit`.
- התראות: `inbox-ambiguous-<id>`, `inbox-stale-trigger`, `inbox-store-failed`, `inbox-db-unavailable`, `inbox-oldest-due-critical-<role>` (מעל 120s).

## 4. מה **לא** נעשה ב-C5
מיגרציה בפועל בייצור; אימות מול גדלי קבצים אמיתיים בייצור; מיגרציה של `conversationState` (אינה נחוצה — כבר בשורות ה-DB).

## 5. בדיקות
`scripts/test-inbox-migration-postgres.js` (10 תרחישים, PG אמיתי) + מוטציות `MUT_SET=mig` 8/8 (גיבוי, אימות, דריסת קונפליקט, rollback אחרי עבודה, מחיקת מקור, guard, זיהוי כותב פעיל, dry-run שכותב).

## 6. רשימת פתוחים (לא נשכחת)
1. **תשובה להחלטה שפגה + קמפיין שנמחק — חוזרת בשקט** (§0.2).
2. קבצי `conversation-state.json` ישנים על השרתים (§0.1) — הערת פריסה.
3. משלוח אימייל התראה בפועל לא נבדק (רק הקריאה ל-`notifySystemAlert`).
4. מיגרציה בייצור — הרשאה נפרדת.
