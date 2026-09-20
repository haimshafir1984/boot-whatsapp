# שדרוג בטיחות, מהירות ועמידות — הוראות ביצוע ל־GPT-5.6

> **⚠️ מסמך זה פוצל ב-20.9.2026 ואינו מסמך הביצוע הפעיל.** הוא נשמר כמקור וכרקע.
>
> - **לביצוע עכשיו:** `docs/system-safety-speed-stage-abc-2026-09-20.md` — שלבים A–C (גיבוי, הוגנות Outbox, מניעת ערבוב מקומית). B ו-C נפרסים לייצור לפני ש-D נבנה.
> - **לתכנון:** `docs/system-safety-speed-stage-def-2026-09-20.md` — שלבים D–F. מתחיל בתכנון ובמכונת מצבים שהמשתמש מאשר, לפני שורת קוד.
>
> במקרה של סתירה, שני המסמכים המפוצלים גוברים על זה. השינויים שבוצעו בפיצול: (1) הפרדת A–C מ-D–F; (2) checkpoint מחייב לפני D; (3) קביעה מפורשת ש-B ו-C נפרסים לפני D, עם עומס אחרי כל אחד; (4) יישור תנאי קבלה 2 לתנאי 4 — יעד יחסי מול baseline מדוד במקום סף 7 שניות מוחלט.

תאריך: 20.9.2026. בסיס הבדיקה: HEAD `0ea8d26`. מסמך ביצוע לכל שבעת תחומי השדרוג, לפי התיעדוף המעודכן לאחר הבדיקה המשותפת. לפני מימוש יש לבדוק מחדש HEAD, הוראות AGENTS.md ושינויים מקומיים; אין להניח שהקוד נשאר זהה.

## 1. המשימה והגבולות

לממש את השינויים, המיגרציות, כלי הבדיקה וכלי התפעול שבמסמך. להתקדם בכל שלבי הפיתוח לאחר מעבר הבדיקות, בלי לבקש אישור על בחירות מימוש שגרתיות. שלב שנכשל בבדיקות בטיחות אינו מאושר למעבר; לתקן אותו ולבדוק מחדש. אין לטעון שהמשימה הושלמה אם נותר רכיב חובה לא ממומש.

המסמך הנוכחי גובר במקרה של סתירה על `docs/central-routing-run-1-spec-2026-09-16.md`; המסמך הישן הוא חומר רקע, לא הוכחה למימוש. אין להסתפק בשם קומיט, בדיקה או feature קיים: יש לבדוק את ההתנהגות בפועל.

- הפיתוח והבדיקות נעשים מקומית/בסביבת בדיקה מבודדת. אין לשלוח הודעות WhatsApp או מיילים אמיתיים, לשנות קמפיינים בייצור, לפרוס, להפעיל Autodeploy או לשחזר על ייצור במסגרת המימוש.
- מסמך זה אינו אישור חדש ל־commit/push. בסיום להכין שינוי בדוק ודוח; לבצע commit/push רק אם הוראת ההרצה של המשתמש מאשרת זאת. push עלול להפעיל פריסה אוטומטית ולכן יש לבדוק זאת לפניו.
- שינויים קיימים של המשתמש, לרבות package.json, מסמכים וסקריפטים לא מנוהלים, אינם למחיקה או להכללה אוטומטית בקומיט. אין לעשות reset/clean גורף.
- לא להחליף את מנוע הקמפיינים כולו, לא לאחד את נתוני הלקוחות למסד אחד, לא להעביר את כל שליחת Meta לשער, ולא לשנות תוכן/השהיות קמפיינים כדי לשפר מדדים.
- זהות לקוח, קמפיין וריצת משתתף הן זהויות נפרדות. כל לקוחות Meta על אותו מספר חולקים תחום ניתוב, אך לא בעלות על נתונים.
- אפס ערבוב משמעו אפס הפרה של שיוך מוכח. טקסט חופשי ללא ציטוט אינו מגלה לאיזו שיחה אדם התכוון. אין להבטיח exactly-once או ביטול הודעה שכבר התקבלה אצל Meta.

## 2. עובדות הבסיס ומפת הקוד

| תחום | נקודות כניסה שיש לקרוא | מה אומת בבדיקה |
|---|---|---|
| ניתוב | `src/adminServer.ts`: `routeMetaGatewayInbound`, `inspectMetaTriggerAvailability`; `src/metaCampaignRouting.ts`, `src/triggerDetector.ts` | בדיקת pending חיה לכל הלקוחות; חסימה עקב לקוח לא זמין; התנגשות זהה באותו לקוח אינה חסומה |
| הקשר תשובה | `src/types/whatsapp.ts`, `src/messageFlow.ts`, `src/providers/MetaCloudProvider.ts` | `context.id` אינו מועבר למנוע; כפתורים נשלחים עם option ID בלבד |
| עבודה ומעבר | `src/campaignWork.ts`, `src/conversationState.ts`, מסלולי בוט השירות | יש ביטול עבודה ו־ACK; חובה לשמר ולהרחיב אותם |
| Outbox | `src/outboxDispatcher.ts`, `src/storage.ts`, עזרי השליחה ב־messageFlow | סינון held אחרי LIMIT; המתנה לקבוצה שלמה; poll של 15 שניות; retry של 60 שניות |
| Inbox | `src/metaGatewayInbox.ts`, שני ה־drainers באדמין | שכתוב JSON סינכרוני; גיזום completed אינו מגביל הצטברות active |
| שמירה | `src/database.ts`, `src/storage.ts` | snapshot/delta עם תיקוני dirty state ו־append-only events; לא לבטל תיקונים אלה |
| תפעול | `src/dokployProvisioner.ts`, `src/systemAlerts.ts`, `src/ownerStorage.ts`, `owner-public/index.html` | עדכון קוד משתמש כעת ב־application.deploy; health לבדו אינו מוכיח גרסה |

