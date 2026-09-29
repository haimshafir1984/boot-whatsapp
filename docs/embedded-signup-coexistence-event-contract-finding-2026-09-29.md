# ממצא: אירוע ה-Coexistence לא כולל phone_number_id

תאריך: 2026-09-29. נמצא באימות שלב 3 (3.1-3.3) של `docs/embedded-signup-automation-plan-2026-09-28.md`, לפני כתיבת קוד — לפי דרישת סעיף 8 באותו מסמך ("כל ממצא שסותר את המסמך: לעצור, לתעד ולשאול. לא לנחש").

## מה המסמך המקורי הניח

סעיף 3.2:
> מאזין אירוע: `window.addEventListener('message', ...)` ... הוא קולט את אירוע `WA_EMBEDDED_SIGNUP` עם `FINISH` (`waba_id`, `phone_number_id`) ...

סעיף 3.3 שלב 1 (מוזכר גם ב-3.2): הדף שולח לשרת `{ code, wabaId, phoneNumberId }` — כלומר שני המזהים מגיעים מהדפדפן ישירות מתוך אירוע ה-`FINISH`.

## מה מצאתי מול התיעוד הרשמי של Meta (שתי שליפות נפרדות)

1. דף Coexistence הרשמי (`onboarding-business-app-users`):
   > "Capture the customer's asset IDs and exchangeable token code..."
   מבנה האירוע המתועד עבור המסלול הזה:
   ```json
   {
     data: { waba_id: "<CUSTOMER_WABA_ID>" },
     type: "WA_EMBEDDED_SIGNUP",
     event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
     version: 3
   }
   ```
   **ה-`data` מכיל רק `waba_id`. אין `phone_number_id`.** בנוסף השם של האירוע עצמו הוא `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, לא `FINISH` הרגיל.

2. דף `embed-the-flow` (הכללי, על כל וריאנטי ה-FINISH):
   מפרט את מבנה ה-`data` **רק** עבור `FINISH` הרגיל (Cloud API, ללא Coexistence) — כולל `phone_number_id`, `waba_id`, `business_id`. עבור `FINISH_ONLY_WABA` ו-`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` הדף רק מזכיר את שם האירוע בטבלה, ואינו מפרט שדות. אין שום אזכור ששני האירועים האלה כוללים `phone_number_id`.

**המסקנה:** בניגוד להנחת סעיף 3.2, אין אישור בתיעוד הרשמי שהדפדפן מקבל `phone_number_id` במסלול ה-Coexistence. יש אישור מפורש שהוא **לא** מגיע ב-`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`.

איך בכל זאת משיגים את המספר: אותו דף Coexistence מציע לבדוק את השדות `is_on_biz_app` ו-`platform_type` על ה-phone number ID — אבל זה דורש שכבר יודעים את ה-ID מראש, ולא מסביר איך מגיעים אליו מתוך `waba_id` בלבד. הדרך הסבירה (וכבר קיימת בתוכנית, סעיף 3.3 שלב 4): `GET /<wabaId>/phone_numbers` עם הטוקן שהוחלף, שמחזיר את כל המספרים ששייכים ל-WABA. זה כבר צעד מתוכנן במסמך המקורי (שם השימוש בו היה רק לאימות שהמספר שנשלח מהדפדפן באמת שייך ל-WABA) — כאן הוא צריך להפוך למקור **היחיד** של האמת, לא רק לאימות.

## למה זה משנה לקוד

1. **חוזה ה-API בין הדף לשרת (3.2, 3.3):** אי אפשר להניח ש-`phoneNumberId` מגיע מהדפדפן. חייבים לבנות זאת כך שהשרת מגלה את המספר בעצמו מתוך `wabaId` (דרך `GET /<wabaId>/phone_numbers`, כבר בתוכנית ממילא).
2. **שם האירוע:** מאזין ה-`message` בדף החיבור צריך לזהות `event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'`, לא (רק) `FINISH` — או את שניהם, בהתאם למה שבאמת יגיע בפועל מה-Configuration שהוגדר ל-`boot1` (זה עוד לא ידוע, כי אף Configuration לא הוקם עדיין — ראו "פתוח" למטה).
3. **מה אם ל-WABA יש יותר ממספר אחד?** תרחיש קצה: לקוחה עם כמה מספרים תחת אותו WABA. Coexistence מיועד ללקוחה עם מספר אחד קיים באפליקציה, כך שבפועל זה אמור להיות נדיר, אבל השרת חייב להתנהג בצורה מוגדרת (למשל: אם `GET /<wabaId>/phone_numbers` מחזיר יותר ממספר אחד, לעצור ולהחזיר שגיאה ברורה, ולא לנחש איזה מספר).

