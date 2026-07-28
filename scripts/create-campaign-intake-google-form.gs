/**
 * Creates a Google Form for FlowsBiz campaign intake.
 *
 * How to use:
 * 1. Go to https://script.google.com/
 * 2. Create a new Apps Script project.
 * 3. Paste this file into Code.gs.
 * 4. Run createCampaignIntakeForm().
 * 5. Authorize the script.
 * 6. Copy the printed form edit URL / public URL from the execution logs.
 */

function createCampaignIntakeForm() {
  const form = FormApp.create('FlowsBiz - טופס איסוף פרטי קמפיין WhatsApp');
  form.setDescription(
    [
      'הטופס מיועד לאיסוף כל פרטי הקמפיין לפני ייבוא למערכת FlowsBiz.',
      'הקמפיין לא יופעל אוטומטית. לאחר מילוי הטופס, הבעלים ייבא את הנתונים למערכת, יבדוק, ישמור וייצור לינק ידנית.',
      'אם שדה לא רלוונטי לקמפיין שלך, אפשר להשאיר אותו ריק.',
    ].join('\n')
  );
  form.setCollectEmail(true);
  form.setAllowResponseEdits(true);
  form.setConfirmationMessage('תודה, פרטי הקמפיין התקבלו. נבדוק אותם לפני יצירת הקמפיין בפועל.');

  addSection(form, '1. פרטי לקוח וקמפיין');
  addText(form, 'שם הלקוח / העסק', true);
  addText(form, 'שם איש קשר', true);
  addText(form, 'טלפון איש קשר', true);
  addText(form, 'אימייל איש קשר', false);
  addText(form, 'שם הקמפיין', true);
  addParagraph(form, 'מטרת הקמפיין בקצרה', false);
  addChoice(form, 'סוג קמפיין עיקרי', ['קמפיין רגיל', 'קמפיין שיתוף / תחרות הפניות', 'סקר / ניקוד', 'קמפיין עם קובץ או לינק בסוף', 'אחר'], false);

  addSection(form, '2. פתיחת הקמפיין ולינק WhatsApp');
  addParagraph(form, 'משפט הטריגר שהמשתמש ישלח ב-WhatsApp', true);
  addParagraph(form, 'הודעת פתיחה אחרי הטריגר', false);
  addChoice(form, 'האם הקמפיין מוגבל בזמן?', ['לא', 'כן'], false);
  addText(form, 'תאריך ושעת התחלה רצויים', false);
  addText(form, 'תאריך ושעת סיום רצויים', false);
  addParagraph(form, 'הערות לגבי פרסום הסטטוס / מקור התנועה', false);

  addSection(form, '3. שמירת המשתמש כאיש קשר');
  addChoice(form, 'האם לשאול את המשתמש באיזה שם לשמור אותו?', ['כן', 'לא'], true);
  addParagraph(form, 'נוסח שאלת שם', false);
  addText(form, 'כמה דקות להמתין לתשובה לשם?', false);
  addParagraph(form, 'הודעה מקדימה לפני שאלת שם, למשל "שמרת אותי?"', false);
  addChoice(form, 'אם אין תשובה להודעה המקדימה, האם להמשיך אוטומטית?', ['כן', 'לא'], false);
  addText(form, 'כמה דקות לחכות בהודעה המקדימה?', false);
  addText(form, 'סיומת לשם איש הקשר, אם צריך', false);

  addSection(form, '4. שליחת איש קשר / vCard למשתמש');
  addChoice(form, 'האם לשלוח למשתמש כרטיס איש קשר לשמירה?', ['כן', 'לא'], false);
  addChoice(form, 'מתי לשלוח את כרטיס איש הקשר?', ['לפני השאלות', 'בסיום הקמפיין'], false);
  addParagraph(form, 'הודעה לפני שליחת כרטיס איש קשר', false);
  addText(form, 'שם בכרטיס איש הקשר', false);
  addText(form, 'טלפון בכרטיס איש הקשר', false);
  addText(form, 'אימייל בכרטיס איש הקשר', false);
  addText(form, 'ארגון / עסק בכרטיס איש הקשר', false);
  addChoice(form, 'האם להמתין לאישור אחרי שליחת כרטיס איש קשר?', ['כן', 'לא'], false);
  addText(form, 'כמה דקות לחכות לאישור כרטיס איש קשר?', false);

  addSection(form, '5. Flow הקמפיין');
  addParagraph(
    form,
    'הסבר כללי על מבנה השיחה',
    false
  ).setHelpText('אפשר למלא עד 12 שלבים. בכל שלב בחרו סוג שלב ומלאו רק את השדות הרלוונטיים.');

  for (let i = 1; i <= 12; i += 1) {
    addFlowStep(form, i);
  }

  addSection(form, '6. הגדרות אין תשובה ומענה אנושי');
  addText(form, 'כמה דקות לחכות לתשובה בשאלות?', false);
  addParagraph(form, 'הודעה אם המשתמש לא ענה לשאלה בזמן', false);
  addChoice(form, 'האם לאפשר מעבר למענה אנושי?', ['כן', 'לא'], false);
  addParagraph(form, 'נוסח הודעת מעבר למענה אנושי', false);
  addText(form, 'מספר WhatsApp למענה אנושי', false);

  addSection(form, '7. סיום הקמפיין');
  addParagraph(form, 'הודעת סיום / הודעה אחרי שמירה', false);
  for (let i = 1; i <= 5; i += 1) {
    addText(form, `לינק סיום ${i} - כותרת`, false);
    addText(form, `לינק סיום ${i} - URL`, false);
  }
  addParagraph(form, 'קבצים שרוצים לשלוח בסיום', false).setHelpText('נא לצרף לינקים לקבצים בדרייב או להסביר אילו קבצים יש לשלוח. ההעלאה למערכת תתבצע ידנית.');
  addParagraph(form, 'הודעות המשך נוספות אחרי הודעת הסיום', false);

  addSection(form, '8. תחרות שיתופים / Referral');
  addChoice(form, 'האם להוסיף שלב לינק אישי לתחרות שיתופים?', ['כן', 'לא'], false);
  addParagraph(form, 'נוסח ההודעה שתשלח למשתמש עם הלינק האישי', false)
    .setHelpText('אפשר להשתמש במשתנה {referral_link}. אם לא יופיע, המערכת תוסיף את הלינק בסוף.');
  addParagraph(form, 'הסבר ללקוח על חוקי התחרות', false);

  addSection(form, '9. הערות ואישורים');
  addParagraph(form, 'הערות נוספות לקמפיין', false);
  addChoice(form, 'האם יש אישור לשליחת הודעות למשתתפים?', ['כן', 'לא', 'לא בטוח'], false);
  addParagraph(form, 'מקור רשימת המשתתפים / האופט-אין', false);

  const sheet = SpreadsheetApp.create('FlowsBiz - תשובות טופס קמפיין');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  Logger.log('Edit URL: ' + form.getEditUrl());
  Logger.log('Public URL: ' + form.getPublishedUrl());
  Logger.log('Responses spreadsheet: ' + sheet.getUrl());
}