בדוקפלוי נצפו: שער ופוקוס עם replica אחד, volumes נפרדים, בנייה על שרת ההרצה, שדות משאבים ריקים, ללא גיבוי Volume לשער וללא גיבוי PostgreSQL לפוקוס במסכים הייעודיים. PostgreSQL של פוקוס מוגדר `postgres:18` ואינו מפרסם פורט חיצוני במסך שנבדק. מתג Autodeploy של פוקוס דלוק אך אין בכך הוכחה שהטריגר לפריסה מחובר. הטענה שאין שום גיבוי מחוץ לדוקפלוי התקבלה מדוח קלוד ולא אומתה באופן עצמאי בבדיקה זו.

## 3. שלבים ושערי קבלה

| שלב | תכולה | שער לפני המשך |
|---|---|---|
| A | גיבויים, inventory ושחזור | גיבוי ושחזור מוצלחים בסביבה מבודדת; אפשר להמשיך פיתוח כשחסרים פרטי יעד ייצור, אך rollout חסום |
| B | הוגנות Outbox, timeout וסיווג תוצאה לא־ודאית | אין הרעבה, כפילות יזומה עקב timeout או פגיעה בסדר |
| C | טריגרים והקשר תשובה מקומי | בידוד בתוך לקוח ובין ריצות, שמירה אמינה ובדיקות שכפול |
| D | מרשם מרכזי, פרוטוקול ובעלות מתמשכת | אפס fan-out במסלול central; מעבר בטוח ותאימות מוכחת |
| E | Inbox במסד נתונים ומעבר מהקובץ | אין אובדן/כפילות בייבוא, crash/restart וניקוז |
| F | פריסה מבוקרת, ניטור ובדיקות קבלה כוללות | גרסה מאומתת, rollback מתועד, רגרסיה ועומס עוברים |

השלבים הם גבולות בדיקה וקומיטים אפשריים, לא הוראה לפרוס שש פעמים. אפשר לממש helpers משותפים מוקדם יותר; אסור להפעיל central לפני D+E ובדיקות המעבר. שינויים מקומיים של B+C חייבים להיות בטוחים גם במצב legacy.

## 4. כללי בטיחות שאסור להפר

1. HTTP success על קבלת הודעה רק לאחר שמירה מתמשכת שלה. אין ACK של הצלחת שמירה על שינוי בזיכרון בלבד.
2. משתמש אינו מקבל הודעה מלקוח/קמפיין/ריצה אחרים בגלל retry, restart, כפתור ישן, שינוי טריגר או איטיות.
3. כל הודעת המשך, timer ו־Outbox נושאים את זהות הריצה. מעבר לריצה חדשה מונע התחלת שליחות מהישנה אחרי אישור המעבר.
4. אין fallback ללקוח אחר על תקלה. hold/needs_review נשארים חסומים עד החלטת מנהל מאומתת.
5. Retry שומר אותו מזהה פעולה; אין יצירת ריצה, קמפיין, בעלות או הודעה לוגית חדשה בכל ניסיון.
6. כשל לאחר קבלת הודעה אצל הספק אינו נהפך לשליחה נוספת או להודעת fallback אוטומטית.
7. DB/Inbox פגומים אינם נטענים כריקים בהצלחה. אין silent skip של רשומות שלא ניתן לייבא.
8. מספר replicas נתמך בשלב זה: אחד לשער ואחד לכל לקוח. SQL claiming אינו הופך אוטומטית את שאר המערכת למבוזרת.

## 5. שלב A — גיבוי ושחזור

לבנות כלי תפעול עם `inventory`, `backup`, `verify`, `restore` ו־`dry-run`, או פקודות מקבילות ברורות. ברירת המחדל אינה משנה ייצור. להשתמש בכלים רשמיים מתאימים לגרסת PostgreSQL בפועל; לא להסתפק בהעתקת ספריית נתוני PostgreSQL חיה.

### תכולה וחוזה

- inventory של כל לקוח: מזהי שירות/מסד/volume, גרסת schema ויישום, סוג ספק; כולל האדמין והמאגר המרכזי החדש. לא להניח ש־DATABASE_URL של האדמין כבר מוגדר, ולא להשתמש במסד של לקוח עבור השער.
- PostgreSQL: dump עקבי ולוג יציאה; volumes: קבצי אדמין, קבצים שהועלו, Inbox הישן כל עוד קיים, מצב שיחות וסשני Baileys. אין להציג dump SQL כגיבוי מלא כאשר יש קבצים חיצוניים.
- לתעד איך משיגים נקודת שחזור עקבית בין DB לקבצים. לבדיקת שחזור מלאה להשתמש במחסום כתיבה מתואם; אין לקרוא לגיבוי רב־שירותי אטומי אם כל רכיב נלקח בזמן שונה.
- manifest ללא סודות: גרסאות, זמן התחלה/סיום, inventory, גדלים ו־checksums, סטטוס upload ו־verify. יעד מוצפן מחוץ לשרת ההרצה, הרשאות מצומצמות. credentials דרך secret/env ולא arguments הנרשמים בלוג.
- להפריד בין הצלחת יצירה מקומית, העברה ליעד ובדיקת שחזור. כשל באחד מהם מסומן בגלוי. אין למחוק גיבוי תקין אחרון עקב כשל חדש.
- מדיניות פתיחה configurable: DB כל שעה, קבצים יומית ולפני פריסה, שמירת יומיים שעתיים/14 יומיים/8 שבועיים. אלה ברירות מחדל מוצעות, לא התחייבות ל־RPO אחיד: RPO של קבצים שונה משל DB. להציג זאת במפורש.
- restore דורש יעד מפורש ומבודד ומסרב כברירת מחדל ליעד המקור. אין לחבר worker משוחזר ל־Meta/Baileys/Google/email אמיתיים בזמן בדיקה.
- התראות על כשל ועל איחור ביחס ללוח הזמנים, גם כאשר scheduler כלל לא רץ. בדיקת freshness צריכה לרוץ מחוץ לתהליך שמבצע את הגיבוי; מנטר עצמאי נחוץ לזיהוי נפילת כל השרת.

