# בדיקה חיה ראשונה של Embedded Signup — ממצאים ובקשות לאישור

תאריך: 2026-10-13
מסמכי רקע: `docs/embedded-signup-automation-plan-2026-09-28.md`, `docs/embedded-signup-coexistence-event-contract-finding-2026-09-29.md`, `META_API_SETUP.md` (עדכון 2026-10-12)

## 1. מה נבדק

- שירות המנהל על `6d93f26`, עם `META_EMBEDDED_SIGNUP_CONFIG_ID=28683928974581381` (Configuration חדש: v4, טוקן System-user לתוקף **Never**, הרשאות `whatsapp_business_management` + `whatsapp_business_messaging`).
- לקוחה דמה: `c5c11caa-9a0b-4273-a1b0-c92845ad2b8e` (`client-bdykh-meta-c5c11caa`).
- תיק עסקי של "לקוחה": FlowsBiz `1974558669932435` (לא התיק שבבעלותו `boot1`).
- מספר ניסוי: `+972772303425`.

## 2. מה קרה

1. בתוך חלון Meta בעל המערכת **הזין את המספר ואימת אותו בקוד** (SMS/שיחה) — כלומר המסלול הרגיל של מספר חדש ל-Cloud API, **לא** מסלול Coexistence (שבו אין קוד, אלא אישור מתוך אפליקציית WhatsApp Business).
2. Meta יצרה WABA בשם "FlowsBiz test" עם המספר.
3. בצד שלנו, השרשרת כולה עבדה: החלפת הקוד לטוקן, `debug_token`, גילוי המספר דרך `GET /<waba>/phone_numbers`, `subscribed_apps`, שמירה ופריסה של הלקוחה.
4. שני צעדי `smb_app_data` נכשלו:
   `smb_app_state_sync: Graph API (400): (#133010) Account not registered | history: Graph API (400): (#133010) Account not registered`
   הלקוחה נשארה `in_progress / smb_sync_failed` (`src/adminServer.ts:3172`).

## 3. אבחנה

הקוד בנוי **רק** ל-Coexistence: הוא לעולם לא קורא ל-`POST /<phone_number_id>/register` (`src/metaEmbeddedSignup.ts:165`, בכוונה — במסלול Coexistence register עלול לנתק את האפליקציה) ובמקומו מריץ סנכרון `smb_app_data`. במסלול הרגיל המספר **חייב** register כדי לשלוח/לקבל ב-Cloud API, והסנכרון לא רלוונטי (אין אפליקציה לסנכרן ממנה). שגיאת `#133010` היא בדיוק "המספר לא נרשם".

למה Meta הציגה את המסלול הרגיל: דף החיבור (`owner-public/connect-meta.html`) קרא ל-`FB.login` עם `extras: { setup: {} }` בלבד, בלי `featureType: 'whatsapp_business_app_onboarding'` — הפרמטר שלפי מדריך Coexistence של Meta מפעיל את מסלול האפליקציה.

## 4. מצב נוכחי של הלקוחה הדמה

- המספר שייך ל-WABA "FlowsBiz test", **לא רשום** ב-Cloud API → לא שולח ולא מקבל.
- "נסה שוב" בדשבורד ייכשל שוב באותה שגיאה (הוא מריץ רק את הסנכרון).
- `metaSmbSyncFirstFailedAt` נקבע → בעוד ~20 שעות תצא התראה על סנכרון שלא הושלם (`src/adminServer.ts:3210`). עבור לקוחה זו ההתראה היא רעש צפוי.

## 5. שינוי שכבר נעשה מקומית (לא בקומיט) — דורש אישור או ביטול

ב-`owner-public/connect-meta.html`:
- `extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }`
- טיפול באירוע `FINISH_ONLY_WABA` → הודעת שגיאה ברורה במקום "מתחבר..." תקוע.

השינוי נעשה לפני שהתברר שהמספר כן הוזן ואומת (ההנחה הראשונה הייתה ש-Meta דילגה על שלב המספר — שגויה). הוא עדיין רלוונטי רק אם מחליטים "Coexistence בלבד" (החלטה 6.1). **לא ידוע** אם `featureType` משפיע ב-v4: מדריך Coexistence אומר להוסיף אותו; דף הגרסאות מציג את `extras` ריק ב-v4. לא ידוע גם אם עם `featureType` Meta עדיין מאפשרת מספר חדש, או מגבילה למספרי אפליקציה בלבד.

