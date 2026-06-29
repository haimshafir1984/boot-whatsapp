# PROJECT_HANDOFF.md

מסמך מעבר עבודה למערכת FlowsBiz / WhatsApp Status Bot.

המטרה של המסמך: לתת למפתח או לסוכן חדש תמונת מצב קצרה וברורה של מה קיים במערכת, איך היא בנויה, מה השתנה בתקופה האחרונה, ואילו קבצים חשובים לקרוא לפני שנוגעים בקוד.

## תקציר פשוט

המערכת מאפשרת ללקוחה לבנות קמפיין WhatsApp:

1. הלקוחה מתחברת לדף ניהול אישי.
2. היא מחברת WhatsApp דרך QR או קוד קישור.
3. היא מחברת Google Contacts, iCloud Contacts או מצב ידני.
4. היא בונה קמפיין עם משפט טריגר.
5. היא מקבלת לינק `wa.me` לשליחה בסטטוסים או לקולגות.
6. משתמש קצה שולח את משפט הטריגר לוואטסאפ של הלקוחה.
7. הבוט עונה אוטומטית, שואל שם אם צריך, שומר/מעדכן איש קשר, וממשיך שיחה לפי הנוסחים שהלקוחה הגדירה.

חשוב: כרגע המערכת עובדת דרך `whatsapp-web.js`, כלומר כמו WhatsApp Web מחובר. זו עדיין לא WhatsApp Business Platform רשמי.

## מצב הפריסה הנוכחי

המערכת עברה מ-Railway לשרת פרטי עם Dokploy.

דומיינים עיקריים:

- אתר ציבורי: `https://flowsbiz.com/`
- דשבורד מנהלים: `https://admin.flowsbiz.com/owner/`
- דפי לקוחות: נוצרים כדומיינים נפרדים תחת `flowsbiz.com`, לפי Dokploy.

הענף הפעיל לפריסה:

```text
master
```

הקומיטים נדחפים ל-GitHub, ואז Dokploy צריך לפרוס את הקומיט האחרון.

בדיקת דיפלוי ב-Dokploy:

- להיכנס לאפליקציה `flowsbiz-admin`.
- לפתוח `Deployments`.
- לוודא שהדיפלוי העליון מציג את הקומיט האחרון.

## מבנה לקוחות

יש דשבורד מנהלים פנימי.

דרך הדשבורד אפשר:

- ליצור לקוחה חדשה.
- לבחור מסלול לקוחה:
  - `basic` - מוכן להפעלה, הלקוחה רואה בעיקר מה פעיל.
  - `self_service` - ניהול עצמאי של קמפיינים.
  - `advanced` - הכנה למסלול Twilio מתקדם.
- להגביל מספר קמפיינים ללקוחה.
- להגדיר תוקף שירות ללקוחה.
- לבחור לה סיסמת כניסה.
- לקבל לינק נפרד לדף הניהול שלה.
- לראות לכל לקוחה:
  - קמפיינים פעילים.
  - כמה אנשי קשר נשמרו.
  - קמפיינים שהסתיימו.
  - סטטוס WhatsApp / Google / קמפיין פעיל.
- לבנות קמפיין עבור לקוחה מתוך עמוד הלקוחה בדשבורד המנהל.
- למחוק לקוחה בלחצן מחיקה עם אישור כפול.

כל לקוחה אמורה להיות יחידה מבודדת:

- אפליקציה נפרדת ב-Dokploy.
- Volume נפרד.
- נתוני WhatsApp נפרדים.
- נתוני Google נפרדים.
- קמפיינים וקבצים נפרדים.

## פיצ'רים מרכזיים בדף לקוחה

### חיבור WhatsApp

הלקוחה יכולה להתחבר דרך:

- סריקת QR.
- קוד קישור לפי מספר טלפון.

המערכת מפעילה Chromium רק כשצריך, לפי חלונות קמפיין או הפעלה ידנית.

### חיבור אנשי קשר

אפשרויות:

- Google Contacts דרך OAuth.
- iCloud Contacts דרך CardDAV.
- Manual, כלומר רישום מקומי וייצוא CSV בלי שמירה חיצונית.

שמירת אנשי קשר מתבצעת בתור רקע:

- המשתמש מקבל תגובה מהר.
- השמירה ל-Google/iCloud מתבצעת ברקע.
- יש סטטוסים: `pending`, `saved`, `failed`.
- יש retry במקרה כשל.

### בניית קמפיין

הלקוחה מגדירה:

- שם קמפיין.
- סוג קמפיין:
  - בוט רגיל.
  - תוספת שם / המלצה.
- משפט טריגר.
- שעת התחלה.
- שעת סיום.
- האם לשאול את המשתמש באיזה שם לשמור אותו.
- נוסח שאלת שם.
- נוסח הודעת סיום.
- הודעות המשך.
- עץ החלטה.
- קבצים לשליחה.

### בניית קמפיין מוכן להפעלה מתוך דשבורד המנהל

במסלול `basic` / "מוכן להפעלה", הלקוחה לא צריכה לערוך את הקמפיין בעצמה.

המנהל בונה עבורה את הקמפיין מתוך עמוד הלקוחה בדשבורד המנהל (`owner-public/client.html`).

בטופס הזה יש שלושה משפטים מרכזיים:

1. משפט טריגר הפעלה.
2. משפט שאלת שם - מופיע רק אם מסמנים "לשאול באיזה שם לשמור".
3. משפט סיום.

חשוב: השדה של משפט שאלת שם משפיע רק על קמפיינים חדשים שנוצרים מהטופס. קמפיינים קיימים לא משתנים.

ה-API שמקבל את הנתונים משתמש במבנה `conversation` הרגיל של הקמפיין:

- `askNameEnabled`
- `askNameText`
- `replyText`

## עץ החלטה

עץ ההחלטה נבנה כך שיתאים גם למגבלות WhatsApp בהמשך:

- כל שלב הוא או `הודעה רגילה` או `שאלת בחירה`.
- שאלת בחירה מוגבלת לעד 3 תשובות.
- המשתמש יכול לענות במספר או בטקסט התשובה.
- כל תשובה יכולה:
  - לסיים עם הודעת סיום.
  - לעבור לשלב אחר.
  - לשלוח קובץ.
  - לשלוח תמונה כמדבקה במסלול `WEB_JS`.