### בדיקות

dump→upload ליעד בדיקה→restore למסד חדש; השוואת ספירות, קשרים ודוגמאות campaign/result/context/held; checksum של קבצים; גיבוי חסר/פגום; יעד לא זמין; דיסק מלא; סיסמה שגויה; retention שאינו מוחק גיבוי אחרון. לתעד זמן שחזור בפועל. יעד ייצור וסודות חסרים הם דרישת תפעול פתוחה, לא סיבה לדלג על בדיקות מקומיות.

## 6. שלב B — Outbox הוגן וקריאות ספק מוגבלות

### 6.1 סינון לפני הגבלת האצווה

להחיל זכאות לפני LIMIT ב־`getPendingOutboxMessages`, באמצעות predicate/רשימת חסומים או repository מתאים, בלי ליצור תלות מעגלית בין Storage ל־conversationState. לשמר בחירת ראש התור לכל נמען; לא לדלג על הודעה קודמת שאינה due כדי לשלוח את הבאה לאותו נמען.

בדיקת hold נוספת סמוך ל־claim/שליחה כדי לכסות hold שהופעל לאחר הבחירה. ההודעה נשארת ממתינה ללא צריכת ניסיון כאשר נחסמה לפני שליחה. ביטול ריצה מטופל כ־cancelled, לא כתקלה זמנית שמפעילה אותה מחדש.

### 6.2 התקדמות עצמאית והפעלה מהירה

- להחליף מחסום Promise.all של אצווה במאגר עובדים מוגבל שמפנה slot עם סיום כל פעולה. ברירת מחדל 20 נמענים שונים; concurrency ניתן להגדרה. נמען אחד נשאר סדרתי גם מול מסלול השליחה הישירה.
- לשמר claim משותף לשליחה ישירה ול־dispatcher. אסור ששניהם יקבלו אותה הודעה או ישלחו שתי הודעות מקבילות לאותו נמען.
- להוסיף wake-up אחרי commit של enqueue חדש, עם polling גיבוי; אין להמתין 15 שניות למסירה רגילה רק כי ה־tick הסתיים. אין busy-loop כאשר כל הרשומות חסומות או ממתינות ל־nextAttemptAt.
- backoff רק לכשל שמותר לנסות מחדש; לכבד Retry-After כשהוא זמין. פרמטרים מתועדים עם bounds. shutdown מפסיק קבלת עבודה וממתין לעבודה קיימת במסגרת זמן מוגדרת.

### 6.3 timeout וסיווג כשל

לכל fetch ב־MetaCloudProvider, כולל media, messages וקריאת גוף התגובה: timeout מפורש. ברירות מחדל מוצעות: שליחה 15 שניות, העלאת מדיה 60 שניות; configurable ומאומתות. אין לטעון של־Node אין שום timeout פנימי; הבעיה היא היעדר תקציב מפורש הנשלט על ידי האפליקציה.

לממש סיווג אחיד, שנצרך גם ב־dispatcher וגם בעזרי messageFlow, contacts, templates, buttons/list, service bot ו־media fallback:

| תוצאה | פעולה |
|---|---|
| דחייה ודאית וקבועה לפני קבלה | failed והתראה לפי הסוג; בלי retry עיוור |
| דחייה ודאית וזמנית המתירה retry | backoff מוגבל; אותו מזהה לוגי |
| הצלחה עם providerMessageId | לשמור תוצאה והקשר; כשל שמירה/דיווח אינו מצדיק resend |
| timeout/ניתוק שבו הקבלה אינה ידועה | `uncertain` מתמשך או needs_review מתאים; לעצור המשכים תלויים ולמנוע resend/fallback אוטומטי |
| העלאת מדיה בלבד נכשלה | ניתן לנסות upload מחדש לפי מדיניות; אין להסיק מכך שמותר לחזור על שליחת הודעה לנמען |

אין לשחרר מעבר A→B כאילו שליחה ישנה הסתיימה בבטחה רק מפני שה־fetch נקטע. outcome לא־ודאי מחייב מדיניות בירור. רישום `processing` ישן אחרי crash אינו הוכחה שההודעה לא נשלחה: התאוששות דורשת אותו טיפול, ולא reclaim אוטומטי עיוור. ליצור intent מתמשך לפני פעולת הספק; להבחין בין מצב בטוח לחזרה למצב שאינו מוכרע. לא לטעון לאטומיות בין PostgreSQL ל־Meta.

### 6.4 בדיקות חובה

0/1/20/100 נמענים חסומים לפני נמענים תקינים; התקינים נשלחים באותו מחזור והחסומים נשארים ללא שינוי attempts. הודעה ראשונה ב־retry אינה נעקפת. worker תקוע אחד אינו חוסם נמענים אחרים. direct-send מול dispatcher במקביל. hold בזמן claim. timeout לפני/אחרי קבלה מדומה; הצלחה ואז כשל flush; crash בין שליחה לשמירת ID; media cache error שאינו מאפשר resend עמום; הודעה אינטראקטיבית עמומה אינה גורמת ל־text fallback. אין יותר משליחה מתקבלת אחת בתרחישי retry שניתנים להכרעה; תרחישים עמומים נעצרים ומדווחים.

## 7. שלב C — טריגרים וקישור תשובות