## 6. החלטה של בעל המערכת (לא לאישור Codex)

**6.1 אילו מסלולים נתמכים?**
- (א) **Coexistence בלבד** — כמו בתכנון. משאירים את `featureType`. לקוחה בלי אפליקציית WhatsApp Business לא יכולה להתחבר. הבדיקה הבאה דורשת מספר שפעיל באפליקציה.
- (ב) **שני המסלולים** (המלצה) — לקוחה עם אפליקציה עוברת Coexistence, לקוחה בלי אפליקציה מקבלת מספר חדש. דורש את שינוי הקוד בסעיף 7. מספר ה-077 הנוכחי ישמש לבדיקת המסלול הרגיל.

## 7. בקשות לאישור (אם נבחרה 6.1(ב))

**7.1 בחירת מסלול בצד השרת, לא לפי הדפדפן.** אחרי גילוי המספר: `GET /<phone_number_id>?fields=is_on_biz_app,platform_type` (השדות שמדריך Coexistence מציין). `is_on_biz_app === true` → מסלול Coexistence (סנכרון, **אסור** register). אחרת → מסלול רגיל. לא סומכים על שם האירוע מהדפדפן (`FINISH` מול `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) להחלטה הזו, כי טעות לכיוון register על מספר אפליקציה מנתקת את הלקוחה.
  - **לאמת בבנייה:** ערכי השדות בפועל עבור מספר ה-077 (רגיל, לא רשום) — לתעד את התשובה הגולמית לפני שמסתמכים עליה. אם השדות לא קיימים/לא חד-משמעיים — לעצור ולשאול, לא לנחש.

**7.2 מסלול רגיל:** `POST /<phone_number_id>/register` עם `{ messaging_product: 'whatsapp', pin }`. ה-PIN (6 ספרות) נוצר אקראית בשרת, נשמר בלקוחה (שדה חדש, מוסר מ-`exposeOwnerClient` כמו הטוקן) — הוא קובע את אימות-שני-השלבים של המספר ונדרש לכל register עתידי. בלי סנכרון `smb_app_data`, בלי `metaSmbSyncFirstFailedAt`. כשל ב-register → `in_progress / register_failed` + "נסה שוב" שמריץ את הצעד החסר בלבד (בלי החלפת קוד חוזרת, כמו היום בסנכרון).

**7.3 "נסה שוב" ללקוחה הדמה:** אחרי הפריסה, "נסה שוב" צריך לזהות שזה מסלול רגיל ולבצע register — כך שהלקוחה הקיימת נבדקת בלי חיבור מחדש. לנקות את `metaSmbSyncFirstFailedAt` כשמתברר שהמסלול רגיל.

**7.4 בדיקות** (stub ל-`global.fetch`, באותו סגנון כמו הבדיקות הקיימות של ההשלמה):
- `is_on_biz_app: true` → אפס קריאות register, שני סנכרונים.
- `is_on_biz_app: false` → register אחד עם PIN של 6 ספרות, אפס סנכרונים, סטטוס `connected`.
- register נכשל → `register_failed`, "נסה שוב" מצליח בלי החלפת קוד.
- לקוחה במצב `smb_sync_failed` שמתבררת כמסלול רגיל → "נסה שוב" עושה register ומנקה את `metaSmbSyncFirstFailedAt`.
- ה-PIN לא מופיע בתשובות API לדשבורד ולא בלוגים.
- להוסיף ל-`scripts/regression-manifest.txt`.

**7.5 `featureType` ב-6.1(ב):** לא לשלוח אותו (המסך הרגיל של Meta מציע גם מספר חדש וגם — לפי ההנחה — חיבור אפליקציה). **לאמת בבדיקה** שהמסך בלי `featureType` אכן מציע אפשרות לחבר אפליקציה קיימת; אם לא — שני כפתורים בדף החיבור ("יש לי WhatsApp Business בטלפון" / "מספר חדש") שבוחרים את ה-`extras`.

## 7א. החלטות (2026-10-13)

- **בעל המערכת בחר 6.1(ב) — שני המסלולים. Codex אישר את סעיף 7** בתוספות:
  - ערך `is_on_biz_app`/`platform_type` חסר או לא חד-משמעי → שגיאה, **בלי** register ובלי סנכרון.
  - מסלול רגיל רק כשהמספר אומת **במפורש** כלא-Biz-App.
  - ה-PIN לא נחשף בשום API, דשבורד, התראה או לוג (הסתרה כמו `metaAccessToken`).
  - `business_management` אינו חסם — הבדיקה החיה עברה עם שתי הרשאות WhatsApp בלבד.
  - Configuration בשימוש: `28683928974581381` בלבד.
- **`featureType` בוטל** מ-`connect-meta.html` (לפי 7.5). טיפול ב-`FINISH_ONLY_WABA` (הודעת שגיאה) נשאר.

## 7ב. מגבלה מחייבת של בעל המערכת: אפס פגיעה בקמפיינים ובשער

> "באף שלב לא פוגעים בתשתית קיימת של הקמפיינים. בוט שירות הלקוחות (מספר ייעודי) נפרד לחלוטין, ולא יעמיס על השער."

**גבולות הבנייה של סעיף 7 (חובה):**
1. קבצים מותרים: `src/metaEmbeddedSignup.ts`, נתיבי ההשלמה ו"נסה שוב" של Embedded Signup ב-`src/adminServer.ts`, טיפוסי `ManagedClient`/`exposeOwnerClient`, דשבורד המנהל (`owner-public/client.html`) לטקסט סטטוס, ובדיקות.
2. **אסור לגעת** ב: `routeMetaGatewayInbound` וכל מסלול ה-webhook של השער, `src/metaGatewayInbox.ts`, `src/metaGatewayReliability.ts`, `src/metaCampaignRouting.ts`, `src/messageFlow.ts`, `src/serviceBot.ts`, `src/outboxDispatcher.ts`, `src/inbox/*`.
3. קריאות `register`/`smb_app_data`/`is_on_biz_app` מתבצעות **רק** בזמן חיבור או "נסה שוב" (פעולה חד-פעמית של מנהל/לקוחה), אף פעם לא במסלול הודעה נכנסת.
4. כל ה-`scripts/regression-manifest.txt` ירוק, כולל בדיקות השער והמספר המשותף, לפני קומיט.
5. פריסה: שירות המנהל בלבד. אחרי הפריסה — טריגר של קמפיין קיים על המספר המשותף עובד.

**ממצא שנוגע למגבלה ודורש החלטה נפרדת (לא חלק מהבנייה הנוכחית):** Meta שולחת webhook **אחד לכל האפליקציה** — לכן גם היום הודעות למספר ייעודי עוברות דרך השער (`/webhooks/meta/whatsapp`). השער כבר מבודד אותן **לוגית** (scope לפי `phone_number_id`, בלי שאילתות pending ללקוחות המספר המשותף — `src/adminServer.ts:1410`), אבל לא **בעומס**: כל הודעה, וכל אירוע `history`/`smb_message_echoes` (סנכרון היסטוריה ב-Coexistence יכול להיות פרץ גדול), נכנס לשער ומסונן שם (`ef24887`).
- **הצעה לבדיקה (לא מאומתת):** Meta תומכת ב-webhook override ברמת WABA (`POST /<WABA_ID>/subscribed_apps` עם `override_callback_uri` + `verify_token`), שמפנה את כל ה-webhooks של אותו WABA ישירות לכתובת אחרת — כאן: הקונטיינר של הלקוחה עצמה. כך מספר ייעודי לא נוגע בשער בכלל.
- **מחיר:** הקונטיינר של הלקוחה יצטרך לאמת חתימת Meta בעצמו, כלומר לקבל את `META_APP_SECRET` (היום רק אצל המנהל), ונקודת webhook חדשה בלקוחה.
- **המלצה:** לפני הלקוחה האמיתית הראשונה במסלול Coexistence (שם פרץ ההיסטוריה). לאמת את ה-API מול Meta, לכתוב מסמך נפרד לאישור Codex.

## 8. מה המסמך הזה לא קובע

- לא נבדק עדיין מסלול Coexistence עצמו מול Meta (אף מספר אפליקציה לא חובר).
- לא ידוע איך v4 מתייחס ל-`featureType`.
- לא נבדק שה-webhook של המספר החדש מגיע לשער ומנותב ללקוחה הדמה — אפשרי רק אחרי register.
- לא נבדק מחיר/תמחור למספר במסלול הרגיל (ה-WABA החדש בלי אמצעי תשלום: רק תגובה לשיחות שהמשתמש יזם).

## 9. תוספת אחרי הבנייה (`6788b1f`) — ממצא חוסם ובקשת אישור

**ממצא (נמדד, 2026-10-13):** קריאת GET אחת מתוך שירות המנהל, עם הטוקן של הלקוחה הדמה, למספר `1431785960010469` (972772303425, WABA `1113941471332964`):

```
{"is_on_biz_app":false,"platform_type":"NOT_APPLICABLE","status":"PENDING","code_verification_status":"VERIFIED","name_status":"AVAILABLE_WITHOUT_REVIEW"}
```

`6788b1f` מחייב `platform_type === 'CLOUD_API'` גם במסלול הרגיל. עבור מספר שעוד לא נרשם Meta מחזירה `NOT_APPLICABLE`, ולכן `detectMetaOnboardingPath` זורק שגיאה, `register` לא רץ, והלקוחה הדמה לא תשוקם — בדיוק התרחיש שהשינוי נבנה עבורו. הבדיקות עברו כי ה-stub החזיר `false` + `CLOUD_API`, ערך שלא נמדד מול Meta. (`CLOUD_API` במסלול הרגיל מופיע רק אחרי register מוצלח.)

**בקשה לאישור — תיקון כלל הזיהוי:**
- `is_on_biz_app === true` ו-`platform_type === 'CLOUD_API'` → `coexistence` (ללא שינוי).
- `is_on_biz_app === false` ו-`platform_type` ∈ {`NOT_APPLICABLE` (טרם נרשם — נמדד), `CLOUD_API` (כבר נרשם — ריצה חוזרת)} → `cloud_api`.
- כל צירוף אחר (כולל `true` + `NOT_APPLICABLE`, `ON_PREMISE`, שדה חסר) → שגיאה, ללא register וללא סנכרון.
- הבטיחות נשמרת: register רץ רק כש-Meta מאשרת במפורש `is_on_biz_app === false`.
- בדיקות: להחליף את ה-stub של המסלול הרגיל בתשובה הגולמית שנמדדה למעלה (כולל `status: PENDING`), ולהוסיף מקרה `false` + `CLOUD_API` (ריצה חוזרת) ומקרה `true` + `NOT_APPLICABLE` (שגיאה).

## 10. בדיקה חיה מלאה (2026-10-13, אחרי `dcc5d5f`) — הצלחה + שני ממצאי בידוד

### 10.1 מה עבד

- **"נסה שוב" שיקם את הלקוחה הדמה** בלי Signup חדש: `metaOnboardingPath=cloud_api`, `status=connected/completed`, PIN שמור, `metaSmbSyncFirstFailedAt` נוקה. מול Meta המספר עבר `PENDING → CONNECTED` ו-`NOT_APPLICABLE → CLOUD_API`.
- **בוט שירות על המספר הייעודי** (972772303425): "תפריט" → `META_GATEWAY_ROUTED ... campaign=__service_bot__ clients_checked=1 route_ms=86`, ואחריו 3 מעברי תפריט אינטראקטיביים, כולם `clients_checked=1`.
- **קמפיין על המספר המשותף** אחרי הפריסה: `META_GATEWAY_ROUTED ... 4b004adb campaign=mu52hpopjuev clients_checked=14 route_ms=170`, הזרימה רצה עד הסוף.
- הודעת מערכת של Meta למספר הייעודי (16465894168) → `no_trigger_or_pending_conversation`, כלומר התעלמות נכונה.

### 10.2 ממצא A — מספר משותף סורק גם לקוחות של מספרים ייעודיים (כיוון הפוך לבידוד שנדרש)

`src/adminServer.ts:1886`: `const clients = sharedAdminNumber ? allMetaClients : exactPhoneIdClients…`. כלומר הבידוד לפי `phone_number_id` פועל **רק בכיוון אחד**: הודעה למספר ייעודי נשארת אצל הלקוחה שלו (`clients_checked=1`, נמדד), אבל הודעה למספר **המשותף** פונה ל**כל** לקוחות Meta, כולל אלה שעל מספרים ייעודיים. נמדד בלוג 08:41:17: 14 `META_ROUTES_CACHE_HIT`, הראשון שבהם הוא `c5c11caa` (הלקוחה על המספר הייעודי), ואחריו `[META_GATEWAY_CLEAR_PENDING] c5c11caa removed=0`.

שתי השלכות:
1. **עומס וסיכון fail-closed על הקמפיינים:** כל לקוחה חדשה עם מספר ייעודי מוסיפה שאילתה חיה לכל הודעה על המספר המשותף, ולקוחה ייעודית שלא זמינה יכולה לעכב קמפיינים שאין להם שום קשר אליה. זו בדיוק המגבלה בסעיף 7ב ("בוט השירות לא יעמיס על השער").
2. **cross-talk של pending:** ה-pending מזוהה לפי שולח בלבד, לא לפי שולח+מספר. משתתף שנמצא באמצע שיחה עם בוט שירות על מספר ייעודי, ואז שולח טריגר קמפיין למספר המשותף, גורם ל-`clear-pending` **על השיחה בבוט השירות**. בבדיקה הזו `removed=0` (השיחה כבר נגמרה) ולכן לא נשבר כלום, אבל המנגנון פעיל.

**הצעה (לאישור):** ב-`sharedAdminNumber`, לסנן החוצה לקוחות שיש להן `metaPhoneNumberId` שונה מהמשותף — בדיוק ההיפוך של `exactPhoneIdClients`, וזהה לכלל ה-scope שכבר קיים ב-`metaTriggerScope` (`src/adminServer.ts:1402`) לבדיקת ייחודיות טריגרים. שינוי קטן בשורה אחת, אבל הוא **נוגע במסלול ההודעות של השער** ולכן חורג מגבולות 7ב: דורש מסמך/אישור נפרד ובדיקות ייעודיות (הודעה למספר המשותף לא פונה ללקוחה ייעודית; שתי לקוחות על מספרים ייעודיים שונים לא רואות זו את זו; התנהגות המספר המשותף ל-11 הלקוחות שעליו לא משתנה).

### 10.3 ממצא B — סטטוסי מסירה משודרים לכל הלקוחות, בלי scope

`src/adminServer.ts:2475` ("Delivery statuses are broadcast to every managed Meta client (each ignores what it does not own)") — התנהגות מכוונת ומתועדת, אבל במספרים ייעודיים היא מתבטאת כך (נמדד): סטטוסים של בוט השירות **על המספר הייעודי** הגיעו ללקוחת הקמפיין על המספר המשותף (`META_DELIVERY_UNTRACKED` בלוג של `client-pvkvs`), וסטטוסים של הקמפיין **על המספר המשותף** הגיעו ללקוחה הייעודית (`META_STATUS_FOREIGN` בלוג של `client-bdykh`).

**אין כאן באג נכונות** — כל צד דוחה מה שאינו שלו, וזה בדיוק מה שהלוגים האלה אומרים. זו עלות עומס: כל סטטוס נשלח ל-N לקוחות במקום ל-1, והיא גדלה לינארית עם מספר הלקוחות. ככל שמספרים ייעודיים יתרבו זה יהפוך למשמעותי.

**הצעה (לאישור):** לסנן את יעדי השידור לפי `phone_number_id` של ה-envelope, באותו כלל scope של 10.2. גם זה מסלול חם של השער, ולכן באותו מסמך נפרד.

### 10.4 מה זה לא

שני הממצאים **אינם רגרסיה** של `6788b1f`/`dcc5d5f` — הם קדמו להם ונחשפו רק עכשיו, כשלראשונה יש בייצור לקוחה על מספר ייעודי. לא נבדק עדיין: מסלול Coexistence עצמו, התנהגות תחת פרץ `history` של סנכרון, ומה קורה כששתי לקוחות ייעודיות קיימות במקביל.
