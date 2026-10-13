אתה עובד על הפרויקט FlowsBiz ב-`C:\Users\haim\Projects\parpar sagol` (TypeScript/Node, ענף `master`). קרא קודם את `CLAUDE.md` במלואו.

## המשימה

לממש את סעיף 7 במסמך `docs/embedded-signup-first-live-test-2026-10-13.md`: תמיכה בשני מסלולי חיבור של מספר WhatsApp ייעודי ב-Embedded Signup — **Coexistence** (מספר שפעיל באפליקציית WhatsApp Business) ו**מספר רגיל** (מספר חדש שאומת בקוד ב-Cloud API). קרא את המסמך כולו, כולל 7א ו-7ב (החלטות ומגבלות מחייבות). התוכנית אושרה על ידי Codex ובעל המערכת. אל תשנה את ההחלטות — אם משהו בקוד סותר את המסמך, עצור ושאל.

רקע: בבדיקה חיה (13.10) חובר המספר `+972772303425` ללקוחה דמה `c5c11caa-9a0b-4273-a1b0-c92845ad2b8e` במסלול הרגיל. הקוד היום מניח Coexistence בלבד: לא קורא `register`, ומריץ `smb_app_data` שנכשל ב-`(#133010) Account not registered`. הלקוחה תקועה ב-`in_progress / smb_sync_failed`.

## מה לבנות

1. **זיהוי מסלול בשרת** (`src/metaEmbeddedSignup.ts`): פונקציה שקוראת `GET /<phone_number_id>?fields=is_on_biz_app,platform_type` ומחזירה `'coexistence' | 'cloud_api'`, או זורקת `MetaEmbeddedSignupError` כשהתשובה חסרה/לא חד-משמעית.
   - `is_on_biz_app === true` → `'coexistence'`.
   - `'cloud_api'` **רק** כשהמספר אומת במפורש כלא-Biz-App (`is_on_biz_app === false`). קבע את התנאי המדויק על `platform_type` לפי התיעוד של Meta (`developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/` ודף ה-phone number של Graph API), ותעד בקומנט מה בדקת ומאיפה.
   - כל דבר אחר → שגיאה. **אסור לנחש, ואסור לקרוא `register` כשלא בטוחים** — register על מספר אפליקציה מנתק את הלקוחה מהאפליקציה.
2. **register** (`src/metaEmbeddedSignup.ts`): `POST /<phone_number_id>/register` עם `{ messaging_product: 'whatsapp', pin }`, דרך `graphFetch` הקיים (שמסנן סודות מהשגיאות).
3. **PIN**: 6 ספרות, נוצר עם `crypto.randomInt`, נשמר בשדה חדש ב-`ManagedClient` (`src/ownerStorage.ts`, כולל טיפול ב-normalize/מיגרציה אם קיים לשדות דומים). נוצר פעם אחת לכל לקוחה ונשמר **לפני** הקריאה ל-register, כדי ש"נסה שוב" ישתמש באותו PIN. **לעולם לא** מוחזר מ-API, דשבורד, התראה (`notifySystemAlert` details) או לוג — להסיר אותו ב-`exposeOwnerClient` (`src/adminServer.ts` ~שורה 3075) כמו `metaAccessToken`.
4. **`runMetaEmbeddedSignupSteps`** (`src/adminServer.ts` ~שורה 3114): אחרי `subscribeMetaWabaApp`, לזהות מסלול (סעיף 1) ולשמור אותו בלקוחה (שדה חדש, למשל `metaOnboardingPath`).
   - `coexistence` → ההתנהגות הקיימת בדיוק (שני סנכרונים, `metaSmbSyncFirstFailedAt`, התראות).
   - `cloud_api` → register; **בלי** `smb_app_data`; לנקות `metaSmbSyncFirstFailedAt`. כשל ב-register → `saveMetaOnboardingState(clientId, { status: 'in_progress', step: 'register_failed', error })` + התראת warning (בלי PIN), ולא `connected`.
   - כשל בזיהוי → שגיאה כמו שאר הצעדים (לא ממשיכים לסנכרון או ל-register).
   - שים לב: היום "נסה שוב" (`POST /owner/api/clients/:id/meta-connect-retry`, ~שורה 3676) מריץ מחדש את כל `runMetaEmbeddedSignupSteps`. זה מה שיתקן את הלקוחה הדמה: בריצה החוזרת הזיהוי יחזיר `cloud_api` ו-register ירוץ. ודא ש-register על מספר שכבר נרשם (ריצה חוזרת אחרי הצלחה) לא מפיל את התהליך — בדוק בתיעוד של Meta מה קורה ב-register כפול עם אותו PIN, ותעד.