function addSection(form, title) {
  form.addPageBreakItem().setTitle(title);
}

function addText(form, title, required) {
  return form.addTextItem().setTitle(title).setRequired(Boolean(required));
}

function addParagraph(form, title, required) {
  return form.addParagraphTextItem().setTitle(title).setRequired(Boolean(required));
}

function addChoice(form, title, choices, required) {
  return form
    .addMultipleChoiceItem()
    .setTitle(title)
    .setChoiceValues(choices)
    .setRequired(Boolean(required));
}

function addFlowStep(form, index) {
  addSection(form, `5.${index}. שלב Flow ${index}`);
  addChoice(form, `שלב ${index} - סוג`, [
    'לא בשימוש',
    'הודעת טקסט',
    'שאלת בחירה עם כפתורים',
    'רשימת בחירה',
    'סקר / ניקוד',
    'הודעה שממתינה לתשובה',
    'תמונה / סרטון / קובץ',
    'איש קשר לשמירה',
    'לינק אישי לתחרות שיתופים',
  ], false);
  addParagraph(form, `שלב ${index} - טקסט ההודעה / השאלה`, false);
  addText(form, `שלב ${index} - השהייה לפני שליחה בשניות`, false);
  addParagraph(form, `שלב ${index} - אפשרות 1`, false);
  addParagraph(form, `שלב ${index} - אפשרות 2`, false);
  addParagraph(form, `שלב ${index} - אפשרות 3`, false);
  addParagraph(form, `שלב ${index} - אפשרויות נוספות לרשימה`, false)
    .setHelpText('לרשימת בחירה בלבד. כתבו כל אפשרות בשורה נפרדת, עד 10 אפשרויות.');
  addParagraph(form, `שלב ${index} - מה קורה אחרי תשובה 1`, false);
  addParagraph(form, `שלב ${index} - מה קורה אחרי תשובה 2`, false);
  addParagraph(form, `שלב ${index} - מה קורה אחרי תשובה 3`, false);
  addParagraph(form, `שלב ${index} - קובץ / לינק לשליחה`, false);
  addChoice(form, `שלב ${index} - האם תמונה תישלח כמדבקה?`, ['לא', 'כן'], false);
  addText(form, `שלב ${index} - לאיזה שלב להמשיך אחרי זה?`, false)
    .setHelpText('אפשר להשאיר ריק כדי להמשיך לשלב הבא לפי הסדר.');
}