### 7.1 טריגרים

- להשתמש באותו normalizer בשמירה ובניתוב: trim, רצפי רווחים, case לטיני וסימני כיווניות/zero-width. אין להסיר שמות מפרסמים או מילים.
- טריגר מלא זהה אסור בין מסלולים פעילים/מתוזמנים שטרם הסתיימו באותו מספר Meta, כולל באותו לקוח. טיוטה כבויה אינה שומרת טריגר. ב־Baileys תחום הבדיקה הוא החשבון המקומי.
- ליצור/לערוך/להפעיל/toggle/לשכפל/להפעיל לפי לו״ז ונתיבי owner כפופים לאותו כלל. החרגה לעריכה עצמית לפי זהות מסלול מלאה. תיאום בו־זמני מקומי כבר בשלב C; ייחודיות בין לקוחות מובטחת אטומית בשלב D.
- לבחור התאמה מלאה לפני partial היסטורי. לשמר referral/codes לפי fixtures קיימים. אין לבצע מעבר גורף ל־exact-only ששובר קישורים קיימים.
- שוויון בין שני מסלולים נפרדים הוא עמימות גם אם clientId זהה. זהות מסלול כוללת clientId+routeKind+routeId; לא לספור הופעה כפולה של אותו מסלול כקמפיין נוסף.
- הדס/נטע/משה באותו משפט בסיסי מותרים; הדס כהן או שם לא מוכר לא יופעלו כהדס רק משום שהטקסט מכיל את המשפט הקצר. תבנית referral תפורש במפורש; אין fallback משפחתי אוטומטי.
- דוח כפילויות קיים: לא למחוק/לכבות קמפיינים בשקט. התנגשות מסומנת והפעלה/ניתוב עמומים נעצרים. UI ללקוח לא חושף שמות/נתוני לקוחות אחרים.

### 7.2 שכפול

שכפול יוצר טיוטה כבויה, campaign ID חדש, ומפה old→new לכל מזהי השלבים והאפשרויות. לעדכן באמצעות המפה את כל הקישורים הפנימיים: nextStep, timeout, branches, start, editor graph וכל הפניה נוספת שמתגלית בטיפוסים. אין להחליף UUIDs ב־JSON באמצעות regex. אין להעתיק ריצות, תוצאות או context. לא לשנות IDs בקמפיינים קיימים כחלק מהמיגרציה. רענון IDs הוא הגנה נוספת בלבד.

### 7.3 הקשר תשובה

- להוסיף `replyToProviderMessageId` מ־Meta `message.context.id`, ולשמור זהות מאומתת של ריצה/שלב. לשמר את ההקשר דרך split webhook, Inbox, forwarding ו־handleMessage.
- לשמור mapping מתמשך: phoneNumberId+providerMessageId → client/route/run/generation/step/recipient. לרשום לכל מסלולי השליחה הרלוונטיים, כולל Outbox retry, timers ובוט שירות.
- מיפוי של נמען אחר, קמפיין אחר, ריצה ישנה או שלב שאינו ממתין: אינו מקדם דבר. לא להתבסס על result האחרון ועל קיום option ID בלבד.
- כפתור בלי context: לקבל רק אם יש מזהה אינטראקציה ייחודי/חתום שמוכיח run+step+recipient ומתאים להודעה שנשלחה; option ID ישן לבדו אינו הוכחה. אחרת stale/held, בלי ניחוש.
- טקסט חופשי ללא context: שייך לריצה הפעילה היחידה אם היא מצפה לטקסט. לתעד מגבלת כוונת המשתמש; טקסט מצוטט נבדק לפי מקורו לפני ניסיון לפרשו כטריגר חדש.
- context שעדיין לא הגיע: retry מוגבל, ברירת מחדל 30 שניות, ואז בדיקה ידנית. אין לזרוק הודעה או לנתב לטלפון בלבד. אם לא ניתן לשחזר היסטוריה קיימת, לחצן היסטורי אינו הופך לתשובה מאומתת.
- בשלב legacy המידע המקומי מונע התקדמות שגויה גם אם השער העביר ללקוח הלא נכון; אין לטעון ששוחזר הניתוב הנכון עד שלב D. לא לשלוח הודעת שגיאה מתוך קמפיין אחר כדי להסביר את החסימה.

בדיקות: שכפול עם branching וכל ההפניות תקינות; קיימים A/B עם IDs זהים; A→B ולחיצה על A; A→A בריצה חדשה; ציטוט לנמען אחר; כפתור חסר context; תשובה לפני רישום mapping; restart; שלושה מפרסמים; טריגרים זהים בו־זמנית; פעולה דרך כל API ולא רק UI.

## 8. שלב D — שער כמקור סמכות מתמשך

### 8.1 מאגר ומודל

להוסיף `META_ROUTING_DATABASE_URL` ייעודי. לא לשנות את backend של האדמין ולא להשתמש ב־DATABASE_URL של לקוח. להשתמש ב־pg הקיים ובמיגרציות versioned; מאגר שונה מה־snapshot הכללי, בלי ששני מנגנונים ידרסו אותה טבלה.

טבלאות נדרשות, בשמות לפי המימוש:

- routes + reservations: phoneNumberId, clientId, routeKind/routeId, normalizedTrigger, revision, תזמון, publication status, operationId. unique reservation לפי מספר+משפט, כולל בקשות מקבילות.
- conversation_owners: מפתח מספר עסקי+משתתף, client/route/run/generation ומצב active/switching/held/completed.
- handovers: פעולה מתמשכת, בעלים קודם/חדש, inbound ID, expected generation ושלבים/ACK.
- outbound_context: מזהה הספק וההקשר; unique; אין דריסת בעלות של מיפוי קיים.
- routing_decisions: inbound ID ייחודי והיעד/run/revision שנבחרו. retry ממשיך אותה החלטה בכפוף לביטול מפורש, ולא בוחר מחדש לפי טריגר שהשתנה.
- משימות דיווח מתמשכות אצל הלקוח לפרסום route/context/hold/completion. commit מקומי כולל את המשימה. restart אינו מאבד דיווח.

