# מדריך: הורדת לוג מלא של לקוחה ושל השער, והשוואה ביניהם (לכל קמפיין)

נבנה אחרי השקת פוקוס (17–19.10.2026), ומיועד לשימוש חוזר בקמפיינים גדולים. כל הדוגמאות מניחות Windows עם Git Bash, ומפתח SSH ב-`~/.ssh/flowsbiz_hetzner_ed25519`.

> **חשוב: להוריד לפני כל פריסה או הפעלה מחדש.** לוגים של Docker שייכים למשימה (task) של השירות. כשהקונטיינר מוחלף (Deploy, Redeploy, אתחול שרת) הלוג שלו נעלם. בפוקוס, אחרי הפריסה ואחרי כיבוי השרת, הלוג של הלקוחה התחיל רק מ-15:05 UTC ב-18.10, ולא הייתה דרך לנתח את 08:47–15:05. לכן: להוריד לפני כל פריסה, ובקמפיין גדול גם פעם ביום.

## 1. למה לא מדשבורד Dokploy

ה-UI של Dokploy מאפשר הורדה של עד 5,000 שורות אחרונות בלבד. לקמפיין גדול זה מכסה דקות. לא להשתמש בקבצים כאלה לספירת משתתפות או לזמנים (בפוקוס הם הובילו לספירה שגויה).

## 2. הורדה מלאה דרך SSH

שמות השירותים (Swarm):

| מה | שם השירות |
| --- | --- |
| השער (שירות המנהל) | `flowsbiz-admin-akr2zu` |
| לקוחה | `client-<שם>-<מזהה>-app-<סיומת>`, לדוגמה `client-pvkvs-meta-4b004adb-app-myieti` (פוקוס) |

לראות את הרשימה: `ssh ... "docker service ls --format '{{.Name}}'" | grep app`.

```bash
D="C:/Users/haim/Downloads/campaign-evidence-$(date +%Y%m%d)"; mkdir -p "$D"; K=~/.ssh/flowsbiz_hetzner_ed25519
# לקוחה: כל הלוג מ-N שעות אחורה, עם חותמות זמן, בלי תחילית הקונטיינר
ssh -i $K root@169.58.236.130 "docker service logs --timestamps --since 30h client-pvkvs-meta-4b004adb-app-myieti 2>&1" \
  | sed -E 's/^([0-9T:.Z-]+) [^ ]+ +\| /\1 /' > "$D/client.txt"
# השער
ssh -i $K root@169.58.236.130 "docker service logs --timestamps --since 30h flowsbiz-admin-akr2zu 2>&1" \
  | sed -E 's/^([0-9T:.Z-]+) [^ ]+ +\| /\1 /' > "$D/gateway.txt"
wc -l "$D"/*.txt; head -n1 "$D/client.txt" | cut -c1-40   # לוודא שהשורה הראשונה מתחילה מתי שרצוי
```

בדיקות אחרי ההורדה:
- **השעה בשורה הראשונה:** אם היא מאוחרת מההשקה, חלק מהלוג כבר נמחק (ראו האזהרה למעלה).
- **גודל:** לוג השער של קמפיין גדול הוא עשרות MB, וזה תקין. לוג שמלא ב-`META_ROUTES_CACHE_REFRESH_FAILED` מעיד על תקלת לקוחות.
- הקבצים כוללים מספרי טלפון. **לא לקומט.** לשמור בתיקיית Downloads או בכונן מקומי.

## 3. ההשוואה בין הלקוחה לשער

מפתח ההצלבה הוא ה-`wamid` של כל הודעה נכנסת: השער רושם `META_GATEWAY_INBOUND` ו-`META_GATEWAY_ROUTED`, והלקוחה רושמת `META_INBOUND`.

```bash
# הצלבה הודעה-הודעה + טבלת זמנים
node scripts/compare-gateway-client.js <client.txt> <gateway.txt> <clientIdPrefix> <launchIsoUtc>
# דוגמה (פוקוס): node scripts/compare-gateway-client.js client.txt gateway.txt 4b004adb 2026-10-17T16:35:00Z
# מגמה לאורך זמן, הפעלות מחדש ונפילות
node scripts/analyze-focus-failures.js <client.txt> <gateway.txt>
# ניתוח השקה מלא (משתתפות, שלבים, פסקי זמן, כשלים)
node scripts/analyze-focus-launch.js <client.txt> <gateway.txt> <out-file>
# פרמטרים לסימולטור מתוך לוג אמיתי (זמן חשיבה, השהיות, קצב כניסות)
node scripts/calibrate-from-launch-log.js <client.txt> <launchIsoUtc>
```