## המלצה (לא מומש עדיין - מחכה לאישור)

- לבנות את 3.2/3.3 כך שהדף שולח לשרת `{ code, wabaId }` בלבד (בלי להסתמך על `phoneNumberId` מהדפדפן כלל).
- השרת, אחרי החלפת הקוד וה-`debug_token` (שלבים 2-3 הקיימים), קורא ל-`GET /<wabaId>/phone_numbers`:
  - אם יש **בדיוק מספר אחד** — זה `phoneNumberId`, ממשיכים כרגיל (שלב 4 והלאה, ללא שינוי).
  - אם יש **אפס או יותר ממספר אחד** — עוצרים, שומרים שגיאה ברורה ב-`metaOnboarding.error`, ושולחים התראה לבעל המערכת. לא לנחש איזה מספר לבחור.
- מאזין ה-`message` בדף מזהה גם `FINISH` וגם `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` כהצלחה (לוקח את `data.waba_id` משניהם; אם `FINISH` הרגיל כן מכיל `phone_number_id` - הוא ייקלט אבל לא ייסמך עליו, בהתאם לחוק הקיים בסעיף 3.3 ש"לא סומכים על מזהים שמגיעים מהדפדפן").

## עדיין פתוח - לא ניתן לאמת ללא Configuration אמיתי

- **אין תיעוד רשמי** על פרמטר JS SDK (`extras`/`featureType`) שמפעיל את מסך ה-Coexistence ב-`FB.login`. שתי הדפים הרשמיים ששלפתי לא מזכירים פרמטר כזה. הדף היחיד שמתאר את ההפעלה אומר רק: "אם אחרי שההגדרה בוצעה נכון, מסך בחירת ה-WABA הוחלף במסך שמציע לחבר חשבון WhatsApp Business קיים - הפיצ'ר מופעל". זה מרמז שההפעלה קורית ברמת ה-**Configuration** ב-App Dashboard (סעיף 4 במסמך המקורי, פעולה ידנית של בעל המערכת), לא בקוד. **לא ניתן לאמת זאת בוודאות בלי configuration אמיתי מוקם בפועל ב-`boot1`.**
- כשבעל המערכת יקים את ה-Configuration (סעיף 4, פעולה 1), יש לבדוק אם קיימת שם אפשרות מפורשת להפעיל Coexistence, ולדווח מה בדיוק מופיע.

## החלטה (אושרה 2026-09-29) ומומש

1. השרת מגלה את `phoneNumberId` לבד, דרך `GET /<wabaId>/phone_numbers` — לא נסמך על הדפדפן.
2. יותר ממספר אחד תחת אותו WABA: עצירה עם שגיאה, בלי מסך בחירה.

מומש ב-[metaEmbeddedSignup.ts](../src/metaEmbeddedSignup.ts) (`discoverMetaDedicatedPhoneNumberId`) ובראוטים ב-`adminServer.ts` (שלב 7.3 במסמך התוכנית).

## שאלה לבעל המערכת (לארכיון - כבר נענתה למעלה)

1. לאשר את הגישה המומלצת למעלה (שרת מגלה `phoneNumberId` מ-`wabaId` דרך `GET /<wabaId>/phone_numbers`, במקום לקבל אותו מהדפדפן) — או להעדיף גישה אחרת?
2. איך לטפל במקרה של יותר ממספר אחד תחת אותו WABA בזמן החיבור: לעצור עם שגיאה (מוצע), או לבנות מסך בחירה ללקוחה? (מסך בחירה הוא תוספת UI שלא הייתה בהיקף המקורי.)
