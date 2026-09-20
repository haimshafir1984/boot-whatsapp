# שלב A — גיבוי ושחזור: תוצאות (2026-09-20)

> **⚠ תיקון (2026-09-20) — מספרי ה-JSON במסמך זה אינם מייצגים ייצור.**
> מדידה על PostgreSQL אמיתי (לקוחות על PG; `LOAD_BACKEND=pg`, `docs/results-data/load-ab-pg-2026-09-20.json`, 5 ריצות נקיות לכל צד, mixed) מראה: **Focus 2,908ms · small-a 2,629ms · small-b 2,624ms** (HEAD). לעומת JSON: 6,091 / 12,822 / 13,463ms.
> כלומר **~13 השניות של הקמפיינים הקטנים היו ארטיפקט של backend ה-JSON של הפיקסצ'ר**; הפער "פי 2.1 בין הקטנים לפוקוס" התהפך (הקטנים מהירים יותר בכ-10%). גם הייחוס "96–98% מההמתנה בצד השער" היה שגוי: על PG חלק השער הוא **~59% אצל Focus ו-~84% אצל הקטנים**.
> מספרי ה-JSON מטה נשמרו כהיסטוריה — **אל תצטטו אותם כביצועי ייצור.**
> **סייגים גם למספרי ה-PG:** הפיקסצ'ר מקומי (לא חומרת ייצור), ועדיין **אינו מפעיל את ה-Outbox dispatcher**; השער בו עדיין JSON (כמו בייצור — אין לו שורות outbox).

HEAD `0ea8d26`; שינויים ב-working tree בלבד, **לא בוצע commit/push/פריסה**. `src/` לא שונה בשלב זה.
**סטטוס: קוד הכלי מוכן ונבדק חלקית. השער "גיבוי ושחזור מוצלחים בסביבה מבודדת" לא הושג — חסום: אין PostgreSQL/pg_dump בסביבה.**

## 0. מדידות baseline (שלב 0) — ראו `docs/baseline-2026-09-20/`

סבילות נקבעה מראש (`TOLERANCES.md`: חציון +10%, p95 +15%). כל 5 הריצות + warm-up ב-`BASELINE.md`. סיכום (חציון בין ריצות, ms):

| תרחיש/קבוצה | median (טווח) | p95 | p99 | max |
|---|---|---|---|---|
| single / focus (120) | 4765 (4634–4972) | 10744 | 11129 | 11134 |
| mixed / focus (100) | 6091 (5890–6165) | 7567 | 7686 | 7686 |
| mixed / small-a (25) | 12822 (12632–13129) | 13632 | 13642 | 13642 |
| mixed / small-b (25) | 13463 (13320–14745) | 13951 | 13960 | 13960 |
| mixed / baileys (60) | 1702 (1644–2118) | 1996 | 2019 | 2019 |

ממצא **[JSON בלבד — ארטיפקט; על PG: ~2.6s, ראו תיקון בראש המסמך]**: כבר ב-HEAD הקמפיינים הקטנים מחכים ~13s (פי ~2 מפוקוס); החציון המשולב מסתיר זאת. 2 מ-5 ריצות mixed יצאו exit 1 (ריצה 1: סף החציון המשולב 7043>7000, אומת; ריצה 4: סיבה לא אומתה).
**לא נמדדו** תרחישי 8.4 הבאים: בידוד A→B, תקלת לקוח, restart, DB outage, webhook כפול, הצטברות held, 20 דק'. חלקם ללא סקריפט ב-HEAD.
כלי מדידה: `scripts/test-load-shared-campaign-isolation.js` הורחב ב-p99 ובשורת `RESULT_JSON` לפי קבוצה (דיווח בלבד, ללא שינוי לוגיקה); `scripts/run-load-baseline.js`. הסקריפט הראשון אינו מנוהל ב-git (untracked כבר בהתחלה).

## 1. רגרסיה קיימת על HEAD (לפני כל שינוי קוד) — `docs/results-data/regression-head-baseline.json`