כל הסקריפטים ניתנים להתאמה לקמפיין אחר בעזרת משתני סביבה (ברירת המחדל היא פוקוס):

| משתנה | מה הוא קובע |
| --- | --- |
| `CAMPAIGN_CLIENT_ID` | תחילית מזהה הלקוחה (`analyze-focus-launch.js`) |
| `LAUNCH_UTC` | שעת ההשקה ב-UTC (`analyze-focus-failures.js`) |
| `LAUNCH_DAY` | יום ההשקה (`analyze-focus-launch.js`) |
| `TEST_PHONES` | מספרים שיוצאים מהספירה (בדיקות, הבעלים, הלקוחה), מופרדים בפסיק |

### מה ההשוואה מראה

| שאלה | איך עונים |
| --- | --- |
| האם הודעה אבדה בין השער ללקוחה? | כל wamid שנותב וגם נרשם אצל הלקוחה. בפוקוס: 2,501 מתוך 2,501, 0 אבדו |
| איפה הזמן? | פירוק: שער (קבלה ← העברה), תור לקוחה (העברה ← תחילת עיבוד), עבודה (עיבוד ← ההודעה הבאה התקבלה ב-Meta). בפוקוס: שער חציון 109ms, תור 10ms, עבודה כ-3.1 שניות (שליחת התמונה) |
| האם יש הידרדרות? | טבלה לפי שעה (שעון ישראל) של הטריגרים הראשונים |
| האם יש נפילות? | הפעלות מחדש, `failed` מ-Meta, שגיאות שליחה, `POSTGRES_BATCH_SLOW`, `FILE_DELIVERY_WAIT_TIMEOUT` |
| למה הודעה אטית? | הודעה חדשה מאותה משתתפת ממתינה עד שהקודמת תסיים, כולל השהיות מתוכננות של 30 ו-60 שניות |

### כללי מדידה (חשוב, כדי לא להסיק מסקנות שגויות)

- כל הלוגים ב-UTC. בדוחות להציג שעון ישראל (UTC+3 עד 25.10.2026, אחר כך UTC+2).
- זמן תגובה נמדד עד `status=sent` מ-Meta, לא עד שההודעה הוצגה אצל המשתתפת.
- לספור משתתפות ייחודיות לפי טלפון ולהוציא מספרי בדיקה.
- **להוציא חלונות תקלה** (למשל 18.10 14:30–18:50 UTC) משום שהם מעוותים את כל הסטטיסטיקה.
- כשמשווים בין קמפיינים או לינקים בתוך אותה לקוחה, להבחין בין ההבדל בזמני פתיחת הלינק (התפלגות כניסות) לבין ההבדל בביצועים.
- לא להשתמש בלוג שהורד מה-UI של Dokploy (5,000 שורות).

## 4. כשהלוגים נמחקו: ניתוח מטבלאות ה-PostgreSQL

לכל לקוחה יש `inbox_items` ו-`outbox_messages` עם חותמות זמן לכל הודעה, ולכן אפשר לנתח המתנה ועיבוד גם בלי לוג. (זמן שליחה ל-Meta לא נמדד כאן.)

```bash
ssh -i $K root@169.58.236.130 'pg=$(docker ps -q -f name=client-<שם>-postgres | head -1); docker exec -i $pg psql -U postgres' < query.sql
```

שאילתה לדוגמה, לפי שעה (שעון ישראל): כמות הודעות, המתנה בתור (p50/p90/p99) ועיבוד:

```sql
with m as (
 select date_trunc('hour', received_at at time zone 'Asia/Jerusalem') h,
        extract(epoch from (first_claimed_at - received_at))*1000 qms,
        extract(epoch from (completed_at - first_claimed_at))*1000 pms,
        payload->'entry'->0->'changes'->0->'value'->'messages'->0->>'type' typ
 from inbox_items
 where received_at >= '2026-10-17 15:00Z'
   and not (received_at >= '2026-10-18 14:30Z' and received_at < '2026-10-18 18:50Z')   -- להוציא חלון תקלה
)
select to_char(h,'MM-DD HH24:00') hour_il, count(*) n, count(*) filter (where typ='text') triggers,
  round(percentile_cont(.5) within group (order by qms)::numeric) q50,
  round(percentile_cont(.99) within group (order by qms)::numeric) q99,
  round(percentile_cont(.5) within group (order by pms)::numeric) p50,
  round(percentile_cont(.99) within group (order by pms)::numeric) p99
from m group by h order by h;
```

