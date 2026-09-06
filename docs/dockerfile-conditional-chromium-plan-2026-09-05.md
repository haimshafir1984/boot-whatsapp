# תוכנית: התקנת Chromium מותנית ב-Dockerfile (לא גורפת לכל לקוחה)

מסמך טכני לביקורת קודקס. נכתב אחרי בדיקה ישירה בייצור (SSH לשרת `vmi3533514`, לוגי build אמיתיים, `docker service inspect` על כל לקוחות Baileys הקיימות).

## הבעיה, עם ראיות

### 1. Chromium מותקן ללא תנאי, לכל לקוחה, בכל build

[Dockerfile:18-24](../Dockerfile#L18-L24):

```dockerfile
FROM node:20-slim
WORKDIR /app

# Chromium + fonts for Hebrew text rendering
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-ipafont-gothic \
  fonts-wqy-zenhei \
  fonts-freefont-ttf \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*
```

זו שכבת production-stage אחת, זהה לכל 13 הלקוחות בייצור (Meta ו-Baileys כאחד), ללא שום `ARG`/תנאי.

### 2. שום לקוח קיים בפועל לא צריך את זה

Chromium משמש רק כ-fallback ל-provider הישן `whatsapp-web.js`/Puppeteer (`WebJsProvider.ts` → [`src/whatsapp.ts`](../src/whatsapp.ts)). ה-fallback עצמו מותנה מפורשות ב-[`src/whatsappLifecycle.ts:91`](../src/whatsappLifecycle.ts#L91):

```ts
const canFallback = runtime.name === 'BAILEYS' && process.env.BAILEYS_FALLBACK_TO_WEBJS === 'true';
```

ובדיקה ישירה בייצור (`docker service inspect ... --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}...'`) הראתה ש**כל ארבע** לקוחות ה-Baileys הקיימות (`רות קמפיין`, `אביטל טנא`, `הדס גיגי`, `רות`) מוגדרות עם:

```
BAILEYS_FALLBACK_TO_WEBJS=false
```

וזו גם ברירת המחדל הקבועה שההקמה האוטומטית שותלת לכל לקוחה חדשה — [`src/dokployProvisioner.ts:550`](../src/dokployProvisioner.ts#L550):

```ts
'BAILEYS_FALLBACK_TO_WEBJS=false',
```

לקוחות Meta Cloud API / Twilio API כלל לא עוברות בנתיב הזה — הן ב-webhook mode (ראו הלוג ב-[`src/index.ts:111-114`](../src/index.ts#L111-L114): `"WhatsApp provider: Meta Cloud API (webhook mode, no Chromium scheduler)"`).

**מסקנה: נכון לרגע כתיבת מסמך זה, אף אחת מ-13 הלקוחות בייצור לא זקוקה ל-Chromium.**

### 3. המחיר בפועל: ~150-250 שניות על כל דיפלוי, לכל לקוחה

לוג build אמיתי מהיום (דיפלוי בודד ל"הדס גיגי", לקוחת Baileys עם `BAILEYS_FALLBACK_TO_WEBJS=false`) הראה:
- `apt-get install chromium ...`: כ-110 שניות (הורדת 217MB, פריסת 178 חבילות: `libgtk-3-0`, `libnss3`, `dbus`, `systemd`, `x11-utils`, ...).
- שאר ה-build (git clone, `npm ci` פעמיים, `tsc`): עוד כ-150 שניות.
- **סה"כ build שחצה את ה-timeout של 300 שניות שקבוע בבדיקת המוכנות** (`redeployExistingClient` ב-[`src/dokployProvisioner.ts`](../src/dokployProvisioner.ts), שדיווח `"Deployment did not finish within 300s"`).

בדיקת ה-`/health` בפועל אחרי שהקונטיינר עלה אישרה: הלקוחה תקינה ומחוברת — זה לא היה כשל אמיתי, רק חריגת timeout על build כבד מיותר.

## למה זה קרה עכשיו, לא בכל build

השכבה הזו (`RUN apt-get ...`) יושבת מיד אחרי `FROM node:20-slim` בשלב ה-production, לפני כל `COPY`, ולכן בעקרון ניתנת ל-cache בין builds (זהה בכל 13 הלקוחות). אך כשה-tag `node:20-slim` מתעדכן (Debian point release), ה-digest שנפתר עבורו משתנה, וכל השכבות שאחריו — כולל שכבת ה-`apt-get` הכבדה — מאבדות cache בבת אחת, בכל הלקוחות יחד. זה חלון סיכון תקופתי, לא אירוע חד-פעמי.

## התיקון המוצע

לגזור את התקנת Chromium להיות מותנית, כברירת מחדל **כבויה**, ולהדליק אותה רק ללקוח שבאמת יזדקק ל-fallback ל-WebJS.

### אפשרות א: build ARG + תנאי ב-Dockerfile

```dockerfile
ARG INSTALL_CHROMIUM=false
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      apt-get update && apt-get install -y \
        chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-freefont-ttf \
        --no-install-recommends && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

הפעלה דרך Dokploy: קריאת ה-API הקיימת ב-[`src/dokployProvisioner.ts:600-606`](../src/dokployProvisioner.ts#L600-L606) כבר שולחת `buildArgs: null` ל-`application.saveEnvironment`. **נקודת אי-ודאות**: לא בדקתי מול Dokploy בפועל האם שדה `buildArgs` הזה אכן מגיע ל-`docker build --build-arg`, כי הוא תמיד `null` היום בקוד הקיים — שאלה פתוחה לקודקס/לבדיקה ישירה מול ה-API של Dokploy לפני מימוש.

### אפשרות ב: משתנה סביבה בזמן ריצה, לא build-time

להשאיר את ה-Dockerfile גורף כפי שהוא, אבל זו בדיוק הבעיה שרוצים לפתור — משתנה סביבה של runtime לא יכול למנוע `apt-get` בזמן build. לכן זו לא אופציה אמיתית לבעיה הזו; מוזכרת רק כדי לשלול אותה במפורש.

### אפשרות ג: קובץ Dockerfile נפרד לכל provider

`Dockerfile.baileys` (בלי Chromium) ו-`Dockerfile.webjs`/ברירת מחדל (עם Chromium), עם `dockerfile:` נבחר לפי `current.whatsappProvider` ב-[`src/dokployProvisioner.ts:517-527`](../src/dokployProvisioner.ts#L517-L527) (`application.saveBuildType`). זה נמנע לגמרי מהצורך לוודא ש-Dokploy מכבד `buildArgs`, במחיר של שני קבצי Dockerfile לתחזק במקביל (סיכון drift).

## מה זה לא פותר / מגבלות

- לא נוגע ב-`רות` (הלקוחה המנותקת מ-WhatsApp) — זו בעיית session נפרדת לגמרי, לא קשורה ל-build.
- לא משנה את ברירת המחדל של `WHATSAPP_PROVIDER` (`BAILEYS`, [`src/config.ts:27`](../src/config.ts#L27)) ולא נוגע בלוגיקת ה-fallback עצמה ב-`whatsappLifecycle.ts` — רק בשאלה האם השכבה הכבדה נכנסת ל-image מלכתחילה.
- אם בעתיד לקוח קיים תזדקק בפועל ל-fallback (`BAILEYS_FALLBACK_TO_WEBJS=true`) בלי Chromium מותקן, ה-fallback עצמו ייכשל בזמן ריצה (לא build) — עם שגיאה ברורה מ-Puppeteer שלא מוצא executable, לא כשל שקט. יש לוודא (או Codex להכריע) אם דרוש safeguard נוסף: למשל, לדחות עלייה אם `BAILEYS_FALLBACK_TO_WEBJS=true` אך `INSTALL_CHROMIUM` לא סומן, כדי שכשל כזה יתגלה ב-build/health ולא רק כשה-fallback באמת מופעל בפרודקשן.

## תועלת צפויה

- קיצור **כל** דיפלוי (13/13 לקוחות, לא רק Baileys) בכ-150-250 שניות כל פעם שה-cache של אותה שכבה מתאפס.
- מבטל את חלון ה-timeout (300s) שנחצה היום ב"הדס גיגי".
- תמונת Docker קטנה יותר (Chromium + תלויותיו הם מאות MB).

## שאלות פתוחות לקודקס

1. איזו משלוש האופציות (א/ב/ג) — או קומבינציה — להעדיף? (ב' כבר נשללה למעלה כלא רלוונטית לבעיה).
2. אם א' (build ARG): איך/מתי לאמת בפועל ש-Dokploy מעביר `buildArgs` ל-`docker build`, לפני שסומכים עליו לכל 13 הלקוחות?
3. נדרש safeguard בזמן ריצה למקרה `BAILEYS_FALLBACK_TO_WEBJS=true` בלי Chromium מותקן (למנוע כשל שקט אם מישהו ידליק את הדגל בעתיד בלי לזכור להדליק גם את ה-build arg)?
4. `dokployProvisioner.ts` שולט בהקמה של לקוחות **חדשות** בלבד. 13 הלקוחות הקיימות לא יעברו רה-פרוביז'ן — הן צריכות רק build/redeploy חדש כדי לקבל Dockerfile מעודכן. אין צורך לגעת ב-env הקיים שלהן (`BAILEYS_FALLBACK_TO_WEBJS=false` כבר קיים ומספיק) — האם קודקס מסכים שזה מספיק, או שנדרש לוודא גם `application.saveEnvironment` מחדש לכל לקוחה קיימת (למשל אם בוחרים באופציה א' ו-Dokploy לא שומר build-arg על redeploy רגיל בלי שליחה מחדש)?