runner חדש: `scripts/run-regression.js` + `scripts/regression-manifest.txt` (49 סוויטות מהמסמך + `test-backup-tool.js`; ברצף, env מנוקה מסודות/DATABASE_URL, timeout 240s, JSON, ללא "ירוק" על SKIP/BLOCKED).

| תוצאה | ספירה | פירוט |
|---|---|---|
| PASS | 47 | |
| **SKIP-MARKER** | 1 | `test-silent-data-loss-fixes.js`: יצא 0 אך **7 בדיקות Postgres דולגו** (אין `TEST_DATABASE_URL`): backoff bounds, close()-during-backoff, mutation dirty-merge, backoff off-by-one, ו-3 בדיקות R2. |
| TIMEOUT | 1 | `test-referral-ranking.js`: מדפיס "tests passed" ואז **לא יוצא** (handle פתוח) — hang קיים ב-HEAD, לא קשור לשינוי שלי. |
| BLOCKED | 1 | `test-backup-tool.js` (הבדיקה החדשה, PG אמיתי) |

**לכן הטענה "49/49 עוברות" במסמך התכנון אינה מדויקת על סביבה זו:** בפועל 47 עברו מלא, אחת עברה חלקית (7 בדיקות PG דולגו), אחת נתקעת בסיום. הגדרתי אותם כ-baseline; כל כשל חדש אחריהם הוא רגרסיה.

## 2. דרישה → מימוש → בדיקה → תוצאה

| # | דרישה (סעיף 5) | מימוש | בדיקה | תוצאה |
|---|---|---|---|---|
| A1 | inventory לכל לקוח + אדמין, ללא הנחות על DATABASE_URL | `backup.js inventory` — מ-config; אדמין שורה נפרדת | לא נבדק אוטומטית | **חלקי:** מבוסס config; משיכה אוטומטית מ-Dokploy API **לא ממומשת** |
| A2 | dump PG עקבי, כלי רשמי לגרסה בפועל | `pg_dump --format=custom`; דורש major ≥ שרת (18) | fake-binary: גרסה ישנה נדחית; כלי חסר → שגיאה ברורה | צנרת עברה; **PG אמיתי: BLOCKED** |
| A3 | Volumes: קבצי אדמין, uploads, Inbox, מצב שיחות, סשני Baileys | tar לכל volume מוגדר; volume חסר מדווח ב-`missingVolumes` | round-trip byte-זהה, volume חסר, tampered | עבר (קבצים אמיתיים, tar אמיתי). **Inbox של השער** — אין נתיב מוגדר בקוד היום; להוסיף ל-config כשידוע |
| A4 | נקודת שחזור עקבית; לא לקרוא ל"אטומי" | `consistency` ב-manifest = `independent-timestamps-not-atomic` או `write-barrier-asserted-by-operator` (`--quiesced`) | נבדק | עבר. **מחסום כתיבה בפועל אינו ממומש** — הכלי רק רושם טענת מפעיל |
| A5 | manifest ללא סודות; הצפנה; credentials מ-env | AES-256-GCM לפני יעד; מפתח וסיסמת DB מ-env, סיסמה לא ב-argv | ciphertext בלבד ביעד; manifest ללא מפתח/סיסמה; סיסמה עוברת ב-env | עבר. הרשאות/הצפנה בצד היעד — תפעול |
| A6 | הפרדת created/transferred/verified; כשל גלוי | שלושה סטטוסים; העתקה נקראת בחזרה ומושווית ב-sha256 | יעד לא זמין → created=ok, transferred=failed + manifest מקומי | עבר. `verified` נשאר `not_run` — verify הוא פקודה נפרדת שאינה מעדכנת manifest (**פער**) |
| A7 | לא למחוק גיבוי תקין אחרון | `prune` שומר תמיד את האחרון התקין | 400 יום + 3 כשלים חדשים → שורד; thinning שעתי/יומי | עבר |
| A8 | מדיניות configurable | `retention`, `schedule` ב-config (48h/14d/8w; DB שעתי, קבצים יומי) | | עבר (קונפיג). **תזמון עצמו (cron/Dokploy schedule) לא ממומש** |
| A9 | restore ליעד מפורש ומבודד, מסרב למקור | `restore` דורש `--restore-dir` / env URL; מסרב חפיפה/מסד מקור; מסרב גיבוי שלא עבר verify; `--dry-run` | נבדק כולל dry-run שלא כותב | עבר. הכלי לא מפעיל שירותים ולא מחבר לספקים |
| A10 | התראות על כשל/איחור גם כש-scheduler לא רץ | `freshness` — פקודה חיצונית: exit 1 אם אין גיבוי תקין / ישן > תדירות×1.5 | ריק → לא תקין; טרי → תקין; מיושן → מסומן; כשל PG → לא תקין | עבר כלוגיקה. **מנטר חיצוני ושליחת התראה לא הוגדרו** — החלטת משתמש |
| A11 | בדיקות dump→upload→restore, השוואות, פגום, יעד לא זמין, דיסק מלא, סיסמה שגויה, retention, זמן שחזור | `scripts/test-backup-tool.js` | ראו למטה | **חלקי** |