לשאלת בחירה אפשר להגדיר גם timeout:

- כמה דקות להמתין לתשובה.
- הודעה שתישלח אם המשתמש לא ענה.
- קובץ/תמונה שתישלח אם המשתמש לא ענה.
- שליחה כמדבקה אם הקובץ הוא תמונה.

במסלול `whatsapp-web.js` אין כפתורים רשמיים. לכן השאלה נשלחת כטקסט עם רשימה ממוספרת.

בעתיד, במסלול Twilio / WhatsApp Business Platform, אותו מבנה יכול להפוך לכפתורי Quick Reply רשמיים.

דוגמה חשובה:

כפתור אמיתי כמו "בטח :)" בתוך WhatsApp לא נתמך כרגע במסלול `WEB_JS`.
במסלול הקיים אפשר לשלוח טקסט כמו "כתבי: בטח :)" ולזהות תשובה כטקסט.
כפתורי Quick Reply אמיתיים שייכים למסלול עתידי של Twilio / WhatsApp Business Platform.

## שליחת קבצים

נוספה יכולת העלאת קובץ ושליחתו מתוך עץ ההחלטה.

תמיכה כרגע:

- PDF.
- תמונות: JPEG, PNG, WEBP.
- MP4.
- מגבלת גודל: 15MB.

הקבצים נשמרים בתיקיית:

```text
data/uploads
```

בפריסה מבודדת לכל לקוחה, התיקייה הזאת נמצאת ב-Volume של אותה לקוחה.

ב-UI:

- יש אזור `קבצים לשליחה` בתוך בניית הקמפיין.
- מעלים קובץ.
- בעץ החלטה, בתשובה מסוימת בוחרים פעולה `שליחת קובץ`.
- בוחרים את הקובץ.
- אפשר להוסיף כיתוב שישלח יחד עם הקובץ.

בבוט:

- `whatsapp-web.js` שולח את הקובץ דרך `MessageMedia.fromFilePath`.
- אם הקובץ לא נמצא, נשלחת הודעת fallback במקום קריסה.

## קבצים עיקריים

### `src/index.ts`

נקודת הכניסה של המערכת.

אחראי על:

- טעינת קונפיגורציה.
- יצירת `Storage`.
- התחלת שרת הניהול.
- התחלת WhatsApp לפי הצורך.
- הפעלת תור שמירת אנשי קשר.

### `src/adminServer.ts`

שרת Express.

אחראי על:

- דף לקוחה.
- דשבורד מנהלים.
- API לקמפיינים.
- API לחיבור Google.
- API לחיבור WhatsApp.
- API לתור אנשי קשר.
- API להעלאת קבצים.
- API לניהול לקוחות בדשבורד המנהל.
- API פנימי שמאפשר למנהל ליצור/להפעיל/למחוק קמפיינים עבור לקוחה דרך Owner Dashboard.
- API יכולות לקוחה: מסלול, מגבלת קמפיינים, תוקף שירות, Provider.

נקודות חשובות:

- `GET /api/campaigns`
- `POST /api/campaigns`
- `PUT /api/campaigns/:id`
- `DELETE /api/campaigns/:id`
- `GET /api/files`
- `POST /api/files`
- `GET /owner/api/clients`
- `POST /owner/api/clients`
- `GET /owner/api/clients/:id/summary`
- `POST /owner/api/clients/:id/campaigns`
- `PATCH /owner/api/clients/:id/campaigns/:campaignId/toggle`
- `DELETE /owner/api/clients/:id/campaigns/:campaignId`
- `DELETE /owner/api/clients/:id`

### `src/storage.ts`

שכבת אחסון JSON.

שומרת:

- הגדרות לקוחה.
- קמפיינים.
- תוצאות קמפיינים.
- תור שמירת אנשי קשר.
- אנשי קשר שנשמרו.
- קבצים שהועלו.

מבנה חשוב:

- `Campaign`
- `CampaignConversationSettings`
- `DecisionFlowStep`
- `DecisionFlowOption`
- `UploadedFile`
- `ContactSaveJob`

### `src/messageFlow.ts`

הלוגיקה של שיחה נכנסת.

אחראי על:

- זיהוי טריגר.
- שאלת שם.
- שמירה לתור אנשי קשר.
- שליחת הודעת סיום.
- הודעות המשך.
- עץ החלטה.
- תגובה לבחירת משתמש בעץ.
- שליחת קובץ לפי תשובה.

### `src/whatsapp.ts`

חיבור בפועל ל-WhatsApp דרך `whatsapp-web.js`.

אחראי על:

- יצירת WhatsApp client.
- QR.
- pairing code.
- האזנה להודעות.
- המרת הודעה נכנסת לפורמט פנימי.
- שליחת טקסט.
- שליחת קובץ.

### `src/types/whatsapp.ts`

הטיפוסים של שכבת WhatsApp.

כולל:

- `IncomingWhatsAppMessage`
- `WhatsAppTransport`
- `WhatsAppProvider`

נוספה תמיכה ב-`sendFile`.

### `src/providers/WebJsProvider.ts`

Provider של המסלול הקיים, מבוסס `whatsapp-web.js`.

כרגע זה הבסיס להפרדת Providers לקראת Twilio בעתיד.

### `src/providers/TwilioProvider.ts`

Provider ראשוני למסלול `TWILIO_API`.

כרגע תומך ב:

- בדיקת env בסיסית.
- שליחת הודעות טקסט דרך Twilio Messages API.
- fallback לכפתורים כטקסט ממוספר.
- שליחת כפתורי Quick Reply דרך Content API כאשר מוגדר `TWILIO_QUICK_REPLY_CONTENT_SID`.
- שליחת מדיה דרך `MediaUrl` אם מוגדר `TWILIO_MEDIA_BASE_URL`.
- לוגים פנימיים של inbound/outbound דרך `src/twilioEvents.ts`.
- אימות חתימת webhook של Twilio דרך `X-Twilio-Signature`.

