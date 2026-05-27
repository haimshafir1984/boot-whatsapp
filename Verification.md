# Google OAuth Verification - מה עושים כשמגיע מייל מ-Google

הבקשה כבר נשלחה ל-Google ונמצאת בבדיקה.

אם YouTube הסיר את סרטון ההדגמה, צריך לשלוח לצוות הבדיקה קישור חדש לסרטון דרך Google Drive.

## לפני שעונים למייל

1. העלה את קובץ הסרטון ל-Google Drive.
2. לחץ קליק ימני על הקובץ.
3. בחר `Share` / `שיתוף`.
4. תחת `General access` בחר:

```text
Anyone with the link
```

5. ודא שההרשאה היא:

```text
Viewer
```

6. העתק את הקישור.
7. פתח חלון גלישה בסתר.
8. הדבק את הקישור ובדוק שהסרטון נפתח בלי התחברות לחשבון Google.

## איפה לחפש את המייל

חפש ב-Gmail גם בתיקיות:

- Inbox
- Spam
- Promotions
- Updates
- All Mail

אפשר לחפש לפי:

```text
OAuth
```

או:

```text
Trust and Safety
```

או:

```text
Google API
```

## נוסח תשובה למייל

להשיב ישירות למייל שמגיע מצוות Google Trust and Safety:

```text
Hello Google Trust and Safety team,

The demo video originally submitted as a YouTube link was automatically removed by YouTube after submission. Please use the updated Google Drive demo video link below instead:

[PASTE GOOGLE DRIVE LINK HERE]

The Google Drive link is shared with anyone who has the link as Viewer. The video demonstrates the full OAuth flow and Google Contacts usage: connecting Google Contacts, approving the requested contacts scope, receiving a WhatsApp campaign trigger, asking for the sender's preferred name, and creating/updating that sender in the connected Google Contacts account.

Thank you.
```

להחליף את:

```text
[PASTE GOOGLE DRIVE LINK HERE]
```

בקישור האמיתי של הסרטון ב-Google Drive.

## אם לא מגיע מייל

אם לא מגיע מייל תוך 3-5 ימים:

1. להיכנס ל-Google Cloud Console.
2. לבחור את הפרויקט `boot-whatsapp`.
3. להיכנס ל-`Google Auth Platform`.
4. להיכנס ל-`Verification Center`.
5. לבדוק אם הופיע כפתור כמו:
   - `Provide additional information`
   - `Update submission`
   - `Edit submission`
   - `Resubmit`

אם מופיע אחד מהכפתורים האלו, לפתוח אותו ולהחליף את קישור ה-YouTube בקישור Google Drive.

אם עדיין אין כפתור ואין מייל, להמתין עוד כמה ימים או לפנות לתמיכה של Google Cloud.