cache מותר רק אחרי commit ועם invalidation/version מתאים. בעת startup לטעון readiness לכל מספר. central ללא מאגר תקין נעצר בגלוי; לא נופל אוטומטית ל־legacy/JSON ריק.

### 8.2 פרוטוקול ואימות

capability מפורש לגרסת הפרוטוקול. מעטפת מהשער מכילה inbound ID, phoneNumberId, participant, client/route/run/generation/routeRevision וסיבת בחירה. token מאומת מזהה את הלקוח; אין לסמוך על clientId בגוף. לאמת שהמספר העסקי והנמען במעטפת תואמים ל־payload ולרישום המורשה. לבצע בדיקה חוזרת לפני עיבוד Inbox ולפני עבודה מושהית.

הלקוח מכבד את הקמפיין שנבחר; לא מריץ זיהוי טריגר חדש שבוחר מסלול אחר. API לדיווח מלקוח לא מאפשר לו לפרסם route/context עבור לקוח או מספר שלא הוקצו לו. endpoints נכשלים סגור כאשר חסרה תצורת אימות.

### 8.3 מסלול מהיר ומעבר

נעילה סדרתית לפי מספר+משתתף; חיפוש context/בעלות/טריגר במאגר; שמירת החלטה; העברה רק ליעד. אין pending/routes fan-out בשגרה ב־central. לקוח לא קשור offline אינו מוסיף בקשה/timeout למסלול של לקוח תקין.

מעבר A→B: persist switching → ביטול לבעלים A בלבד עם operationId ו־expected generation → A מונע כניסת עבודה ישנה, מבטל timers/outbox/המשכים ובוט שירות וממתין לשליחות בתנועה → persist ACK → commit generation חדש → העברה ל־B. אין להחזיק טרנזקציית DB פתוחה בזמן HTTP.

לשמר מחסום מקומי גם על התחלת Outbox חדשה במהלך cleanup; AbortController בזיכרון בלבד אינו מספיק אחרי restart. לשמור revoked generation/מצב ביטול לפני ACK. רק לאחר סגירת המחסום מותר לשער להעניק דור חדש. בדיקת generation חד־פעמית לפני HTTP אינה תחליף לתיאום הזה, כי יש מרוץ בין הבדיקה לשליחה.

אם A אינו זמין או נותרה שליחה לא־ודאית, המעבר של אותו משתתף נעצר; משתתפים אחרים ממשיכים. lease expiry לבדו אינו הוכחה שמותר ל־B לשלוח. ACK ישן אינו מבטל בעלות חדשה. A→B→C, מעבר בתוך לקוח, כיבוי/סיום/מחיקה ו־hold דורשים state machine מתמשך ואידמפוטנטי.

### 8.4 שמירת קמפיין ופרסום

אין טרנזקציה מבוזרת בין מסדי הלקוח והשער. להשתמש בתהליך: operation מקומי → reservation מרכזי → commit הגדרה ומשימת פרסום → הפעלת revision בשער לאחר אימות השמירה. retry של אותה פעולה אינו יוצר כפילות. reconciliation משלים תהליכים קטועים; אינו משחרר reservation רק בשל timeout כשאולי הקמפיין הופעל.

UI מציג `נשמר, ממתין להפעלה` כל עוד הפרסום לא אושר, ושגיאה אמיתית בכשל שמירה. לשמר revision קודם לעריכה פעילה עד מעבר מוסכם; מעטפת revision ישן אינה רצה על תוכן חדש שרירותי. להתאים גם APIs של owner, תזמון ובוטי שירות. ב־Baileys לדרוש flush לפני הצלחה ולמנוע מצב פעיל בזיכרון בלבד.

### 8.5 מעבר ותאימות

מצבים `legacy`, `shadow`, `central` לפי מספר עסקי. default legacy. shadow משווה בלבד, אינו שולח/מבטל/מקצה בעלות ייצור. גם endpoint ישן לא יכול לעקוף סמכות central לאחר cutover.

לפני הפעלה: גיבוי מאומת → מסד ייעודי → לקוחות תומכי פרוטוקול → שער legacy/shadow → bootstrap הכולל routes, pending, held, timers, active work ו־Outbox → מחסום dispatch תוך המשך קבלה מתמשכת → סיום פעולות בתנועה ו־snapshot סופי → אימות שלמות → central לכל המספר יחד → חידוש.

אי אפשר להפעיל לקוח אחד ב־central ואחר ב־legacy על אותו מספר עם בעלות עצמאית. bootstrap חסר, כפילויות או גרסה לא נתמכת חוסמים cutover. אין להוסיף בעלויות משוערות מתוך מספרי טלפון בלבד. rollback אחרי central דורש pause ופיוס state; אין חזרה אוטומטית לבינארי ישן שאינו מבין generations.

בדיקות חובה: crash לפני/אחרי כל commit ו־ACK, ack אבוד/כפול/ישן, DB outage, כשל לקוח לא קשור ובעלים קודם, replay מעטפת, spoofed client/phone/context, עריכת route בזמן retry, שחזור מצב מעבר אחרי restart, בוט שירות ו־Baileys שאינם נפגעים.

## 9. שלב E — Inbox הדרגתי במסד