עדיין לא הושלם:

- מסך מנהל מלא להגדרת Twilio לכל לקוחה.
- יצירה אוטומטית של Content Templates ב-Twilio.

### `src/dokployProvisioner.ts`

אחראי להקים יחידת לקוחה חדשה ב-Dokploy.

יוצר:

- Application.
- Volume.
- Domain.
- Environment variables.
- Deploy.

גם כולל מחיקת משאבים:

- domain.
- mount.
- application.

### `src/ownerStorage.ts`

שומר את רשימת הלקוחות של דשבורד המנהל.

כולל:

- שם לקוחה.
- סיסמת כניסה.
- URL לניהול.
- מסלול לקוחה.
- מגבלת קמפיינים.
- תוקף שירות.
- Provider WhatsApp.
- `ownerAccessToken` פנימי לתקשורת מאובטחת בין דשבורד המנהל ליחידת הלקוחה.
- מזהי Dokploy.
- סטטוס הקמה.

### `public/index.html`

דף הניהול של לקוחה.

זה קובץ HTML אחד עם CSS ו-JavaScript פנימי.

כולל:

- חיבור WhatsApp.
- חיבור Google/iCloud/manual.
- בניית קמפיין.
- תצוגת שיחה.
- עץ החלטה.
- העלאת קבצים.
- קמפיינים קיימים.
- תוצאות קמפיינים.

חשוב: אחרי שינוי בקובץ הזה כדאי לבדוק גם תחביר JavaScript, כי TypeScript לא בודק inline script בתוך HTML.

בדיקה שימושית:

```bash
node -e "const fs=require('fs'); const html=fs.readFileSync('public/index.html','utf8'); const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]); for (const s of scripts) new Function(s); console.log('ok')"
```

### `owner-public/index.html`

דשבורד המנהל הראשי.

כולל:

- רשימת לקוחות.
- יצירת לקוחה חדשה.
- פתיחת דף לקוחה.
- העתקת סיסמה.
- כפתור מחיקה.

### `owner-public/client.html`

דף פרטים ללקוחה בתוך דשבורד המנהל.

מציג:

- לינק ללקוחה.
- סיסמת כניסה.
- סטטוס הקמה.
- מזהי Dokploy.
- קמפיינים פעילים.
- אנשי קשר שנשמרו.
- קמפיינים שהסתיימו.
- סטטוס WhatsApp / Google / קמפיין פעיל.
- מסלול הלקוחה, מגבלת קמפיינים ותוקף שירות.
- חיווי אבחון: האם WhatsApp מחובר, האם צריך להאזין, ומה מצב lifecycle.
- עורך קמפיין פנימי למנהל עבור לקוחה במסלול "מוכן להפעלה".
- בטופס יצירת קמפיין: טריגר, שאלת שם אופציונלית, והודעת סיום.

### `site-public/`

אתר ציבורי בסיסי ל-FlowsBiz:

- דף בית.
- מדיניות פרטיות.

נדרש בין השאר בשביל אימות Google OAuth.

### `Verification.md`

מסמך עזר לתהליך Google OAuth verification.

כולל מה לעשות כש-Google מחזירה הערות על האימות.

### `docs/twilio-architecture-plan.md`

מסמך תכנון למעבר עתידי ל-Twilio / WhatsApp Business Platform.

חלק ראשון כבר יושם מקומית:

- `WHATSAPP_PROVIDER=TWILIO_API` מכבה את Scheduler של WhatsApp Web/Chromium.
- `POST /webhooks/twilio/whatsapp` מקבל הודעות נכנסות מ-Twilio.
- ה-webhook מאמת `TWILIO_WEBHOOK_TOKEN` וגם חתימת Twilio כאשר `TWILIO_REQUIRE_SIGNATURE=true`.
- הודעות נכנסות עוברות לאותה לוגיקת טריגרים וקמפיינים.
- `TwilioProvider` שולח הודעות טקסט דרך Twilio.
- `GET /twilio-media/:filename` מאפשר ל-Twilio למשוך קבצים ציבוריים אם מוגדר `TWILIO_MEDIA_BASE_URL`.
- `GET /api/twilio/status` מציג סטטוס Twilio ולוגים אחרונים.
- `GET /api/twilio/logs` מציג יומן Twilio פנימי.

קיים קובץ דוגמה מקומי:

```text
.env.twilio.local.example
```

## פקודות בדיקה

```bash
npm run build
```

בדיקת JavaScript בתוך `public/index.html`:

```bash
node -e "const fs=require('fs'); const html=fs.readFileSync('public/index.html','utf8'); const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]); for (const s of scripts) new Function(s); console.log('validated '+scripts.length+' inline script block(s)');"
```

## נקודות זהירות

1. לא למחוק לקוחות אמיתיים בלי אישור מפורש.
2. לא להכניס לקומיט תיקיות כמו `.wwebjs_cache`, `data`, `session`, `node_modules`.
3. לא להכניס סודות כמו `credentials.json`, טוקנים או סיסמאות.
4. הענף הפעיל הוא `master`, לא `main`.
5. שינוי defaults ב-`config.ts` לא בהכרח משפיע על לקוחות קיימים, כי ההגדרות כבר שמורות ב-JSON שלהם.
6. עץ החלטה צריך להישאר פשוט: עד 3 תשובות לשאלה.
7. קבצים נשמרים ב-Volume של הלקוחה; אם אין Volume, קבצים וסשנים יאבדו אחרי restart.
8. המערכת עדיין לא API רשמי של WhatsApp, ולכן אין להבטיח יציבות כמו WhatsApp Business Platform.

## מה נעשה בתקופה האחרונה