לבדוק גם כשלי שליחה: `select status, count(*) from outbox_messages group by status;` ואת `data->>'lastError'` של הכשלים (למשל `130429`/`131056`, שגיאות קצב של Meta).

טבלת ה-inbox של **השער** נמצאת בשירות `flowsbiz-flowsbizadmininboxpostgres-*` (`role='gateway'`), ומאפשרת למדוד את הניתוב לפי שעה באותו אופן.

## 5. רשימת בדיקה לקמפיין גדול

1. **יום לפני:** להוריד לוג בסיס (לראות שהכלי עובד).
2. **לפני כל פריסה:** להוריד לוג מלא של הלקוחה והשער.
3. **במהלך:** פעם בכמה שעות, `compare-gateway-client.js` על חלון הלוג האחרון.
4. **אחרי יום וחצי, ובסיום:** הורדה סופית, הפעלת שלושת הסקריפטים והשוואה לדוח הקודם.
5. **בתקלה:** קודם להוריד לוגים, אחר כך לתקן (לא להפעיל מחדש לפני כן).

## 6. ניטור זמינות (חדש, 19.10.2026)

כל הלקוחות והשער חושפים `GET /health` ללא התחברות. תקין: HTTP 200 וגוף שמכיל `"ok":true`. כשהשרת כבוי, או שירות לא עלה, מתקבל 502/ללא מענה. מומלץ ניטור **חיצוני** (שלא תלוי באותו שרת) שבודק את הכתובות האלה כל 1–5 דקות ושולח מייל.

כתובות (נכון ל-19.10.2026, כולן ענו 200):

```
https://admin.flowsbiz.com/health
https://client-pvkvs-meta-4b004adb.flowsbiz.com/health            (פוקוס)
https://client-shrh-lvy-meta-2e518fee.flowsbiz.com/health
https://client-bdykh-meta-c5c11caa.flowsbiz.com/health
https://client-gvs-plas-meta-17100356.flowsbiz.com/health
https://client-kvvyn-meta-34fb9db9.flowsbiz.com/health
https://client-meta-new-meta-8c3c6902.flowsbiz.com/health
https://client-boot-meta-9afdce0a.flowsbiz.com/health
https://client-yhvdyt-pytns-meta-3fe79d6d.flowsbiz.com/health
https://client-abygyl-bn-dvd-meta-c8c9c18e.flowsbiz.com/health
https://client-1-cab55e82.flowsbiz.com/health
https://client-account-fce3d086.flowsbiz.com/health
https://client-account-5ec279a8.flowsbiz.com/health
https://client-account-706d5db8.flowsbiz.com/health
https://client-account-7330b047.flowsbiz.com/health
https://client-account-a0effa14.flowsbiz.com/health
https://client-account-be61c10f.flowsbiz.com/health
https://client-account-1e970c66.flowsbiz.com/health               (Baileys)
https://client-abytl-tna-baileys-3ca22ac2.flowsbiz.com/health     (Baileys)
https://client-rvt-kmpyyn-baileys-807d5440.flowsbiz.com/health    (Baileys)
```

מגבלה: `/health` של לקוחה מראה שהאפליקציה חיה, לא שהיא מנותבת נכון משער. בדיקה של 0 הודעות מנותבות ב-X דקות עדיין דורשת התראה בשער (קיימת בקוד, לא אומתה מקצה לקצה).

## 7. כלי הזרמה מחדש להודעות שנכשלו

בתקלה של 18.10 הזרמתי מחדש 38 טריגרים שנכשלו (`INBOX_FAILED`) דרך ה-webhook החתום של השער, עם `wamid` וחותמת זמן חדשים, פעם אחת לכל מספר. הסקריפט היה חד-פעמי ולא נשמר בריפו. כדי לחזור על זה: לקרוא את הפריטים שנכשלו מ-`inbox_items` של השער (`status='failed'`), לסנן לפי ביטוי הטריגר, להשאיר טריגר אחד לכל מספר, להוציא מי שכבר קיבלה מענה, לחתום מחדש (`X-Hub-Signature-256` עם `META_APP_SECRET`), ולשלוח אחד כל 5 שניות. **קודם בדיקה על המספר שלך.** מתוכנן להפוך לכלי קבוע עם `--dry`.