### תוצאות `test-backup-tool.js`: pass=24 fail=0 **blocked=1** skip=0 (exit 3)

- **רצו באמת (קבצים):** round-trip byte-זהה, ciphertext ביעד, manifest ללא סודות, artifact פגום/חסר/manifest חסר, מפתח שגוי, היעדר מפתח (מסרב לא-מוצפן), יעד לא זמין, retention (שני מצבים), freshness (3 מצבים), restore dry-run + הגנת חפיפה.
- **fake-binary (צנרת בלבד, לא הוכחה ל-PostgreSQL):** סיסמה ב-env ולא ב-argv, סיסמה שגויה → created=failed, גרסה ישנה נדחית, כלי חסר, restore מסרב למסד המקור ומחייב URL מפורש.
- **BLOCKED — לא רץ:** dump אמיתי → העלאה → restore למסד חדש → השוואת ספירות/קשרים ודוגמאות campaign/result/context/held. **חסר:** PostgreSQL 18 (שרת + `pg_dump`/`pg_restore`). התקנה: להתקין PostgreSQL 18, ליצור שני מסדים ריקים, להגדיר `BACKUP_TEST_PG_URL` (מקור) ו-`BACKUP_TEST_PG_RESTORE_URL` (יעד ריק). גם אז — **קוד ה-seed וההשוואה עדיין לא נכתב**; ייכתב כשהתשתית זמינה.
- **לא נבדק כלל:** דיסק מלא (ENOSPC אמיתי), זמן שחזור DB (נמדד רק לקבצים), יעד מרוחק אמיתי.

## 3. פעולות שלא נעשו בייצור (במפורש)

לא הופעל גיבוי, לא נוצר יעד, לא נבדק גיבוי חיצוני קיים (ייתכן שיש — "אין גיבוי" נשען רק על ספריות ריקות בשרת), לא נגעתי בשרת/Dokploy/Meta.

## 4. נדרש מהמשתמש (בלי סודות בצ'אט)

1. אישור אם קיים גיבוי חיצוני שמושך מבחוץ (לפני מסקנות).
2. יעד גיבוי מחוץ לשרת ההרצה (mount/rclone/SFTP), הרשאות מצומצמות; מפתח הצפנה ב-secret store.
3. **התקנת PostgreSQL 18 מקומי** — לבדיקות A, ולשבע הבדיקות שדולגו ב-`test-silent-data-loss-fixes`. בלי זה גם בדיקות PG של B/C ייחסמו.
4. החלטה על תזמון (cron/Dokploy schedule) ועל מנטר חיצוני + נמעני התראות ל-`freshness`.
5. נתיבי volume ושמות DB לכל לקוח (config).

## 5. מוכן לפריסה?

**לא.** הכלי בדוק ברמת קבצים/צנרת, אך לא מוכח מול PostgreSQL אמיתי; אין תזמון, מנטר או יעד. סיום תפעולי (גיבוי ייצור מאומת) לא בוצע.