- מעבר מתפיסה של לקוחה יחידה למודל דשבורד מנהלים עם לקוחות מבודדות.
- מעבר תשתיתי ל-Dokploy על שרת פרטי.
- הוספת דומיין `flowsbiz.com`.
- הוספת אתר ציבורי ומדיניות פרטיות.
- שיפור OAuth של Google עם callback מרכזי.
- הוספת דשבורד מנהלים.
- הוספת יצירת לקוחה עם סיסמת כניסה.
- הוספת סיכום לקוחה בדשבורד המנהל.
- הוספת מחיקת לקוחה.
- הוספת עץ החלטה פשוט.
- הוספת מגבלת 3 תשובות שמתאימה ל-WhatsApp.
- הוספת שליחת קבצים מתוך עץ החלטה.
- הוספת תור שמירת אנשי קשר ברקע.
- הוספת סטטוסים לתור: pending/saved/failed.
- הוספת כיבוי/הפעלה של WhatsApp/Chromium לפי קמפיינים כדי לחסוך משאבים.
- הוספת מסלולי לקוחות: מוכן להפעלה, עצמאי, מתקדם/Twilio.
- הוספת מגבלת קמפיינים ותוקף שירות ברמת לקוחה.
- הוספת Owner campaign editor מתוך עמוד הלקוחה בדשבורד המנהל.
- הוספת שדה "משפט שאלת שם" שנפתח רק כאשר מסמנים שאלת שם בקמפיין מוכן להפעלה.
- הוספת timeout לשאלות המשך בעץ החלטה, כולל שליחת הודעה/קובץ/מדבקה אם לא ענו.
- הוספת אפשרות לשלוח קובץ תמונה כמדבקה מתוך עץ החלטה.
- הוספת חיווי אבחון בעמוד הלקוחה: מספר קמפיינים, runtime status, `shouldRun`, lifecycle וטלפון מחובר.
- שינוי זיהוי טריגר כך שמשפט הטריגר יכול להיות חלק מהודעה ארוכה יותר, ולא חייב להיות ההודעה כולה.
- הוספת הודעה ברורה כאשר WhatsApp מחובר אבל הבוט יפעל רק כשיש קמפיין פעיל.
- הוספת הכנה ראשונית ל-Twilio Provider, בלי להפעיל עדיין מסלול Twilio בפועל.
- הוספת Twilio webhook מקומי ושליחת טקסט בסיסית דרך Twilio Messages API.
- הוספת מצב `TWILIO_API` שבו לא מופעל Chromium/WhatsApp Web Scheduler.
- הוספת אימות חתימת Twilio, לוגים פנימיים ו-endpoints לסטטוס Twilio.
- הוספת תמיכה ב-Quick Reply דרך ContentSid, עם fallback לטקסט רגיל אם לא הוגדר Template.

## כיוון המשך מומלץ

1. לבדוק שליחת קובץ אצל לקוחה אמיתית.
2. לשפר UX של העלאת קבצים אם צריך.
3. להוסיף אפשרות למחוק קובץ שהועלה.
4. להוסיף לוגים נוחים בדשבורד מנהלים.
5. להתחיל Twilio רק אחרי שהמסלול הרגיל יציב אצל כמה לקוחות.
6. בטווח ארוך לעבור מ-JSON ל-Database.
7. בטווח ארוך להוסיף מערכת משתמשים והרשאות אמיתית.

## עדכון אחרון - 1.6.2026

בסבב העבודה האחרון המערכת עברה משלב "הכנה ל-Twilio" לשלב שבו אפשר להריץ קמפיין ניסיון אמיתי דרך WhatsApp Sender של Twilio.

### Twilio / WhatsApp Business Platform

- נוסף מסלול עבודה מקומי מלא עם `WHATSAPP_PROVIDER=TWILIO_API`.
- נוסף קובץ דוגמה: `.env.twilio.local.example`.
- קובץ `.env.twilio.local` המקומי נשאר מחוץ ל-Git ואמור להכיל סודות אמיתיים.
- הוגדר שימוש ב-WhatsApp Sender אמיתי של Twilio, לדוגמה `TWILIO_FROM=whatsapp:+18027218302`.
- נוספה נקודת כניסה: `POST /webhooks/twilio/whatsapp`.
- ה-webhook תומך ב-`TWILIO_WEBHOOK_TOKEN` דרך query string ובחתימת Twilio כאשר `TWILIO_REQUIRE_SIGNATURE=true`.
- נוספו endpoints לאבחון: `GET /api/twilio/status` ו-`GET /api/twilio/logs`.
- נוסף מצב שבו `TWILIO_API` לא מפעיל Chromium/WhatsApp Web Scheduler, כדי לחסוך זיכרון.
- נוסף `TwilioProvider` לשליחת טקסט, קבצים, Quick Replies ו-List Picker.

### הרצה מקומית עם Twilio

כדי להריץ מקומית עם Twilio צריך לטעון את קובץ הסביבה ואז להפעיל את השרת:

```powershell
Get-Content .env.twilio.local | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process') }
}
npm run dev
```

`npm run dev` לבד יריץ את המערכת, אבל ללא ההגדרות של Twilio מהקובץ המקומי.

כאשר עובדים מקומית מול Twilio צריך גם להריץ ngrok ולהגדיר ב-Twilio את ה-webhook הנוכחי:

```text
https://<ngrok-domain>/webhooks/twilio/whatsapp?token=<TWILIO_WEBHOOK_TOKEN>
```

### קמפיין ניסיון דרך Twilio

לקמפיין ניסיון עם לקוחה:

1. משתמשים ב-WhatsApp Sender שכבר Online ב-Twilio, אם קיים.
2. יוצרים קמפיין פעיל במערכת עם משפט טריגר.
3. יוצרים לינק `wa.me` למספר של ה-Twilio Sender.
4. הלקוחה מפרסמת את הלינק בסטטוס/פרסום.
5. המשתמש לוחץ, נפתח WhatsApp עם הודעת טריגר מוכנה, וכשהוא שולח אותה הבוט מתחיל את הקמפיין.

דוגמה:

```text
https://wa.me/18027218302?text=טסט
```

אם הטריגר כולל רווחים, צריך לקודד אותם:

```text
https://wa.me/18027218302?text=הגעתי%20מהסטטוס
```

ההבדל מול המסלול הישן הוא שהלינק מוביל למספר Twilio הרשמי, לא למספר WhatsApp Web של הלקוחה.

### טריגרים

- טריגר כבר לא חייב להיות כל ההודעה במדויק.
- אם משפט הטריגר מופיע כחלק מהודעה ארוכה יותר, הקמפיין יופעל.
- זה פותר מקרים כמו משתמש שכותב `טסט בבקשה` במקום רק `טסט`.