5. **דשבורד המנהל** (`owner-public/client.html`): טקסט סטטוס ל-`register_failed`, והצגת המסלול (Coexistence / מספר רגיל). שום הצגה של PIN.
6. **דף החיבור** `owner-public/connect-meta.html`: כבר מעודכן מקומית (טיפול ב-`FINISH_ONLY_WABA`). אל תוסיף `featureType` — הוחלט לא לשלוח אותו.

## גבולות מחייבים (סעיף 7ב במסמך) — הפרה = עצירה

- **אסור לגעת** ב: `routeMetaGatewayInbound` וכל מסלול ה-webhook של השער (`/webhooks/meta/whatsapp`, `/internal/meta/whatsapp`), `src/metaGatewayInbox.ts`, `src/metaGatewayReliability.ts`, `src/metaCampaignRouting.ts`, `src/messageFlow.ts`, `src/serviceBot.ts`, `src/outboxDispatcher.ts`, `src/inbox/*`.
- קריאות `register` / `smb_app_data` / זיהוי מסלול רק בזמן חיבור או "נסה שוב" — לעולם לא במסלול הודעה נכנסת.
- לא לשנות את התנהגות המספר המשותף בשום צורה.

## בדיקות

הרחב את הבדיקות הקיימות (`scripts/test-meta-embedded-signup-graph-calls.js`, `scripts/test-meta-embedded-signup-connect-flow.js`, `scripts/test-meta-embedded-signup-dashboard.js`) — אותו סגנון, stub ל-`global.fetch`, מול הקוד האמיתי (לא מימוש מקביל). חובה:
- `is_on_biz_app: true` → אפס קריאות register, שני סנכרונים (כמו היום).
- `is_on_biz_app: false` (+ platform_type מתאים) → register אחד עם PIN של 6 ספרות, אפס סנכרונים, סטטוס `connected`, `metaSmbSyncFirstFailedAt` נוקה.
- שדות חסרים / ערך לא צפוי → שגיאה, אפס register, אפס סנכרונים.
- register נכשל → `register_failed`; "נסה שוב" מצליח, עם **אותו** PIN, בלי החלפת קוד חוזרת.
- לקוחה במצב `smb_sync_failed` שמתבררת כמסלול רגיל → "נסה שוב" עושה register ומגיעה ל-`connected`.
- ה-PIN לא מופיע בתשובת `/owner/api/clients`, בתשובת retry, ב-details של התראות, ובפלט הקונסול (ללכוד `console.log/warn/error` בבדיקה).
- אם נוסף קובץ בדיקה חדש — להוסיף ל-`scripts/regression-manifest.txt`.

הרצה: `npm run build`, ואז כל אחת מהבדיקות, ואז את כל ה-manifest: `node scripts/run-regression.js`. **הכול חייב להיות ירוק**, כולל בדיקות השער והמספר המשותף. אם בדיקה שלא קשורה לשינוי נכשלת — בדוק אם היא נכשלת גם בלי השינוי שלך (`git stash`) ודווח, אל "תתקן" אותה.

## עבודה עם git

- בעץ העבודה יש קבצים שהשתנו שאינם שלך: `CLAUDE.md`, `META_API_SETUP.md`, `PROJECT_HANDOFF.md`, `package.json`, `scripts/regression-manifest.txt`, `scripts/lib/*`, `scripts/measure-peak-3campaigns.js`, `docs/*` ועוד. **אל תכלול אותם בקומיט**, חוץ מהשורות שאתה עצמך מוסיף ל-`regression-manifest.txt` (אם נדרש — הוסף רק את ההונק שלך; בלי `git add -i`/`-p` אינטראקטיבי: השתמש ב-`git apply --cached` על patch של השורות שלך בלבד, ובדוק עם `git diff --cached` לפני קומיט).
- `owner-public/connect-meta.html` ו-`docs/embedded-signup-first-live-test-2026-10-13.md` שייכים למשימה הזו — כן לכלול.
- קומיט אחד או שניים עם הודעה באנגלית שמסבירה את ה"למה". **לא push, לא deploy** — בעל המערכת מאשר ומבצע.

## בסיום — דווח

1. רשימת קבצים ששונו, ואישור מפורש שאף קובץ מרשימת ה"אסור לגעת" לא שונה (`git diff --stat` של הקומיט).
2. מה קבעת לגבי `platform_type` ו-register כפול, עם קישורים לתיעוד.
3. פלט סיכום של `node scripts/run-regression.js`.
4. כל מקום שבו הקוד סתר את המסמך או שנאלצת להחליט בעצמך.