- ליצור repository async ברור לשני ה־Inboxes: enqueue, claim, complete/retry/held/failed, replay מפורש ו־metrics. gateway משתמש במאגר הייעודי; לקוח PostgreSQL משתמש במסד שלו ובטבלאות נפרדות מה־snapshot. אין לתת ל־writeSnapshotDelta למחוק אותן.
- לסביבת legacy JSON לשמר backend קיים ותאימות בלי להציגו כבעל ביצועי SQL. readiness של cutover דורש backend הייצור הנתמך; אין מעבר שקט מ־SQL ל־JSON בכשל.
- unique לפי זהות מקור מתאימה: inbox role+phoneNumberId+messageId. לשמר payload/envelope, מצב, attempts, timestamps, claim token, שגיאה, route decision ו־nextAttemptAt. אין ACK לפני commit.
- claim אטומי ומדורג, לכל היותר ראש התור הפעיל לכל משתתף; `SKIP LOCKED` לבדו אינו מבטיח סדר לאותו משתתף. token מונע completion של worker ישן אחרי reclaim. recovery מתחשב בתופעות לוואי עמומות ואינו מתחיל flow מחדש בעיוורון.
- indexes ל־due/status/sender; אין SELECT/serialization של כל ההיסטוריה לכל הודעה. retention של dedupe נפרד משמירת payload; אין להסתמך על rememberMessage בזיכרון אחרי restart. להגדיר חלון dedupe מתועד/configurable, ברירת מחדל ראשונית 30 יום, ולא לטעון להגנה אינסופית.
- held/failed אינם נגזמים אוטומטית כדי להקטין עומס. retry exhausted מופיע בדוח והתראה עם אפשרות requeue מאומתת; אינו completed. replay לא מדלג על בדיקות ריצה/גיל/בעלות.
- מיגרציה: pause workers וכתיבות קובץ לזמן הייבוא, לשמור גיבוי מקור/checksum, לייבא בטרנזקציה או batches עם checkpoint אידמפוטנטי, לאמת ספירות ומצבים, ורק אז לסמן מקור SQL ולהפעיל workers. אין שני backends פעילים ככותבים. אין dual-write לא אטומי שמתחזה להגנה.
- dry-run ודוח שגיאות לרשומות פגומות/כפילויות; לא למחוק מקור. rollback אחרי שנכנסו הודעות חדשות ל־SQL מחייב export/reconciliation, לא החזרת JSON ישן.

בדיקות עם PostgreSQL אמיתי: 100/150 enqueue במקביל, אותו ID שוב ושוב, אותו משתתף מול רבים, restart בזמן claim, rollback כתיבה, held replay, import כפול/קטוע, corruption, הפסקת DB וחזרתו. benchmark עם 300/5,000/50,000 רשומות היסטוריה ו־active backlog; להראות שהנתיב אינו משכתב את כולן.

## 10. שלב F — פריסה, גרסאות וניטור

### 10.1 פריסה

- לבנות image פעם אחת מחוץ לשרת ההרצה, מזוהה לפי commit ו־digest בלתי משתנה. להכין pipeline/config ותיעוד registry; אין להניח שיש registry או להמציא credentials.
- לזהות build variant של Meta/Baileys/Chromium לפי הקוד והלקוחות הקיימים. לא להסיר תלות שנדרשת לספק קיים. אפשר images שונים מאותו SHA אם ה־build args שונים; digest מפורש לכל variant.
- להוסיף `/version` או endpoint מאומת מקביל עם build SHA, protocol/schema capabilities; ללא סודות. health/liveness נשאר קל, readiness בודק את התנאים לעיבוד בטוח.
- bulk update: נעילת job, גרסה רצויה אחת לכל הריצה, canary, בדיקת גרסה ו־readiness, המשך מדורג ורק לאחר הצלחה. single update משתמש באותו מסלול. restart או retry של job אינם משגרים deployments כפולים ללא בירור מצב.
- build Done אינו הצלחה סופית; גם healthy של container ישן אינו הוכחה. לא להסתמך רק על title שנשלח ל־Dokploy. לאמת deployment ID כאשר קיים ובכל מקרה SHA/digest מתוך השירות בפועל.
- לשמר env/secrets/domains/volumes/DB. לא לקרוא provisionClient כתחליף לעדכון. שינוי image source הוא מיגרציית תפעול מפורשת, עם export תצורה ו־dry-run.
- להגדיר תבניות resources ניתנות להגדרה לפי מדידות; אין להמציא מגבלות RAM שעלולות לגרום ל־OOM. לא להוסיף replicas בשדרוג הזה. לא להפעיל עדכון אוטומטי לכל הלקוחות על כל push.
- canary לקוד תואם legacy יכול להיות לקוח יחיד; מעבר פרוטוקול central הוא לפי מספר שלם, ולא canary חצי־מספר.

### 10.2 ניטור והתראות

להרחיב systemAlerts הקיים: גיל הודעה ממתינה, אורך תור לפי סטטוס, uncertain/held חדשים, כשל שמירה, כשל owner handover, DB outage, כשל/איחור גיבוי, version mismatch ו־readiness לאחר deploy. לציין רכיב מושפע ופעולה מומלצת; להסוות טלפון וללא tokens או תוכן הודעות בלוגים/מיילים חדשים.

מדדים: webhook→durable, queue wait, routing, forward→accepted, client accepted→first useful send accepted, provider latency, p50/p95/p99 ו־event-loop lag. להפריד מקבלת HTTP 200, typing/read ומסירה בפועל למכשיר. לתמוך ב־correlation IDs בלי חשיפת payload.

התראות עם dedupe, הגבלת תדירות והודעת התאוששות. ברירות מחדל: הודעה due שממתינה מעל 30 שניות — warning; מעל 120 — critical; ספים configurable. לא להתריע על המתנת משתמש/השהיית קמפיין מתוכננת כאילו הייתה תקלה. ניטור חיצוני נדרש להתרעה כאשר השער כולו נפל; מייל מתוך השער אינו מכסה זאת.