### שאלת שם והודעות קמפיין

- בקמפיין "מוכן להפעלה", כאשר מסמנים שאלת שם, נפתח שדה טקסט ייעודי לנוסח שאלת השם.
- מבנה שיחה בסיסי יכול להיות: משפט טריגר, שאלת שם, הודעת סיום.
- אם הודעת הסיום ריקה, המערכת לא שולחת הודעה ריקה ל-Twilio וממשיכה לשאלות ההמשך.

### שאלות המשך / Decision Flow

- לכל שאלת בחירה נוסף שדה `presentation`.
- ערכים אפשריים: `buttons`, `list`, `text`.
- `buttons` שולח כפתורי Quick Reply ומוגבל ל-3 תשובות.
- `list` שולח רשימה נפתחת / List Picker ותומך עד 10 תשובות.
- `text` שולח טקסט ממוספר רגיל ותומך עד 10 תשובות.
- אם Twilio דוחה כפתורים או רשימה, המערכת נופלת אוטומטית ל-text fallback כדי שהקמפיין לא יישבר.
- תשובות מכפתורים/רשימות נקלטות גם לפי payload מספרי (`1`, `2`, וכו') וגם לפי טקסט.

### Quick Replies ו-List Picker

- `TwilioProvider` יוצר Content Template דינמי בזמן שליחת השאלה.
- עבור כפתורים נוצר `twilio/quick-reply`.
- עבור רשימה נפתחת נוצר `twilio/list-picker`.
- תמיד מוגדר גם `twilio/text` כ-fallback.
- אין תלות חובה ב-ContentSid סטטי כדי שהשאלות יעבדו.
- עדיין קיימים משתני סביבה legacy: `TWILIO_QUICK_REPLY_CONTENT_SID` ו-`TWILIO_LIST_PICKER_CONTENT_SID`.

### Timeout ומדבקות

- נוספה תמיכת timeout גם לשאלות המשך.
- אם משתמש לא עונה בזמן שהוגדר, אפשר לשלוח הודעת טקסט, קובץ או תמונה כמדבקה.
- אפשר לשלוח קובץ/תמונה כמדבקה גם לפי בחירת תשובה בעץ ההחלטה.
- במסלול Twilio, שליחת קבצים דורשת `TWILIO_MEDIA_BASE_URL` ציבורי שמצביע ל-`/twilio-media`.

### זיכרון ומשאבים

- במסלול `WEB_JS`, המערכת מכבה את חיבור WhatsApp/Chromium כאשר אין קמפיין פעיל.
- החיווי ללקוח שונה כך שלא ייראה כאילו החיבור נכשל: החיבור הצליח, והבוט יפעל כאשר יהיה קמפיין פעיל.
- במסלול `TWILIO_API` אין Chromium ולכן צריכת הזיכרון אמורה להיות נמוכה יותר.

### מסלולי לקוחות ותמחור

- `basic` - מוכן להפעלה: הלקוחה רואה בעיקר מה פעיל; בעל המערכת יכול לבנות עבורה קמפיין מתוך דשבורד המנהל.
- `self_service` - מסלול עצמאי: הלקוחה עורכת ומנהלת קמפיינים לבד, עד מגבלה מוגדרת.
- `advanced` - מסלול מתקדם/Twilio: מיועד לכפתורים, רשימות, תהליכים מתקדמים ו-WhatsApp Business Platform.

נוספו יכולות ניהול:

- חיווי מסלול בעמוד לקוח בדשבורד המנהל.
- הגבלת מספר קמפיינים ללקוח.
- הגבלת תוקף שירות/קמפיין.
- Owner campaign editor מתוך עמוד הלקוחה בדשבורד המנהל.

### קבצים מרכזיים שהשתנו בסבב זה

- `src/messageFlow.ts`
- `src/providers/TwilioProvider.ts`
- `src/types/whatsapp.ts`
- `src/adminServer.ts`
- `src/config.ts`
- `src/storage.ts`
- `src/whatsapp.ts`
- `src/providers/WebJsProvider.ts`
- `public/index.html`
- `.env.twilio.local.example`

### קומיטים חשובים בסבב זה

- `3c2a606` - Add decision timeout and sticker support
- `174d40c` - Add local Twilio webhook provider setup
- `4f5b44e` - Ignore local Twilio env files
- `8cf7d91` - Make trigger matching case insensitive
- `8182ae0` - Harden Twilio provider and add diagnostics
- `8c4c356` - Fix decision followup delivery
- `76e0839` - Add WhatsApp list picker decisions

### נקודות שעדיין צריך לזכור

- כדי לבדוק Twilio מקומית, ngrok חייב להיות פתוח וה-webhook ב-Twilio חייב להצביע לכתובת הנוכחית.
- אם עובדים בפרודקשן, יש להגדיר את ה-webhook לדומיין הציבורי של הלקוחה/האפליקציה.
- לקמפיין ניסיון לא חייבים לקנות מספר חדש אם כבר יש WhatsApp Sender פעיל ב-Twilio.
- לקניית מספר חדש ב-Twilio צריך לקנות מספר ב-Phone Numbers ואז לרשום אותו כ-WhatsApp Sender. זה עשוי לדרוש Meta Business Portfolio, פרופיל עסק ואישורים.
- WhatsApp API לא מתנהג כמו אפליקציית WhatsApp רגילה בטלפון; המספר מנוהל דרך Twilio והמערכת, לא מתוך אפליקציית WhatsApp Business רגילה.

## עדכון אחרון - 3.6.2026

בסבב העבודה האחרון המיקוד עבר מהרעיון של שליחה המונית כללית אל חיזוק המערכת הקיימת: חוויית יצירת קמפיין, מסלול Twilio מסודר, בדיקות UI, וסריקת אבטחה מלאה. לא בוצעה שליחת WhatsApp ראשונה ללא opt-in מפורש; הכיוון העסקי נשאר `wa.me` / לינק WhatsApp או טמפלט מאושר של Twilio כאשר יש opt-in.

### החלטות מוצריות חשובות

- ירדנו כרגע מרעיון שליחת הודעות המונית דרך WhatsApp ללא חיבור Facebook/Meta רשמי של הלקוח.
- אם אין opt-in מפורש, לא שולחים WhatsApp ראשון. הפתרון התקין הוא SMS/מייל קצר עם לינק `wa.me`, או איסוף opt-in בדף נחיתה.
- קמפיין Twilio יכול לעבוד בשני מצבים: `link` ליצירת לינק WhatsApp, או `template` לטמפלט מאושר עם opt-in.
- חיבור WhatsApp וחיבור Google נשארים באזור הדשבורד הראשי, לא בתוך ויזארד יצירת הקמפיין.
- יצירת קמפיין היא פעולה נפרדת, מחולקת לשלבים, ולא אמורה לערבב חיבורים כלליים של הלקוח.
- החיבור דרך Apple / iCloud ירד מהכיוון הנוכחי ואינו אמור להיות מוצג כמסלול UX מרכזי. מסלולי אנשי הקשר הנוכחיים הם Google או Manual.

### Baileys pilot

נוסף pilot למסלול `BAILEYS` כדי לבדוק עבודה בלי Chromium:

- provider חדש: `src/providers/BaileysProvider.ts`.
- בחירה דרך `WHATSAPP_PROVIDER=BAILEYS`.
- Baileys משתמש ב-WebSocket וב-auth state תחת `SESSION_PATH/baileys`.
- המטרה היא לבדוק חסכון זיכרון לעומת `whatsapp-web.js`.
- זה עדיין pilot ולא המסלול הראשי לפרודקשן.
- הקומיט הרלוונטי: `559f823 Add Baileys WhatsApp provider pilot`.

### עיצוב ויזארד יצירת קמפיין

`public/index.html` עודכן כך שיצירת קמפיין מחולקת ל-4 שלבים ברורים:

1. בניית קמפיין: שם קמפיין, סוג קמפיין Bot/ממליץ, ומשפט טריגר.
2. שמירת איש קשר: שאלת שם, נוסח שאלת שם, והודעת אישור שהאיש קשר נשמר.
3. שאלות נוספות: הודעות המשך, Decision flow, קבצים וכל הלוגיקה הקיימת בצורה ברורה יותר.
4. סיום, אישור וקבלת לינק: סיכום, מצב Twilio, לינק `wa.me`, העתקה ופתיחה ב-WhatsApp.

שינויים חשובים:

- הוויזארד לא סוגר את המודל מיד אחרי שמירה, אלא מציג מסך סיום עם הלינק.
- לפני מעבר שלבים יש ולידציה בסיסית לשלב הראשון.
- הלינק נבנה דרך `/api/config`, כדי להשתמש במספר הנכון: מספר Twilio כאשר provider הוא `TWILIO_API`, או מספר WhatsApp מחובר במסלול הרגיל.
- הקומיטים הרלוונטיים: `18a42d4`, `db43170`, `4a4a329`.

### Twilio dashboard

נוסף בדשבורד הלקוח כרטיס ייעודי ל-Twilio / WhatsApp Link:

- מציג האם הלקוח עובד ב-`TWILIO_API` או WhatsApp Web.
- מציג אם Twilio מוגדר.
- מציג `TWILIO_FROM` ו-`TWILIO_MESSAGING_SERVICE_SID`.
- מציג האם חתימת Twilio פעילה.
- מציג כתובת webhook להעתקה.
- מציג סטטוס הגדרות בסיסי.
- הקומיט הרלוונטי: `bbb80c1 Add Twilio dashboard status card`.

### Twilio campaign setup flow

נבנה flow מלא יותר לקמפיין Twilio:

- פרטי onboarding ראשוניים ללקוח: שם עסק, שם מותג, אתר, קטגוריה, תיאור פעילות, אימייל/טלפון תמיכה, מדינה, תיאור opt-in, use case ראשון והערות.
- טיוטות טמפלטים: שם פנימי, שם טמפלט לאישור WhatsApp, שפה, קטגוריה, גוף הודעה ודוגמאות משתנים.
- אפשרות ליצור Content ב-Twilio.
- אפשרות לשלוח טמפלט לאישור WhatsApp.
- אפשרות לרענן סטטוס אישור.
- בקמפיין עצמו נשמר שדה `twilio` עם `mode`, `templateId`, `optInConfirmed`, `audienceNotes`.

קבצים מרכזיים:

- `src/storage.ts`
- `src/adminServer.ts`
- `public/index.html`

endpoints חדשים / מעודכנים:

- `GET /api/twilio/onboarding`
- `PUT /api/twilio/onboarding`
- `GET /api/twilio/templates`
- `POST /api/twilio/templates`
- `PUT /api/twilio/templates/:id`
- `POST /api/twilio/templates/:id/create-content`
- `POST /api/twilio/templates/:id/submit-approval`
- `POST /api/twilio/templates/:id/sync-approval`

הקומיט הרלוונטי: `ba98899 Build Twilio campaign setup flow`.

### בדיקות שבוצעו

בסבב הזה בוצעו בדיקות:

- `npm run build` עבר אחרי השינויים.
- בדיקת JavaScript syntax ל-HTML דרך חילוץ `<script>` והרצת `new Function`.
- בדיקת UI מקומית עם שרת זמני ו-Puppeteer/Playwright CLI: login, dashboard, שמירת פרטי Twilio onboarding, יצירת טיוטת טמפלט וטעינת רשימת טמפלטים.
- לא נשלחה בקשה אמיתית לאישור טמפלט מול Twilio כדי לא ליצור Content אמיתי בטעות.

### Puppeteer / PowerShell

במחשב Windows הופיעה בעיית Execution Policy:

```powershell
npx : File C:\Program Files\nodejs\npx.ps1 cannot be loaded because running scripts is disabled on this system.
```

פתרונות:

- להשתמש ב-`npx.cmd` / `npm.cmd` במקום `npx` / `npm` מתוך PowerShell.
- או להריץ:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

העדפה לפיתוח: להשתמש ב-`.cmd` כדי לא לשנות מדיניות מערכת אם אין צורך.

### Security scan - 3.6.2026

הורצה סריקת אבטחה מלאה עם `codex-security` על כל הריפו.

דוחות:

- Markdown: `C:\tmp\codex-security-scans\parpar sagol\ba98899_20260602T000000Z\report.md`
- HTML: `C:\tmp\codex-security-scans\parpar sagol\ba98899_20260602T000000Z\report.html`

תוצאה:

- לא נמצאו Critical / High שמראים על RCE, auth bypass או tenant escape.
- נמצאו 4 נושאים לטיפול:

1. `CSV injection` בייצוא אנשי קשר / תוצאות קמפיין. לתקן ראשון ב-`src/adminServer.ts` עם encoder משותף שמנטרל ערכים שמתחילים ב-`=`, `+`, `-`, `@`, tab או CR.
2. קבצי Twilio media נגישים ציבורית דרך `/twilio-media/:filename`. traversal מוגן יחסית, אבל שם הקובץ מבוסס timestamp ושם מקורי. כדאי לעבור לשמות קבצים רנדומליים חזקים או signed URLs.
3. `npm audit` מצא פגיעות moderate דרך `googleapis/gaxios/uuid`. התיקון דורש בדיקת שדרוג ל-`googleapis@173`.
4. נמצאו קבצי סודות מקומיים בתיקיית הפרויקט: `credentials.json`, `.env.twilio.local`. הם לא tracked בגיט, אבל אם הערכים אמיתיים צריך לשמור מחוץ לתיקיית הפרויקט ולשקול rotation אם נחשפו.

### מצב Git אחרון מהסבב

קומיטים חשובים שנוצרו ודחפו:

- `559f823 Add Baileys WhatsApp provider pilot`
- `18a42d4 Redesign campaign wizard flow`
- `db43170 Keep connection settings in dashboard`
- `4a4a329 Improve campaign creation finish flow`
- `bbb80c1 Add Twilio dashboard status card`
- `ba98899 Build Twilio campaign setup flow`

הערה: קובץ `PROJECT_HANDOFF.md` עצמו היה modified מקומית לפני העדכון הזה. לא למחוק שינויים קיימים בו בלי לבדוק.

### סדר עדיפויות מומלץ להמשך

1. לתקן CSV injection בכל exports.
2. לחזק filenames / access של Twilio media.
3. לנקות/להוציא סודות מקומיים מתיקיית הפרויקט.
4. לבדוק שדרוג `googleapis`.
5. לבצע בדיקת UI מלאה למסלול Twilio template לאחר תיקוני האבטחה.
6. אם רוצים להמשיך בחיסכון זיכרון, להריץ השוואת צריכת זיכרון בין `WEB_JS` לבין `BAILEYS`.

---

## עדכון 25.6.2026 - כרטיס איש קשר וזרימת קמפיינים רגילים/Twilio

נוצר מסמך סיכום מפורט:

- `docs/contact-card-campaign-flow-summary.md`

המסמך מרכז את כל העבודה סביב כרטיס איש קשר, סדר הודעות, `wait_reply`, בדיקות יציבות וסימולציות.

### בעיות שטופלו

- בקמפיינים רגילים, `replyText` / הודעת סיום הופיעה לפני כרטיס איש קשר גם כשהכרטיס הוגדר להישלח בתחילת הזרימה.
- בקמפיינים רגילים, vCard לא תמיד הגיע ככרטיס איש קשר תקין ב-WhatsApp.
- בקמפייני Twilio ה-vCard עבד טוב, אבל היה צריך לשמור את המסלול שלו בלי לשבור אותו.
- ה-preview וה-dry-run לא תמיד שיקפו את runtime ולכן הטעו בבדיקת קמפיין.
- היה צורך בשלב שמחכה לתשובת משתמש חופשית, למשל: `האם שמרת?` ואז המשך רק אחרי שהמשתמש עונה.

### תיקונים עיקריים

- נוסף שדה `contactCardIntroText` בבונה הקמפיין: הודעה לפני שליחת איש קשר.
- נוסף סוג שלב `wait_reply` שמוצג ב-UI כ-`הודעה שממתינה לתשובה`.
- תוקן סדר השליחה:
  - אם כרטיס איש קשר מוגדר `before_questions`, לא שולחים את `replyText` לפניו.
  - אם יש `contactCardIntroText`, שולחים אותו לפני הכרטיס.
  - אחר כך שולחים כרטיס איש קשר ואז ממשיכים לשאלות/הודעות המשך.
- תוקן preview ב-`public/index.html` כך שלא יציג את משפט הסיום לפני הכרטיס.
- תוקן dry-run ב-`src/adminServer.ts` כך שישקף את אותה זרימה כמו runtime.
- נוסף `sendContactCard` ל-`WhatsAppTransport` / `WhatsAppProvider`.
- ב-`WebJsProvider` כרטיס איש קשר נשלח כ-vCard native באמצעות `parseVCards: true`.
- ב-`BaileysProvider` כרטיס איש קשר נשלח כ-contact payload native.
- אם אין תמיכה ב-`sendContactCard`, המערכת נופלת חזרה לשליחת קובץ vCard, וזה משמר את Twilio/fallback.
- vCard מנורמל לפורמט טלפון בינלאומי, למשל `0504213243` -> `+972504213243`.

### קומיטים רלוונטיים

- `60eb060 Improve campaign contact card flow`
- `08182cd Fix regular contact card campaign flow`

שני הקומיטים נדחפו ל-`master`.

### בדיקות שבוצעו

- `npm run build` עבר.
- בדיקת קומפילציה ל-JavaScript הפנימי של `public/index.html` עברה.
- סימולציה למסלול רגיל עם כרטיס איש קשר native:
  - נשלחו `text + contact`.
  - משפט הסיום לא נשלח לפני הכרטיס.
  - ה-vCard הכיל מספר `+972...`.
- סימולציה למסלול fallback / Twilio-style:
  - נשלחו `text + file`.
  - קובץ vCard תקין.
  - משפט הסיום לא נשלח לפני הכרטיס.
- סימולציה ל-`wait_reply`:
  - pending נפתח אחרי הודעת המתנה.
  - pending נסגר אחרי תשובת משתמש.
  - ההודעה הבאה נשלחת רק אחרי תשובת המשתמש.

### לקוחות שנבדקו במהלך העבודה

- `https://client-account-abe6dcf5.flowsbiz.com/client/`
- `https://client-1-50c21291.flowsbiz.com/client/`
- `https://client-test-2a7fee14.flowsbiz.com/client/`

### מה לעשות בשיחה החדשה

1. לבצע redeploy ללקוחות הרלוונטיים אחרי `08182cd`.
2. לבדוק ב-`client-test-2a7fee14` שה-dry-run כבר לא מציג את המשפט `שמרתי אותך...` לפני כרטיס איש הקשר.
3. לבצע בדיקת קמפיין אמיתי במספר בדיקה:
   - טריגר
   - הודעה מקדימה / שאלת שם אם קיימת
   - תשובת שם
   - הודעה לפני כרטיס איש קשר
   - כרטיס איש קשר native בפרויקט רגיל
   - `wait_reply` אם מוגדר
   - הודעת המשך רק אחרי תשובה
4. לוודא ש-Twilio עדיין שולח vCard תקין במסלול קובץ.

### הערות זהירות

- לא לבצע deploy באמצע קמפיין פעיל אם רוב המשתמשים עדיין בתהליך.
- במסמכי היציבות כבר תועדו בעיות סביב pending states, timers וניתוקי Baileys. בתיקון הנוכחי נבדקו במיוחד פתיחה/סגירה של pending ושליחת fallback.
- קיימים בקובץ העבודה שינויים/קבצים לא קשורים שלא שייכים לתיקון הזה. לא למחוק או לאפס אותם בלי בדיקה.
## Recent Twilio campaign updates - 2026-06-26

This section documents the latest Twilio campaign behavior and compatibility notes.

### Twilio inbound routing

- Twilio WhatsApp numbers may share the same incoming webhook URL on the admin gateway:
  `https://admin.flowsbiz.com/webhooks/twilio/whatsapp?token=...`
- The gateway routes inbound messages by the Twilio `To` number when possible, using the managed client `twilioFrom` value.
- Having two active Twilio numbers is supported. It is safe when each managed client has the correct `twilioFrom` value and the client app has `TWILIO_FROM` set to the same sender.
- Duplicate trigger phrases inside the same client should not block routing. Ambiguity is only considered unsafe when the same trigger matches different clients.

### Existing clients and campaign compatibility

- The latest changes are runtime/API/UI changes. They do not rewrite saved campaign JSON and do not activate inactive campaigns.
- Existing campaigns keep their stored `decisionFlow`, contact-card settings, trigger phrase, status, and schedule.
- The new Excel format applies to existing campaigns after deploy because `/api/campaign-results/:id/export.xls` generates the workbook dynamically on download.
- Existing campaign results and events are not deleted by the export change.

### No-name campaigns

- For campaigns with `askNameEnabled=false`, the trigger handler records `whatsappName` when available.
- Contact saving uses `WhatsApp name + campaign suffix`; if WhatsApp name is unavailable, it falls back to `New Contact {phone}` or campaign/phone fallback in manual recovery.

### Flow recovery and ordering

- Flow `contact_card` steps send the intro text, then the contact card, then wait before the next step.
- The delay between contact-card delivery and the next step is now `max(BOT_REPLY_DELAY_MS, 4000)` milliseconds.
- If a `message` or `contact_card` flow step fails and a next step exists, the system waits 60 seconds and continues to the next step so users are less likely to get stuck.
- Trigger messages override pending handoff state, so sending the trigger again starts the campaign from the beginning.

### End-of-campaign recovery

- Campaign results now expose a management action to queue everyone who entered the campaign but is not yet saved.
- Endpoint: `POST /api/campaign-results/:id/queue-unsaved`.
- UI button: “Save unsaved” / “שמור מי שלא נשמר”.
- This queues contact save jobs without sending any WhatsApp message to the end user.

### Campaign Excel export

- The detailed Excel export no longer keeps all event history in one `Event details` cell.
- Events are split into separate columns:
  - `Event 1 at`, `Event 1 type`, `Event 1 details`
  - `Event 2 at`, `Event 2 type`, `Event 2 details`
  - and so on, based on the largest number of events for a person in that campaign.
- The old data remains in `campaignEvents`; only the export layout changed.

### Files involved

- `src/adminServer.ts`: Twilio gateway routing, campaign Excel export, queue-unsaved endpoint.
- `src/messageFlow.ts`: trigger restart behavior, contact-card delay, flow failure continuation.
- `src/storage.ts`: queue unsaved campaign results.
- `public/index.html`: campaign results button for queueing unsaved entrants.
- `src/providers/TwilioProvider.ts`: Twilio phone resolution support.

## Update - 2026-06-29 - Twilio campaign builder step 3

Scope: client campaign builder, mainly public/index.html.

What changed:

- Step 3 in the campaign wizard was reorganized into a Flow Timeline of blocks.
- The user now adds blocks through an Add Step selector instead of many separate quick-action buttons.
- Supported blocks remain: text message, button question, list question, score/survey question, wait-for-reply message, media/file block, and contact-card block.
- Settings that are not part of the middle flow were moved to Step 4: completion message/files/links, no-answer timeout handling, and human handoff message.
- No capability was intentionally removed.
- Default next-step behavior changed: when a block has no explicit next target, it continues to the next block in the timeline. The last block ends the flow.
- Existing deployments are not affected until the relevant client app is redeployed. Commit/push alone only updates Git unless Dokploy auto-deploy is enabled.

Verification performed:

- Inline JavaScript in public/index.html was parsed successfully with Node.
- npm run build passed.

Important files:

- public/index.html - client UI/wizard and decision-flow serialization.

Recommended test in a fresh client campaign:

1. Create a campaign and go to Step 3.
2. Add blocks in this order: text, contact card, wait-for-reply/question, media/file.
3. Save and confirm that empty next-step selections follow the visible timeline order.
4. Confirm Step 4 contains completion settings, no-answer settings, and human handoff settings.

