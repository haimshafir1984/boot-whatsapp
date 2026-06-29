# סיכום עבודה - כרטיס איש קשר וזרימת קמפיין

תאריך: 25.6.2026

## רקע

במהלך בדיקות של קמפיינים רגילים וקמפייני Twilio התגלו כמה בעיות סביב שליחת כרטיס איש קשר, סדר ההודעות, והמתנה לתשובת משתמש.

הבעיות המרכזיות שהופיעו:

- בקמפיין רגיל, משפט הסיום (`replyText`) נשלח לפני כרטיס איש הקשר גם כשהכרטיס הוגדר להישלח בתחילת הזרימה.
- הודעת ההקדמה החדשה לפני כרטיס איש קשר לא תמיד הופיעה במקום הנכון.
- בקמפיינים רגילים ה-vCard לא נשלח ככרטיס איש קשר אמיתי, אלא כקובץ/טקסט שלא תמיד נראה טוב ב-WhatsApp.
- בשלב 3, הודעה רגילה המשיכה מיד לשלב הבא ולא איפשרה להמתין לתשובת משתמש.
- התצוגה המקדימה וה-dry-run לא תמיד שיקפו את סדר השליחה האמיתי.

## תיקונים שבוצעו

### 1. שדה הודעה לפני כרטיס איש קשר

נוסף בבונה הקמפיין, באזור שמירת איש קשר:

- שדה חדש: `הודעה לפני שליחת איש קשר`
- נשמר כ-`contactCardIntroText`
- אם השדה ריק, לא נשלחת הודעת הקדמה.
- אם הוא מלא, הוא נשלח ממש לפני כרטיס איש הקשר.

קבצים עיקריים:

- `public/index.html`
- `src/storage.ts`
- `src/adminServer.ts`
- `src/messageFlow.ts`
- `src/conversationState.ts`

### 2. תיקון סדר הודעות סביב כרטיס איש קשר

הוגדר כלל חדש:

אם `sendContactCard = true` וגם `contactCardPlacement = before_questions`, אז:

1. לא שולחים את `replyText` לפני הכרטיס.
2. אם יש `contactCardIntroText`, שולחים אותו.
3. שולחים את כרטיס איש הקשר.
4. ממשיכים להודעות המשך / שאלות / שלבים נוספים.

כך נמנע המצב שבו משפט סיום כמו:

`שמרתי אותך. כדי ליהנות מהסטטוסים שלי...`

מופיע לפני כרטיס איש הקשר.

### 3. שלב חדש שממתין לתשובת משתמש

נוסף סוג שלב חדש:

`wait_reply`

ב-UI הוא מופיע כ:

`הודעה שממתינה לתשובה`

ההתנהגות:

- המערכת שולחת את ההודעה.
- נפתח pending state מסוג `wait-reply`.
- כל תשובת טקסט מהמשתמש סוגרת את ה-pending.
- רק לאחר מכן המערכת ממשיכה לשלב הבא.

זה מתאים לזרימות כמו:

1. שליחת כרטיס איש קשר
2. `האם שמרת?`
3. המשתמש עונה `שמרתי`
4. שליחת הודעת המשך

קבצים עיקריים:

- `public/index.html`
- `src/storage.ts`
- `src/adminServer.ts`
- `src/conversationState.ts`
- `src/index.ts`
- `src/messageFlow.ts`

### 4. תיקון vCard ב-Twilio

במסלול Twilio נשאר שימוש בקובץ vCard ציבורי, כי זה עובד טוב עם `MediaUrl`.

בוצעו שיפורים:

- שם קובץ vCard ייחודי במקום `contact-card.vcf` קבוע.
- מספר טלפון מנורמל לפורמט בינלאומי, לדוגמה `0504213243` -> `+972504213243`.
- נוספו שדות vCard תקניים יותר כמו `N` בנוסף ל-`FN`.
- `twilio-media` מחזיר `text/vcard; charset=utf-8` לקבצי `.vcf`.

### 5. תיקון vCard בפרויקטים רגילים

בפרויקטים רגילים הבעיה הייתה ששליחת `.vcf` כקובץ לא תמיד נראתה כמו כרטיס איש קשר תקין ב-WhatsApp.

נוסף ממשק חדש:

`sendContactCard(to, vcard, displayName)`

מימושים:

- `WebJsProvider`: שולח את תוכן ה-vCard כטקסט עם `parseVCards: true`, כדי ש-whatsapp-web.js יהפוך אותו לכרטיס איש קשר native.
- `BaileysProvider`: שולח contact payload עם `contacts.displayName` ו-`vcard`.
- אם אין תמיכה ב-`sendContactCard`, המערכת נופלת חזרה לשליחת קובץ vCard כמו קודם.

קבצים עיקריים:

- `src/types/whatsapp.ts`
- `src/providers/WebJsProvider.ts`
- `src/providers/BaileysProvider.ts`
- `src/whatsapp.ts`
- `src/messageFlow.ts`

### 6. התאמת preview ו-dry-run

ה-preview בבונה הקמפיין וה-dry-run עודכנו כדי לשקף את אותה זרימה כמו runtime.

תיקונים:

- אם כרטיס איש קשר נשלח לפני שאלות, `replyText` לא מוצג לפניו.
- `contactCardIntroText` מוצג לפני כרטיס איש הקשר.
- dry-run מציג את הסדר הנכון כדי לא להטעות בזמן בדיקה.

קבצים:

- `public/index.html`
- `src/adminServer.ts`

## קומיטים חשובים

### `60eb060 Improve campaign contact card flow`

כלל:

- שדה הודעה לפני כרטיס איש קשר.
- שלב `wait_reply`.
- תיקון ראשוני של סדר שליחת כרטיס.
- שיפור vCard בסיסי.

### `08182cd Fix regular contact card campaign flow`

כלל:

- תיקון vCard בפרויקטים רגילים באמצעות שליחה native.
- תיקון סדר הודעות preview/dry-run/runtime.
- הפרדה בין מסלול Twilio לבין מסלולים רגילים.
- בדיקות עומק על מסלולי native/fallback/pending.

## בדיקות שבוצעו

### Build

- `npm run build` עבר.

### בדיקת HTML

בוצעה קומפילציה לסקריפט הפנימי של `public/index.html` באמצעות `vm.Script`.

תוצאה:

- `inline scripts compile: 1`

### סימולציות runtime

בוצעו סימולציות בקוד הבנוי (`dist`):

1. קמפיין רגיל עם `sendContactCard` native:
   - נשלחו `text + contact`.
   - משפט הסיום לא נשלח לפני הכרטיס.
   - ה-vCard הכיל `+972...`.

2. מסלול fallback / Twilio-style:
   - נשלחו `text + file`.
   - קובץ vCard תקין.
   - משפט הסיום לא נשלח לפני הכרטיס.

3. שלב `wait_reply`:
   - אחרי שליחת ההודעה נפתח pending state.
   - אחרי תשובת משתמש ה-pending נסגר.
   - ההודעה הבאה נשלחה רק לאחר התשובה.

## לקוחות שנבדקו במהלך העבודה

- `https://client-account-abe6dcf5.flowsbiz.com/client/`
- `https://client-1-50c21291.flowsbiz.com/client/`
- `https://client-test-2a7fee14.flowsbiz.com/client/`

בשלב מסוים התברר שחלק מהלקוחות לא קיבלו את השינויים כי הקוד היה מקומי ולא נדחף ל-`master`. לאחר מכן בוצעו commit ו-push.

## הערות יציבות מתוך המסמכים

המסמכים שנבדקו:

- `docs/system-improvement-master-plan.md`
- `docs/system-update-2026-06-14.md`
- `docs/stability-memory-review.md`

נקודות רלוונטיות:

- בעבר היו נפילות ופערים סביב שלבי המתנה, במיוחד לפני שאלת שם.
- חשוב לא להשאיר pending states פתוחים בלי סגירה.
- חשוב לעטוף timers ב-try/catch כדי למנוע unhandled rejection.
- לא מומלץ לבצע deploy באמצע קמפיין פעיל אם רוב המשתמשים עדיין בתהליך.
- כדאי לבדוק קמפיין מקצה לקצה לפני פרסום.

בתיקונים הנוכחיים נבדקו במיוחד:

- פתיחה וסגירה של pending state.
- מסלול timeout לא מפיל תהליך.
- fallback בשליחת כרטיס איש קשר.
- התאמה בין preview, dry-run ו-runtime.

## מה צריך לעשות אחרי פתיחת שיחה חדשה

1. לבצע redeploy ללקוחות הרלוונטיים אחרי commit `08182cd`.
2. לבדוק בלקוח `client-test-2a7fee14` שה-dry-run כבר לא מציג את משפט הסיום לפני כרטיס איש הקשר.
3. לבצע בדיקת קמפיין אמיתי במספר בדיקה:
   - שליחת טריגר.
   - הודעה מקדימה.
   - שאלת שם.
   - תשובת שם.
   - הודעה לפני כרטיס איש קשר.
   - כרטיס איש קשר native בפרויקט רגיל.
   - אם יש שלב `wait_reply`, לוודא שהוא מחכה לתשובה.
4. לאשר ש-Twilio עדיין שולח vCard כקובץ תקין.

## מצב git בסיום

השינויים הרלוונטיים נדחפו ל-`master`.

קבצים לא קשורים נשארו dirty/untracked ולא נכללו בקומיטים.
## Update - 2026-06-26

The contact-card flow step is now part of the normal Twilio decision flow.

Important runtime details:

- `contact_card` sends the intro text and then the configured contact card.
- The next step waits `max(BOT_REPLY_DELAY_MS, 4000)` milliseconds before sending.
- The delay was reduced from 7 seconds to 4 seconds to keep the flow faster while still reducing the chance that WhatsApp displays the next text before the vCard media.
- If the contact-card step fails and has `nextStepId`, the flow waits 60 seconds and continues to the next step.
- Existing campaigns are not rewritten. Campaigns that already contain `contact_card` continue using their saved flow structure.

## Update - 2026-06-29 - Step 3 Flow Timeline

The Twilio campaign builder now treats contact-card sending and media/file sending as regular Flow blocks inside Step 3.

Main behavior:

- A contact-card block can appear anywhere in the Step 3 Flow Timeline.
- A media/file block can appear anywhere in the Step 3 Flow Timeline.
- A wait-for-reply block can still be used after a contact card, for flows like: send contact card -> ask "did you save it?" -> continue.
- If a block does not choose a specific next step, the saved flow resolves it to the next block in timeline order.
- If there is no next block, the conversation ends normally or continues to the configured completion behavior.

UI structure:

- Step 3 is now focused only on building the live conversation flow.
- Step 4 now holds completion and fallback settings: completion message, completion files/links, no-answer timeout, and human handoff.

Compatibility note:

- This changes the builder UI and saved flow defaults for newly edited/saved campaigns.
- Existing deployed clients are not affected until redeployed.
- Existing campaigns should continue to load because the old decisionFlow shape is still used; the UI change only reorganizes how the user edits it.

