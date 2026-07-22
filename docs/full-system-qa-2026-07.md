# תוכנית QA מלאה לסיום שדרוג PostgreSQL ויציבות הקמפיינים

עודכן: 22 ביולי 2026

## מטרה

מסמך זה מיועד להרצה על ידי סוכן בדיקות נוסף, כולל GPT-5.5. המטרה היא להוכיח שהמערכת שומרת נתונים ב-PostgreSQL, מתאוששת מכשלים, אינה מכפילה פעולות ואינה חוזרת לתקלות flow, כפתורים, timeout ו-Unicode.

המסמך אינו אישור אוטומטי ל-Deploy. אין לשנות לקוח פעיל, domain, webhook, Meta, Twilio או `DATABASE_URL` של Production ללא אישור מפורש ובדיקת rollback.

## כללי בטיחות

1. להתחיל בבדיקות מקומיות.
2. בדיקות PostgreSQL הרסניות ירוצו רק מול host מקומי ומסד ששמו כולל `test`.
3. בדיקות Dokploy ירוצו תחילה עם mocks או באפליקציית בדיקה מבודדת.
4. לפני restart או fault injection יש לוודא שזה לקוח ניסוי ללא קמפיין ציבורי פעיל.
5. אין לגעת ב-`client-account-fce3d086` ללא אישור מפורש נפרד.
6. אין להשתמש ב-`db:migrate:force` ללא snapshot, השוואת counts ואישור.
7. אין להציג בדוח passwords, tokens או `DATABASE_URL` מלא.

## תנאי פתיחה

- branch ו-commit מתועדים.
- dependencies מותקנים ו-PostgreSQL מקומי ייעודי זמין.
- אין תהליך בדיקה ישן על אותו port או database.
- לבדיקת E2E קיים לקוח ניסוי חדש עם PostgreSQL, מספר בדיקה וקמפיין שאינו פעיל לציבור.
- נשמרו snapshot JSON ו-export PostgreSQL לפני cutover.

## שלב 1 - רגרסיה מקומית

```powershell
npm run build
npm run test:flow-recovery
npm run test:flow-concurrency
node scripts/test-campaign-data-reset.js
node scripts/test-meta-contact-payload.js
node scripts/test-meta-gateway-reliability.js
node scripts/test-meta-campaign-routing.js
npm run test:outbox-claim
npm run test:outbox-durability
npm run test:dokploy-provisioner
```

תנאי מעבר: כל הפקודות מסיימות exit code 0. כשל מתוכנן שמופיע בלוג של בדיקת concurrency מותר רק אם הבדיקה עצמה מסתיימת ב-PASS.

## שלב 2 - PostgreSQL מקומי

```powershell
$env:TEST_DATABASE_URL="postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test"
npm run test:postgres-delta
npm run test:postgres-burst
npm run test:migration-safety
```

יש לאמת:

- snapshot והטבלאות הנגזרות מכילים אותם נתונים.
- הוספה אינה משכתבת רשומה שלא השתנתה.
- עדכון ומחיקה משתקפים בשני הייצוגים.
- 2,000 כתיבות אינן יוצרות יותר מ-snapshot ממתין אחד.
- `pendingWrites` חוזר ל-0.
- import זהה מדולג ו-import שונה נחסם ללא force.
- export אינו דורס קובץ קיים ללא force.

## שלב 3 - Unicode ו-JSON

בדיקת PostgreSQL חייבת לכסות:

- high-surrogate בודד מוסר.
- low-surrogate בודד מוסר.
- NUL מוסר.
- emoji, עברית ואנגלית תקינים נשמרים.
- הערך נשמר גם ב-`app_state` וגם בטבלת ה-`jsonb` הנגזרת.
- `storage.ready` נשאר true וה-`pendingWrites` חוזר ל-0.
- אין `22P02`, `json_errsave_error` או `invalid input syntax for type json`.

## שלב 4 - provisioning ללקוח חדש

יש לאמת ב-mock ולאחר מכן בלקוח ניסוי:

- נוצר PostgreSQL ייעודי.
- PostgreSQL נפרס לפני אפליקציית הלקוח.
- `DATABASE_URL` נשמר בסביבה ואינו נחשף ב-Owner API.
- volume, domain, application ו-database ייעודיים לאותו לקוח.
- אפליקציה קיימת ללא PostgreSQL metadata אינה נפרסת בטעות.
- הרצה חוזרת לאחר כשל חלקי אינה יוצרת app או database כפולים.

## שלב 5 - E2E של קמפיין

להפעיל קמפיין ניסוי ולבדוק:

1. טריגר טקסט רגיל.
2. flow עם שאלת שם ו-flow ללא שאלת שם.
3. בחירה במספר, בטקסט ובכפתור Meta.
4. title ארוך ש-Meta מקצרת ל-20 תווים.
5. שתי לחיצות מהירות על אותו כפתור.
6. תשובה לא חוקית והצגת השאלה מחדש.
7. timeout קצר ותשובה תקפה אחריו.
8. כשל שליחה מתוכנן ולאחריו retry.
9. ניקוד, raffle entry ו-step event נוצרים פעם אחת.
10. טקסט, תמונה, וידאו, PDF וכרטיס איש קשר.
11. referral link וקוד `ref:<CODE>`.
12. Excel והצלבת totals עם PostgreSQL.

תנאי מעבר: אין `STATE_MISS` לא מוסבר, participant כפול, event כפול או flow שנעצר אחרי בחירה תקפה.

## שלב 6 - restart והתאוששות

לבצע רק בלקוח ניסוי:

1. לעצור כאשר משתמש ממתין בשאלת decision.
2. להעלות ולאמת pending conversation ו-timer משוחזרים.
3. לחזור בזמן pre-name, name, wait-reply, contact-card confirmation ו-handoff.
4. לעצור לאחר כניסה ל-Outbox ולפני אישור provider.
5. להעלות ולוודא שליחה לכל היותר פעם אחת.
6. לעצור בזמן timeout ולוודא שטיימר ישן אינו מוחק מצב חדש.
7. לחזור בזמן שליחת מדיה איטית.

תנאי מעבר: אין אובדן pending, שליחה כפולה או ניקוד כפול, וכל כשל נראה ב-health או בלוג.

## שלב 7 - עומס

תרחיש מינימום:

- ארבעה קמפיינים במקביל בסביבת ניסוי.
- 100 משתמשים מדומים, ולאחר הצלחה 300.
- 20% שולחים שתי תשובות כמעט במקביל.
- 10% עוברים timeout וחוזרים.
- latency של 0.5-3 שניות בשליחה.
- 5% כשלי שליחה מדומים עם retry.
- שילוב טקסט, כפתורים ומדיה.

למדוד:

- storage ready, pendingWrites ו-lastError.
- Outbox pending/processing/sent/failed.
- active queues, serialized waits ו-max queue depth.
- זמני תגובה p50, p95 ו-p99.
- CPU וזיכרון container.
- counts של results, events, raffle entries ו-saved contacts.

תנאי מעבר:

- אין crash או restart לא מתוכנן.
- `pendingWrites` חוזר ל-0.
- אין processing מעבר לזמן stale lock.
- אין אובדן תוצאות או dedupe כפול.
- כל retry מסתיים ב-sent או ב-failed מתועד.

## שלב 8 - health וקבלה

ב-container ללא curl:

```bash
node -e "fetch('http://127.0.0.1:3001/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"
```

תנאי קבלה:

- `ok: true`
- `storage.enabled: true`
- `storage.ready: true`
- `storage.pendingWrites: 0`
- `storage.lastError` ריק
- counts תואמים למקור ולפעולות הבדיקה
- Outbox אינו מכיל processing תקוע
- Provider ready בהתאם למסלול

לבדוק שוב לאחר 10-20 שניות ולא להסתפק בקריאה אחת.

## שלב 9 - rollback drill

בסביבת ניסוי:

1. export מ-PostgreSQL לנתיב חדש.
2. השוואת counts ו-hash ל-snapshot.
3. export שני נחסם ללא force.
4. clone זמני עולה מה-JSON המיוצא עם health ו-counts תקינים.
5. זמן ההתאוששות מתועד.

אין להסיר `DATABASE_URL` מלקוח שקיבל כתיבות Production לפני export ופיוס.

## חסמים לאישור

התוצאה היא BLOCKED אם קיים אחד מאלה:

- `storage.ready: false` או PostgreSQL error.
- `pendingWrites` אינו חוזר ל-0.
- שגיאת Unicode/JSON או `22P02`.
- אובדן pending לאחר restart.
- שליחה, ניקוד, raffle entry או result כפולים.
- כפתור תקף שאינו מתקדם.
- פער counts בין `app_state`, הטבלאות וה-export.
- container restart לא מוסבר או עלייה מתמשכת בזיכרון.

## פלט חובה

הדוח הסופי יכלול:

- branch ו-commit.
- סביבת הבדיקה והלקוח ללא secrets.
- כל פקודה, PASS/FAIL וזמן.
- before/after של health.
- counts של JSON, PostgreSQL ו-export.
- עומס: משתמשים, הודעות, p95, CPU, memory ומשך.
- restart ו-fault injection.
- לוגים חריגים.
- פערים שנותרו וחומרתם.
- החלטה: `APPROVED`, `APPROVED WITH LIMITATIONS` או `BLOCKED`.

## מצב ידוע לפני ההרצה

נכון ל-22 ביולי 2026, build ועוד 12 בדיקות מקומיות עברו. PostgreSQL שמר 2,000 כתיבות, ומטריצת Unicode הפגום עברה. טרם בוצעו restart אמיתי, עומס E2E של 100-300 משתמשים ו-rollout מלא לכל הלקוחות.