בדיקות: provider מייל מזויף, throttle/recovery, scheduler שאינו רץ, גרסה לא נכונה אחרי deploy מוצלח לכאורה, כשל canary שעוצר bulk, מצב deployment לא־ודאי לאחר timeout, אי־שינוי הגדרות לקוחות.

## 11. תוכנית בדיקות והרצה

### 11.1 בטיחות סביבת הבדיקה

לפני הרצת סקריפט לבדוק מה הוא עושה. test:health-live וכלי provision/migration אינם בטוחים אוטומטית בגלל שמם. לכל בדיקה temp directory ומסד בדיקה ייעודי; להחיל allowlist ל־localhost/רשת בדיקה ולסרב לכתובת ייצור. Meta/Baileys/Google/SMTP/Dokploy מוחלפים ב־fakes מקומיים. אין העתקת env ייצור לתהליכי בדיקה.

להשתמש ב־PostgreSQL אמיתי זמני לבדיקות transactions, unique constraints, claims, migrations ושחזור. mock שלא מממש connect/transaction אינו תחליף. אם runtime חסר, להכין הוראת setup מדויקת ולדווח חסימה; אין skip שקט ואין דוח ירוק על DB שלא נבדק.

### 11.2 בדיקות קיימות

לבנות פעם אחת לפני קבוצת בדיקות: `npm run build`. להריץ ברצף, תוך בדיקת exit code של כל פקודה. הסוויטות הבאות קיימות בבסיס שנבדק; לעדכן ציפיות רק כשהחוזה השתנה במכוון ולתעד מדוע:

```text
node scripts/test-silent-data-loss-fixes.js
node scripts/test-outbox-durability.js
node scripts/test-outbox-ordering.js
node scripts/test-outbox-claim.js
node scripts/test-file-delivery-order.js
node scripts/test-meta-campaign-routing.js
node scripts/test-meta-switch-inflight.js
node scripts/test-meta-cancellation-boundary.js
node scripts/test-meta-mixed-rollout-routing.js
node scripts/test-meta-gateway-reliability.js
node scripts/test-meta-gateway-lookup-failure-isolation.js
node scripts/test-meta-gateway-inbox.js
node scripts/test-meta-routes-cache.js
node scripts/test-inbox-sender-concurrency.js
node scripts/test-meta-webhook-signature.js
node scripts/test-meta-media-cache.js
node scripts/test-meta-contact-payload.js
node scripts/test-meta-typing-indicator.js
node scripts/test-meta-trigger-age-window.js
node scripts/test-meta-speed-and-list-presentation.js
node scripts/test-message-delays.js
node scripts/test-flow-concurrency.js
node scripts/test-flow-recovery.js
node scripts/test-decision-pending-registration-order.js
node scripts/test-conversation-state-flow-rehydration.js
node scripts/test-conversation-state-atomic-write.js
node scripts/test-campaign-delete-conversations.js
node scripts/test-campaign-data-reset.js
node scripts/test-service-bot-flow.js
node scripts/test-service-bot-ui.js
node scripts/test-group-join-flow.js
node scripts/test-referral-ranking.js
node scripts/test-email-capture.js
node scripts/test-email-export.js
node scripts/test-whatsapp-link-normalization.js
node scripts/test-postgres-delta.js
node scripts/test-postgres-row-snapshot.js
node scripts/test-postgres-no-lost-writes.js
node scripts/test-postgres-transactions.js
node scripts/test-postgres-dirty-tables.js
node scripts/test-flush-scoped-wait.js
node scripts/test-migration-safety.js
node scripts/test-graceful-shutdown.js
node scripts/test-provider-health.js
node scripts/test-client-disable.js
node scripts/test-system-alerts.js
node scripts/test-dokploy-provisioner-postgres.js
node scripts/test-redeploy-existing-client.js
node scripts/test-bulk-redeploy-status.js
```

להוסיף runner עם manifest של הסוויטות, timeouts, בידוד env, cleanup ב־finally ודוח JSON. בשלב מסוים להריץ את תת־הקבוצה הרלוונטית; בסיום את כל הרגרסיה. בדיקות חדשות נדרשות לכל תרחישי סעיפים 5–10. אין להסתפק ברשימה הקיימת או tests שמאמתים רק שהפונקציה נקראה.

לבצע mutation ממוקד לארבע הגנות: הסרת סינון לפני LIMIT, הסרת בדיקת run/context, הסרת unique reservation, ושליחת ACK לפני persistence. כל שינוי זמני חייב להפיל בדיקה מתאימה; להחזירו במדויק, בלי git reset גורף. אפשר mutation באמצעות fixture/build זמני. לתעד תוצאה ולא רק לכתוב שיש mutation coverage.

### 11.3 עומס ובידוד

להרחיב את כלי העומס הקיימים, לרבות `test-load-shared-campaign-isolation.js`, `test-load-multiprocess-focus.js`, `test-load-client-responsiveness.js`, `test-load-gateway-noisy-vs-quiet.js`. לבדוק סקריפטים לא מנוהלים לפני הכללה.

מחולל עומס, שער ולקוחות רצים בתהליכים נפרדים, וכל תרחיש בתהליך נקי. להריץ תרחישים ברצף, לא שתי בדיקות עומס במקביל. במעבדה משתמשים בזרימת פוקוס מסוננת ללא מידע אישי, במספרים סינתטיים ובספקים מזויפים, לא ב־URL הלקוח בייצור.

