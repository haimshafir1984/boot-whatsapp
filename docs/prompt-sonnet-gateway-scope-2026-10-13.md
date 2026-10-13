אתה עובד על הפרויקט FlowsBiz ב-`C:\Users\haim\Projects\parpar sagol` (TypeScript/Node, ענף `master`). קרא קודם את `CLAUDE.md` במלואו, במיוחד את הסעיף "מספר Meta משותף ושער מרכזי".

## המשימה

לממש את `docs/gateway-dedicated-number-scope-plan-2026-10-13.md`, סעיפים 4.1–4.5. קרא את המסמך כולו לפני שאתה כותב שורה. התוכנית אושרה על ידי Codex (סעיף 7) ועל ידי בעל המערכת. אל תשנה החלטות שבמסמך — אם הקוד סותר אותו, **עצור ושאל**.

## אזהרה: זה המסלול הכי רגיש במערכת

אתה נוגע ב-`routeMetaGatewayInbound` ובשידור הסטטוסים — המסלול שדרכו עוברות **כל** ההודעות של 11 לקוחות ייצור על המספר המשותף. באג כאן שובר קמפיינים חיים. הכלל: **הקבוצה של 11 לקוחות המספר המשותף חייבת להישאר זהה לחלוטין למה שהיא היום.** כל מה שהשינוי עושה הוא להוציא מהקבוצה לקוחות שיש להן `metaPhoneNumberId` ייעודי.

## מה לבנות

1. **4.1 — כלל scope אחד.** פונקציה אחת (למשל `metaPhoneScope(client): string`) שמחזירה `phone:<id>` ללקוחה עם `metaPhoneNumberId` שאינו המספר המשותף, ו-`shared` אחרת (כולל כשהשדה ריק). זו **בדיוק** הלוגיקה שכבר קיימת ב-`metaTriggerScope` (`src/adminServer.ts:1402`). אם אפשר — ש-`metaTriggerScope` ישתמש בה, כדי שלא יהיו שני כללים שיכולים להיפרד. אם זה מסבך את בדיקת ייחודיות הטריגרים, השאר אותו כפי שהוא וכתוב קומנט שמפנה לפונקציה החדשה.
2. **4.5 — קודם כל קביעת ה-scope של ה-envelope** (`src/adminServer.ts:1884`). כש-`phone_number_id` קיים, **הוא לבדו** קובע; `display_phone_number` משמש רק כשה-ID חסר. סתירה בין השניים → ללכת לפי ה-ID, `notifySystemAlert` ברמת `warning` עם מפתח `meta-gateway-metadata-conflict-<phoneNumberId>`, **בלי לחסום** את ההודעה. בנה את זה **לפני** 4.2, כי 4.2 נשען עליו.
3. **4.2 — ניתוב נכנס** (`src/adminServer.ts:1886`): כשה-envelope שייך למספר המשותף, לסנן החוצה לקוחות שה-scope שלהן אינו `shared`. מסלול המספר הייעודי כבר מסונן — אל תיגע בו.
4. **4.3 + 4.4 — יעדי הסטטוסים** (`statusTargetClients` / `enqueueMetaStatusForward`, `src/adminServer.ts:2513`): לסנן לפי `phone_number_id` של ה-envelope (זמין ב-`value.metadata.phone_number_id`, כבר נקרא ב-`:1681`).
   - אין `phone_number_id` → שידור לכולם, כמו היום.
   - יש `phone_number_id` **ואין אף לקוחה תואמת** → שידור לכולם, כמו היום, **פלוס** `notifySystemAlert` warning עם מפתח `meta-status-unknown-phone-number-<phoneNumberId>`. **לעולם לא 0 יעדים** — זה היה מאשר את ה-webhook ומאבד את הסטטוס (אומת: `src/metaStatusQueue.ts:112` מקבל מערך ריק בלי שגיאה).
   - הסינון קורה **רק ב-enqueue**. אל תיגע בפריטים שכבר בתור, ואל תשנה את `client_not_a_target` ב-`:2600`.

## גבולות

- **מותר לגעת:** `src/adminServer.ts` (רק שלושת האזורים למעלה), בדיקות, `scripts/regression-manifest.txt`.
- **אסור לגעת:** `src/metaGatewayInbox.ts`, `src/metaGatewayReliability.ts`, `src/metaCampaignRouting.ts`, `src/metaStatusQueue.ts`, `src/messageFlow.ts`, `src/serviceBot.ts`, `src/outboxDispatcher.ts`, `src/inbox/*`, וקוד הלקוח. אין שינוי בצד הלקוחות.
- אל תשנה את לוגיקת ה-fail-closed עצמה (`routeListFailures`, `clear-pending`). אתה משנה **רק מי ברשימה**, לא מה קורה לכשל.

## בדיקות

סעיף 5 במסמך, 10 פריטים — כולם חובה. בנה בסגנון `scripts/test-meta-gateway-lookup-failure-isolation.js` (שרת מנהל אמיתי, לקוחות מדומים, ספירת קריאות בפועל), ולא מימוש מקביל. דגשים:

- בדיקה 1 ו-5 נמדדות בספירת קריאות: **0** קריאות `meta-pending-route` ו-**0** `meta-clear-pending` ללקוחה שמחוץ ל-scope.
- **בדיקה 3 היא בדיקת אי-הנסיגה החשובה ביותר:** לקוחה על המספר המשותף שאינה זמינה **חייבת** להמשיך לחסום בדיוק כמו היום. אם היא נופלת — עצור, אל "תתקן" אותה.
- בדיקה 7: לוודא ש-`enqueue` קיבל את **כל** הלקוחות, ושנרשמה התראה.
- בדיקה 8: שני הכיוונים של הסתירה.
- קובץ חדש → להוסיף ל-`scripts/regression-manifest.txt`.

הרצה: `npm run build`, הבדיקות החדשות, ואז `node scripts/run-regression.js`. **הכול ירוק.** `test-backup-tool.js` יוצא `BLOCKED` בסביבה הזו (חסר `pg_dump`) — זה קיים מראש ולא קשור. אם בדיקה אחרת נכשלת, בדוק עם `git stash` אם היא נכשלת גם בלי השינוי, ודווח. אל תרכך בדיקה קיימת כדי שתעבור.

## git

- בעץ העבודה יש קבצים שהשתנו ואינם שלך: `CLAUDE.md`, `META_API_SETUP.md`, `PROJECT_HANDOFF.md`, `package.json`, `scripts/lib/*`, `scripts/measure-peak-3campaigns.js`, `docs/*` ועוד. **אל תכלול אותם בקומיט**, חוץ מהשורות שאתה מוסיף ל-`regression-manifest.txt` (רק ההונק שלך; אימות ב-`git diff --cached` לפני קומיט; בלי `git add -i/-p` אינטראקטיבי).
- `docs/gateway-dedicated-number-scope-plan-2026-10-13.md` שייך למשימה — כן לכלול.
- קומיט אחד או שניים, הודעה באנגלית שמסבירה את ה"למה". **לא push, לא deploy.**

## בסיום — דווח

1. `git diff --stat` של הקומיט, ואישור שאף קובץ מרשימת ה"אסור לגעת" לא שונה.
2. איך בדיוק נקבעת הקבוצה היום לעומת אחרי השינוי, והראיה שהקבוצה של 11 לקוחות המספר המשותף לא השתנתה.
3. פלט הסיכום של `node scripts/run-regression.js`.
4. כל מקום שבו הקוד סתר את המסמך או שנאלצת להחליט בעצמך.