| תרחיש | תכולה |
|---|---|
| פיק יחיד | 100 ואז 150 משתתפים שונים לאותו קמפיין |
| Meta מעורב | פוקוס + שני קמפיינים קטנים, סך 150 כניסות; גם שני קמפיינים באותו לקוח |
| משולב ספקים | התרחיש הקודם ובמקביל 60 משתתפי Baileys עם transport מזויף ומנוע אמיתי |
| בידוד משתתף | חלק מהמשתתפים עוברים A→B בזמן timer/שליחה ולוחצים על כפתור ישן; IDs זהים במכוון |
| תקלה | לקוח לא קשור מסרב לחיבור 60 שניות; בנפרד לקוח hangs; בנפרד הבעלים הקודם תקול |
| עמידות | restart שער/לקוח בזמן עומס, DB outage והתאוששות, webhook כפול ו־out-of-order |
| הצטברות | 20/100 held בראש Outbox; Inbox עם 50,000 היסטוריים ו־backlog פעיל |
| התמשכות | 1,000 כניסות בגלים לאורך 20 דקות; ניתוח זיכרון, תורים ו־lag |

לשמור oracle עצמאי: עבור כל inbound ופעולת שליחה צפויים clientId/campaignId/runId/stepId/recipient. להשוות כל השליחות, התוצאות, אנשי הקשר ואירועי השיחה — לא רק הודעה ראשונה או טקסט זהה. לבדוק שכל הודעה מסתיימת בהצלחה או במצב כשל/hold מפורש וצפוי, ולא נעלמת.

מדידות ביצועים: baseline מהגרסה ההתחלתית באותה סביבת בדיקה, warm-up אחד ו־5 ריצות מדודות לתרחישים הקצרים. לשמור seeds, חומרה, מספר תהליכים, השהיות הקמפיין והספק המדומה. הבדיקה הממושכת נדרשת לפחות פעם אחת. אין לבחור רק את הריצה המהירה.

תנאי קבלה:

1. אפס שיוכים/שליחות לריצה או לנמען שגויים בכל התרחישים; אפס אובדן שקט.
2. בכל אחת מ־5 ריצות העומס התקינות: חציון webhook→קבלת ההודעה השימושית הראשונה אצל הספק המדומה קטן מ־7 שניות, לכל קבוצת קמפיין בנפרד. typing/read ו־HTTP 200 אינם תשובה שימושית.
3. למדידת תקציב התוכנה להשתמש ב־fixture ללא השהיית קמפיין לפני תשובה ראשונה, עם השהיית ספק מתועדת וקבועה. בנוסף להריץ זרימת פוקוס עם ההשהיות האמיתיות ולדווח זמן כולל; אין לחסר השהיות ולכנות את התוצאה זמן משתמש. אם הגדרת הקמפיין עצמה מונעת 7 שניות, לדווח זאת במפורש, לא לשנות אותה בשקט.
4. לדווח p95/p99/max וכשלים לצד החציון, לפני ואחרי; אין די בחציון שמסתיר קמפיין קטן רעב. בשגרה לדרוש ללא נסיגה מובהקת בזנב מול baseline; להגדיר ולתעד את סבילות המדידה מראש, לא לאחר תוצאה נכשלת.
5. central אינו פונה לכלל הלקוחות עבור הודעה; גידול 1→10→30 לקוחות אינו מגדיל מספר בקשות discovery לכל הודעה. לקוח לא קשור offline אינו חוסם את הקמפיינים התקינים, שגם עבורם נבדק יעד החציון. מעבר שמחכה לבעלים הקודם מדווח בנפרד כהמתנת בטיחות.
6. כל בדיקות PostgreSQL ובידוד החדשות רצות ללא דילוגים. חוסר בתשתית אינו אישור קבלה.

בדיקת מסירה אמיתית לטלפוני בדיקה היא שלב rollout נפרד ומורשה. סימולציה אינה הוכחה לזמן המסירה של Meta או לביצועי חומרת הייצור.

## 12. תוצרים, דיווח וסיום

לספק:

1. קוד, migrations קדימה, adapters ותצורה לדוגמה ללא סודות; טיפול תואם בנתונים קיימים.
2. runner ותוצאות בדיקות JSON, כולל exit codes, ספירות pass/fail/skip ונתוני עומס לכל ריצה.
3. `docs/system-safety-speed-upgrade-results-2026-09-20.md`: טבלת דרישה→מימוש→בדיקה→תוצאה, מגבלות ואי־ודאויות. להבחין בין בדיקה שרצה, בדיקה מתוכננת ופעולה שטרם נעשתה בייצור.
4. `docs/system-safety-speed-rollout-2026-09-20.md`: פקודות/פעולות מדויקות עבור הגיבוי, יצירת המאגר, env, migrations, build/image, capabilities, bootstrap, cutover, verification ונסיגה. לכל שלב תנאי כניסה/יציאה ומצב צפוי.
5. דוח preflight שאפשר להריץ read-only: התנגשויות טריגר, גרסאות, backend, משימות בתנועה, גיבוי אחרון ומוכנות מעבר. אי־מוכנות עוצרת פריסה עם סיבה ברורה.
6. רשימת מה שנדרש מהמשתמש, מרוכזת: יעד גיבוי והרשאות, registry אם חסר, מאגר השער, אמצעי ניטור חיצוני, נמעני התראות וחלון cutover. לא לבקש סודות בצ׳אט; להשתמש בתצורה המאובטחת המקובלת.

אין לסמן “הכול תוקן” רק משום שה־build עבר. הגדרת סיום הקוד: כל סעיפי החובה מומשו, בדיקות הבידוד/שמירה/עומס עברו, ומסלול מעבר קיים נבדק בסביבה מבודדת. הגדרת סיום תפעולי נפרדת: גיבוי ייצור מאומת, פריסה מאושרת, גרסאות ו־readiness נבדקו ובדיקת קצה לקצה עברה. עד אז לכתוב במפורש “מוכן לפריסה” עם התנאים שנותרו.
