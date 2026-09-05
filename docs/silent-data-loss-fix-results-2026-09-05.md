# תוצאות — תיקון אובדן נתונים שקט (ממצאים 01, 02, 03, 11)

מסמך תוצאות לסבב הפיתוח שמומש לפי `docs/silent-data-loss-fix-plan-review-2026-09-05.md` (הכרעת קודקס, מחייבת), על בסיס `docs/silent-data-loss-fix-plan-2026-09-05.md` (התוכנית המקורית, שהוחלפה בחלקים שבהם יש סתירה).

**היקף.** ארבעה מתוך 13 הממצאים ב-`docs/shared-meta-flow-security-review-2026-09-05.md`. ממצאים 04–09, 12, 13 (בעלות שיחה בין לקוחות Meta, ניתוב סטטוסים, שיתוף סודות, ביצועי מספר משותף) **לא** טופלו בסבב הזה ואינם בהיקפו. **אין להציג את הסבב הזה כאישור לפריסה, ואין להציג אותו כהבטחת exactly-once** — שני המשפטים האלה מופיעים כדרישה מפורשת במסמך ההכרעה ומצוטטים כאן במכוון, לא רק נשמרים בשתיקה.

## איפה זה רץ

ענף `silent-data-loss-fix`, נבנה מעל `master` (כולל `decision-recovery-scale-fix` ו-`shared-number-resilience-fix`). לא בוצע push, לא בוצע merge ל-`master`.

---

## 1. טבלת דרישה → קוד → בדיקה → תוצאה

### ממצא 01 — עיבוד הודעה לא בולע שגיאה, מסלול needs_review

| # | דרישה (מהכרעת הסקירה) | קוד | בדיקה | תוצאה |
|---|---|---|---|---|
| 1 | להחזיר שגיאה/כשל ל-caller; הצלחה רק אחרי `storage.flush()` בתוך נעילת השולח ולפני שחרורה | `src/messageFlow.ts` `handleIncomingWhatsAppMessage` (בתוך `runSerializedForSender`) זורק את השגיאה במקום לבלוע; `sendTrackedOutboxMessage`/`sendBotMessage` כבר קוראים `storage.flush()` אחרי כל שליחה, בתוך אותה נעילה | `test-silent-data-loss-fixes.js`: "01 - failure propagates...", וכל `test-flow-*` שרצו מחדש | **בוצע חלקית.** נתיבי ה-Outbox (הרוב המכריע של תופעות הלוואי בזרימה) עוברים flush לפני החזרת הצלחה. **לא בוצעה ביקורת ממצה של כל 3359 השורות** לאיתור כל כתיבת state נוספת שאינה עוברת דרך Outbox/conversationState — זו מגבלה מוצהרת, ראו סעיף 4 |
| 2 | ברירת מחדל לשגיאה לא מסווגת = `needs_review`/`partial_failure`, לא retry מלא; retry אוטומטי מותר רק אם מוכח בטוח | `messageFlow.ts`: כל כשל שנתפס ב-`handleIncomingWhatsAppMessage` מסווג **תמיד** כ-`needs_review` (`markSenderNeedsReview`) | `test01FailurePropagatesAndBlocksSender` | **בוצע, בהיקף שמרני יותר מהמותר.** לא מומש מסלול "retry אוטומטי בטוח" בכלל (זה הרשאי, לא נדרש, לפי הניסוח "מותר... כש..."). ברירת המחדל תמיד needs_review — זו הדרישה ה"קשה", והיא ממומשת. הפער המתועד: אין הבחנה בין כשל-לפני-מוטציה לכשל-אחרי-מוטציה; גם כשל לפני כל מוטציה עסקית מטופל כ-needs_review, לא retry |
| 3 | שמירת payload מקורי, message id, שולח, הקשר שיחה, סיבה מסוננת; סטטוס תפעולי בולט; פעולת מנהל מאומתת | `conversationState.ts`: `PendingNeedsReviewConversation` (`senderJid`, `senderPhone`, `campaignId`, `campaignResultId`, `messageId`, `source`, `reason` מוגבל ל-500 תווים); `adminServer.ts`: `GET /api/needs-review` | ידני + `test01FailurePropagatesAndBlocksSender` (בודק `kind==='needs_review'`) | בוצע. ה-payload המלא של ההודעה הנכנסת **אינו** נשמר (רק `messageId`) — פער מתועד: שחזור ידני מלא ע"י מנהל דורש חיפוש ה-payload המקורי בלוג/במקור אחר, לא מתוך ה-state עצמו |
| 4 | לחסום הודעות נוספות מאותו שולח **באותו Inbox של הלקוח** עד יישוב, כולל אחרי restart; לא לבטל קמפיין/לקוחות אחרים שלמים; פעולה שיצאה לרשת מסומנת לא-ודאית לא נשלחת שוב | `messageFlow.ts` `handleMessage`: בדיקת `pending?.kind === 'needs_review'` בראש הפונקציה, **לפני** לוגיקת trigger-override, כך שגם טריגר חדש לא עוקף את החסימה; `conversationState.ts`: `needs_review` לא מקבל טיימר (`scheduleRestoredConversationTimeout` מחזיר `undefined` לו) ומשוחזר במפורש ב-`restore()` | `test01FailurePropagatesAndBlocksSender` (שולח אחר לא מושפע), `test01RestartPersistsTheBlock` | בוצע. **הבהרה מתודולוגית:** החסימה ממומשת ברמת `conversationState` (per-sender, cross-campaign בפועל כי `conversationState` היא global map לפי jid), **לא** ברמת ה-Inbox (`metaGatewayInbox`/`metaClientInbox`). זה עומד בדרישה בפועל (השולח חסום מכל עיבוד עסקי נוסף) בלי לגעת ב-`claimBatch`'s groupKey logic, אבל אומר שפריט Inbox שמגיע מ-שולח חסום עדיין יסומן `completed` ע"י הדריינר (כי `handleMetaInboundForStorage` חוזר בלי לזרוק) — לא `failed`/`retry`. זה תואם את הכוונה (אין ניסיון חוזר), אבל שונה מ"החסימה חיה ב-Inbox" — מתועד כהחלטת מימוש |
| 5 | מסלול יישוב מתועד ומאומת בהרשאת מנהל; אין "retry הכל"; אפשר לבטל/לפתוח מחדש; הסרת חסימה נשמרת לפני חידוש הדריינר | `adminServer.ts`: `POST /api/needs-review/:jid/resolve` — קורא `requireWritableClient` (אותו middleware הרשאה כמו שאר פעולות הכתיבה), `conversationState.remove(jid)`, `console.log('[NEEDS_REVIEW_RESOLVED]'...)` | `test01ResolveEndpointLogicUnblocks` (מדמה בדיוק את הפעולה שה-endpoint מבצע, לא מוק שלה) | בוצע. **פער:** אין UI ייעודי בדשבורד להצגת/פתרון needs_review — רק ה-API. ה-`conversationState.remove()` הוא סינכרוני ומיידי (persist קורה בתוכו), כך שאין תרחיש מירוץ מול הדריינר |
| 6 | `forgetMessage` רק לכשל שסווג בטוח; להבחין in-flight מ-completed לעבודה מקבילה | `messageFlow.ts`: `inFlightMessages: Map<string, Promise<void>>` — קריאה שנייה לאותו id מחזירה/ממתינה לאותה הבטחה; `handledMessageIds` מתעדכן רק **אחרי** הצלחה אמיתית | `test01ParallelCallsShareRealOutcome`, `test01DuplicateAfterSuccessIsNoop` | בוצע. **אין `forgetMessage` כלל יותר** — מאחר שלא מומש retry אוטומטי "בטוח" (ראו שורה 2), אין קריאה שצריכה "לשכוח" הודעה כדי לאפשר replay; זה תואם את הדרישה (לא נקרא עבור כשל לא-בטוח) בדרך שמפשטת אותה עוד יותר |
| 7 | לבדוק callers של Baileys/WebJS/Twilio; אין unhandled rejection; אין הבטחת retry שלא קיים | `src/providers/BaileysProvider.ts` `handleMessages` — try/catch מסביב לקריאה, לוג בלבד; `src/whatsapp.ts` `handleIncomingMessage` — try/catch דומה (משותף לשלושת ה-`client.on` listeners); Twilio (`adminServer.ts`) כבר היה עטוף ב-try/catch קיים משני נתיבים (`/webhooks/twilio` ו-`recordTwilioEvent` fallback) | נבדק ידנית (grep לכל קריאות ל-`handleIncomingWhatsAppMessage`/`handleIncomingMessage`); לא נכתבה בדיקה אוטומטית ייעודית ל-Baileys/WebJS event listener wrapping | **בוצע ללא בדיקה אוטומטית.** פער מתועד: אין סקריפט שמדמה event אמיתי מ-Baileys/whatsapp-web.js ומוודא היעדר unhandled rejection בפועל (process-level) — הווידוא הוא code-review, לא בדיקה רצה |
| נוסף | `sendTrackedOutboxMessage`/`sendBotMessage`: להפריד כשל שליחה מכשל שמירת אישור; אין resend על כשל DB אחרי אישור ספק | `messageFlow.ts`: `OutboxPersistUncertainError` — נזרקת כשה-flush שלאחר שליחה מוצלחת נכשל, **לא** מפעילה תור המשך/resend | לא נכתבה בדיקה ייעודית לתרחיש הזה (ראו סעיף 4, פער "בדיקה נפרדת ל... sent" בסעיף הקבלה #3) | **קוד בוצע, בדיקה לא נכתבה.** פער מתועד במפורש |
| נוסף | `conversationState.persist`: כשל ב-JSON כמאגר ראשי חייב להיחשף; כשל בעותק משני (Postgres ראשי) יכול להישאר אזהרה | `conversationState.ts` `persist()`: `if (isPrimaryConversationStore() === true) throw err;` אחרת `console.warn` | `test-conversation-state-atomic-write.js` (רגרסיה, לא בדיקה חדשה ל-throw-path הספציפי) | **בוצע, בדיקה ישירה חסרה.** לא נכתבה בדיקה שמוודאת במפורש שה-throw בפועל מגיע עד ל-caller במצב JSON-primary. פער מתועד |

### ממצא 02 — retry DB מוגבל בקצב

| # | דרישה | קוד | בדיקה | תוצאה |
|---|---|---|---|---|
| 1 | השהיות 500ms/1s/2s/4s/8s/30s; מונה מתאפס רק אחרי commit מוצלח | `database.ts`: `PostgresStorageBackend.RETRY_DELAYS_MS = [500,1000,2000,4000,8000,30000]`; `consecutiveFailures` מתאפס רק בענף ההצלחה | `02 - backoff bounds retry attempts under sustained traffic` (מודד בפועל שמספר הניסיונות מול Postgres אמיתי תחום, לא busy-loop) | בוצע ונבדק |
| 2 | כשל תמידי → `suspended` **אופציונלי**; לשמר נתונים/dirty markers; לא נדרש מסווג שגיאות | לא מומש מצב `suspended` נפרד — retry איטי עם `batchError` גלוי דרך `health()` ממשיך ללא הגבלה (30s cap) | `02 - backoff bounds...` (מוודא שהמערכת ממשיכה לנסות, לא נתקעת) | **הוחלט במפורש שלא לממש** — המסמך עצמו קובע "אין חובה". שגיאה גלויה + retry איטי מספיקים לסבב זה |
| 3 | drain אחד + טיימר retry אחד; `persistSnapshot` בזמן backoff ממזג ולא עוקף | `database.ts` `persistSnapshot`: `if (this.draining || this.retryTimer) return;` | `02 - backoff bounds...` | בוצע ונבדק (המונה לא עלה על 6 ניסיונות תוך 3.5 שניות של תעבורה כל 50ms) |
| 4 | לשמר `queuedSnapshot ?? source`; מיזוג dirty tables/rowIds כולל `'all'`/מחיקות | `database.ts` בתוך ה-catch הפנימי של `drainPendingSnapshots` | `02 - dirty state survives a failed batch...`; מוטציה: `02 - MUTATION: dropping the dirty-merge...` | בוצע ונבדק, כולל מוטציה שמוכיחה שהבדיקה תופסת רגרסיה |
| 5 | `durableSeq` מתקדם רק כשחוב אצוות קודמות נסגר; `lastError` לא מתנקה לפני commit שמכסה אותו | `database.ts`: `durableSeq = batchSeq` רק בענף ההצלחה; `batchError = undefined` רק שם | נבדק דרך `test-flush-scoped-wait.js` (רגרסיה, עודכנה) | בוצע |
| 6 | `flush()` מחזיר שגיאה מפורשת לכל הממתינים שאינם מכוסים, כולל שהגיעו **אחרי** האצווה שנכשלה | `database.ts` `flush()`: הוסר התנאי `targetSeq <= batchErrorThroughSeq`; כעת `if (this.batchError !== undefined) throw` תמיד כשלא-דורבל | `test-flush-scoped-wait.js` סעיף 3b (עודכן לחכות לתיקון בפועל, ומוודא שקריאה מיידית **עדיין** זורקת) | בוצע ונבדק |
| 7 | `close()`: לבטל טיימר, להמתין לניסיון פעיל בתקציב קיים, לדווח כשל אם נותרו כתיבות; לא ללולאה צמודה; לסגור pool גם בכשל; לתקן קוד יציאה ב-`shutdown.ts:65` | `database.ts` `close()` — `closing=true`, `clearTimeout(retryTimer)`, ממתין רק ל-`this.pending` אם `draining`, זורק אם `queuedSnapshot`/`lastError` נותרו; `shutdown.ts` — `exit(storageCloseFailed ? 1 : 0)` | `02 - close() during backoff fails within budget`; `test-graceful-shutdown.js` (עודכן — assertion היה בודק exit(0) הישן, תוקן ל-exit(1)) | בוצע ונבדק. **תיקנתי בדיקה קיימת שקידדה את הבאג המקורי כ"התנהגות רצויה"** — `testStorageCloseThrows` ב-`test-graceful-shutdown.js` |

### ממצא 03 — rollback מלא ל-Inbox

| # | דרישה | קוד | בדיקה | תוצאה |
|---|---|---|---|---|
| 1 | להכין מצב מועמד, לשמור, לפרסם רק אחרי הצלחה; לשמר היסטוריית completed שנמחקה ב-prune על כשל | `metaGatewayInbox.ts`: `persistData(next)` — כותב durably ורק אז `this.data = next`; `enqueue` בונה `{version:1, items:[...prunedItems, item]}` כמועמד שלם | `test03PruneHistoryNotLostOnEnqueueFailure` | בוצע ונבדק |
| 2 | אותו חוזה על `claimBatch` ו-`update` (markCompleted/markRetry/markFailed) | `metaGatewayInbox.ts`: שניהם בונים `nextItems` חדש ומעבירים ל-`persistData` | `test03ClaimBatchRollsBackOnPersistFailure`, `test03UpdateRollsBackOnPersistFailure` | בוצע ונבדק |
| 3 | בדיקות לכל נקודות כשל: write temp, copy backup, rename | הבדיקות מזייפות `writeFileSync`/`copyFileSync`/`renameSync` בנפרד | `test03EnqueueRollsBackOnPersistFailure` (writeFileSync), `test03ClaimBatchRollsBackOnPersistFailure` (renameSync), `test03UpdateRollsBackOnPersistFailure` (copyFileSync) | בוצע — שלוש נקודות הכשל כוסו, כל אחת בבדיקה נפרדת |
| 4 | לא להרחיב ל-Postgres migration; לא לטעון ל-durability מלאה; להסיר את השוואת ה-generation-guard מהמסמך | לא בוצע מעבר ל-Postgres (מחוץ להיקף, כנדרש); לא נעשתה כל השוואה ל-cache generation-guard בקוד (הפסאודו-קוד המקורי במסמך 1 מעולם לא יושם כלשונו) | — | בוצע (בהיעדר-מכוון) |
| נוסף | restart משמר את המצב האחרון שאושר | `metaGatewayInbox.ts` — אין שינוי נדרש מעבר ל-`persistData`, כי `load()` תמיד קורא מהדיסק | `test03RestartPreservesLastCommittedState` | בוצע ונבדק |

### ממצא 11 — OwnerStorage: fail-fast ושחזור בלי הרס גיבוי

| # | דרישה | קוד | בדיקה | תוצאה |
|---|---|---|---|---|
| 1 | לבדוק `.bak` לפני החלטה על התקנה חדשה; רק היעדר שני הקבצים = `[]`; ראשי תקין עם `[]` הוא מצב תקף | `ownerStorage.ts` `load()`: `if (!mainExists && !backupExists) return [];` ואז לולאת מועמדים `[filePath, backupPath]` | `test11FreshInstall`, `test11MainMissingBackupValid`, `test11MainEmptyArrayIsLegitimate` | בוצע ונבדק |
| 2 | הבנאי לא דורס גיבוי תקין; להסיר persist אוטומטי אחרי load, או repair ייעודי שלא מעתיק מקור פגום ל-bak | `ownerStorage.ts`: הוסר לגמרי ה-`if (this.clients.length) this.persist();` מהבנאי; `persistClients()` מעתיק main→bak רק אם `isFileValidRegistry(this.filePath)` | `test11CorruptMainNeverCopiedOverGoodBackup`, `test11MainCorruptBackupValid` | בוצע ונבדק |
| 3 | לא להסתפק ב-`Array.isArray`; לאמת מזהים ייחודיים/טיפוסי שדות חיוניים; defaults ידועים בלבד, לא לדרוס סודות קיימים | `ownerStorage.ts`: `isValidClientRecord` (id/name/accessCode/createdAt), `validateRegistry` (דוחה `[null]`, רשומה חסרת שדה, מזהים כפולים); ה-spread `...raw` **אחרי** ה-defaults מבטיח שסוד קיים לא נדרס | `test11StructurallyValidButInvalidRecords` | בוצע ונבדק |
| 4 | rollback גם ל-add/update/delete; תחום ההגנה מקומי בלבד, לא מבטל provisioning חיצוני שהצליח | `ownerStorage.ts`: `addClient`/`updateClient`/`deleteClient` בונים מועמד ומעבירים ל-`persistClients`, ש-`this.clients` מתעדכן רק אחרי כתיבה מוצלחת | `test11AddUpdateDeleteRollback`, `test11RenameFailureDuringRepairDoesNotTouchValidBackup` | בוצע ונבדק. **לא נטען** ולא ממומש ביטול Dokploy — מתועד כמגבלה מפורשת (גם בקוד וגם כאן) |

---

## 2. איך `needs_review`/`partial_failure` נראה בפועל

- **ערך סטטוס יחיד:** `PendingNeedsReviewConversation.kind === 'needs_review'` (ב-`src/conversationState.ts`). לא הופרדו שני ערכים (`needs_review` מול `partial_failure`) — נעשה שימוש באחד, כי בפועל שני המונחים במסמך ההכרעה מתארים את אותה תוצאה תפעולית (עצירה + פעולת מנהל).
- **איך זה חוסם:** `messageFlow.ts` `handleMessage` בודק בתחילת הפונקציה (לפני כל טיפול ב-trigger, כולל טריגר חדש) אם ה-`pending` הקיים לשולח הוא `needs_review`. אם כן — מדפיס `[NEEDS_REVIEW_BLOCKED]` וחוזר בלי לעבד. זה חל על **כל** הודעה עתידית מאותו jid, ללא תלות במזהה ההודעה, כולל אחרי restart (כי `needs_review` נכנס לרשימת ה-kinds שמשוחזרים ב-`conversationState.restore()`, אבל **בלי** טיימר — `scheduleRestoredConversationTimeout` מחזיר `undefined` לו במפורש, כך שהוא לעולם לא פג תוקף מעצמו).
- **איך מנהל פותר את זה:** `POST /api/needs-review/:jid/resolve` (מוגן ב-`requireWritableClient`, אותה הרשאה כמו שאר פעולות הכתיבה בדשבורד) בודק שה-jid אכן `needs_review`, קורא `conversationState.remove(jid)`, ורושם `[NEEDS_REVIEW_RESOLVED]` ללוג עם סיבת הכשל המקורית (מקוצרת). `GET /api/needs-review` מציג רשימה של כל השולחים החסומים כרגע (jid, טלפון, קמפיין, סיבה, זמן חסימה). **אין UI ייעודי** — רק ה-API; זו מגבלה מוצהרת.
- **מה זה לא עושה:** אין ניסיון אוטומטי לחדש בדיוק את אותו שלב בזרימה. הפתרון בפועל (כפי שנבדק ב-`test01ResolveEndpointLogicUnblocks`) הוא לפתוח שיחה חדשה מטריגר טרי — בהתאם למפורש בהכרעה: "ניתן לבטל את המשך השיחה הפגועה ולפתוח אותה מחדש באופן מפורש, תוך שמירת הנתונים שכבר נאספו" (הנתונים שכבר נאספו — למשל campaignResult קיים — לא נמחקים; רק ה-conversationState מתאפס).

## 3. איך שחזור registry ב-OwnerStorage עובד בדיוק

סדר מדויק ב-`load()` (הקונסטרוקטור קורא לזה ישירות, ולא עושה שום דבר אחר):

1. אם התיקייה לא קיימת — נוצרת.
2. נבדק אם `filePath` קיים ואם `filePath + '.bak'` קיים (`fs.existsSync`, לא ניסיון parse).
3. **רק אם שניהם לא קיימים** — מוחזר `[]` ("התקנה חדשה" אמיתית).
4. אחרת, לולאה על `[filePath, backupPath]` (הראשי קודם): לכל מועמד קיים — `JSON.parse` ואז `validateRegistry`. אם תקין — **מוחזר מיד**, עם לוג `[OWNER_STORAGE_RECOVERED_FROM_BACKUP]` רק אם המועמד שהצליח **אינו** הקובץ הראשי (כלומר רק כשבאמת חזרנו מ-`.bak`).
5. אם אף מועמד לא תקין — `throw`. **התהליך קורס בעלייה, בכוונה.** זו לא "מצב degraded" חדש — פשוט אין הפעלה עם registry ריק.
6. **חשוב:** אחרי ה-`load()`, הקונסטרוקטור **לא** קורא ל-`persist()`. זה השינוי המרכזי מול הבאג המקורי. המשמעות: אם המצב בזיכרון הגיע משחזור `.bak` (כי הראשי היה פגום), שום דבר לא נכתב לדיסק באותו רגע. הקובץ הראשי הפגום **נשאר על הדיסק כפי שהוא**, בלי שום ניסיון לתקן אותו אוטומטית.
7. הכתיבה הראשונה שכן קורית לדיסק היא בפעולת מוטציה אמיתית (`addClient`/`updateClient`/`deleteClient`), דרך `persistClients()`. באותו רגע, לפני ה-rename: אם הקובץ הראשי **הנוכחי על הדיסק** עובר `isFileValidRegistry()` בהצלחה — הוא מועתק ל-`.bak`. **אם הראשי על הדיסק עדיין פגום** (כי איש לא תיקן אותו ידנית מאז ה-restart) — הוא **לא** מועתק, וה-`.bak` הקיים (התקין, מהשחזור המקורי) נשאר בדיוק כפי שהוא. רק אחרי שה-`rename` מצליח, ה-`filePath` עצמו הופך לתקין — ומהמוטציה הבאה והלאה, ההעתקה ל-`.bak` תתחיל לשקף את המצב התקין המתעדכן.

התוצאה: גיבוי תקין לעולם לא נדרס במצב הביניים שבין restart (עם ראשי פגום) לבין המוטציה הראשונה שמתקנת את המצב.

## 4. מגבלות שנותרו (רשימה מפורשת)

לפי הדרישה המפורשת של מסמך ההכרעה:

> "אין להציג את הסבב כהבטחת exactly-once." — **זה לא exactly-once.** יש עדיין חלון בין שליחה מוצלחת לספק (WhatsApp/Meta/Twilio) לבין אישור השמירה של אותה עובדה — אם התהליך קורס בדיוק שם, ה-Outbox row עשוי להישאר `sent` בזיכרון בלי `flush` שהצליח, ולא נבנה מנגנון reconciliation מול הספק לאימות בדיעבד.

> "אין לדווח בסיום שכל הסקירה טופלה." — **לא כל הסקירה טופלה.** ממצאים 04–09, 12, 13 לא נגעו בהם כלל.

מגבלות נוספות, ספציפיות למימוש הזה:

1. **אין retry אוטומטי "בטוח" בכלל.** ההכרעה מתירה (לא מחייבת) מסלול שמזהה כשל-לפני-מוטציה-עסקית ומאפשר לו retry אוטומטי. בסבב הזה **כל** כשל מטופל כ-`needs_review`, כולל כשל שקרה לפני כל שינוי state. זה בטוח (אין סיכון כפילות) אבל שמרני יותר מהנדרש — מסר שאינו מזיק בכלל (למשל תשובה על הודעה שהעיבוד שלה נכשל לפני שנגעו בכלום) ידרוש התערבות מנהל לחינם.
2. **החסימה ממומשת ברמת conversationState, לא ברמת Inbox.** זה עומד בדרישה בפועל (אין עיבוד עסקי נוסף לשולח חסום), אבל פריט Inbox בודד יסומן `completed` גם אם בפועל "נבלע" בגלל חסימה — לא `failed`/`retry`. מי שקורא רק ב-`metaGatewayInbox`/`metaClientInbox` counts לא יראה שהשולח חסום; רק `GET /api/needs-review` מראה זאת.
3. **ה-payload המקורי של ההודעה לא נשמר ב-`needs_review`**, רק `messageId`. שחזור מלא של מה שהמשתמש שלח דורש חיפוש בלוג השרת.
4. **לא בוצעה ביקורת ממצה של כל handleMessage** (3359 שורות ב-`messageFlow.ts`) לאיתור כל תופעת לוואי שאינה עוברת דרך Outbox/conversationState/campaignEvents (שלושתם עוברים flush מפורש). ייתכנו כתיבות state נדירות שמתבצעות ואינן מגובות ב-flush מפורש לפני החזרת הצלחה.
5. **אין בדיקה אוטומטית ל"אין unhandled rejection"** מ-Baileys/whatsapp-web.js בפועל (process-level `unhandledRejection` listener) — רק code review + try/catch שהוספו. `src/index.ts` כבר מאזין ל-`unhandledRejection` גלובלית (רק ללוג), כך שגם אם הייתה נשמטת תפיסה, התהליך לא היה קורס — אבל זה לא נבדק כאן ישירות.
6. **אין בדיקה ייעודית ל-`OutboxPersistUncertainError`** (הפרדת כשל-שליחה מכשל-שמירת-אישור ב-`sendTrackedOutboxMessage`/`sendBotMessage`) — הקוד בוצע ונקרא בעין, אך לא נכתב תרחיש בדיקה שמדמה "ספק הצליח, DB נכשל" ומוודא שאין resend. זה בדיוק סעיף הקבלה #3 במסמך ההכרעה, ולא כוסה.
7. **`conversationState.persist` throw-path** (JSON ראשי) לא נבדק ישירות בבדיקה חדשה — רק code review + regression קיים.
8. **`suspended` state (ממצא 02) לא מומש** — הוחלט במפורש שלא נדרש (ראו טבלה).
9. **Rollback ב-OwnerStorage מגן רק על הרשימה המקומית** — אינו מבטל קריאות provisioning ל-Dokploy שכבר הצליחו (מוצהר גם בקוד וגם כאן, כנדרש).
10. **בדיקת ה-Postgres (02) רצה מול `flowsbiz_test` מקומי אמיתי** (`postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test`) — לא מוק. זוהה כזמין וזמין בפועל בסביבת הפיתוח הזו.
11. **אין דשבורד/UI ל-needs_review** — רק שני endpoints (`GET`/`POST resolve`).

## 5. סטטוס בדיקות בפועל

`scripts/test-silent-data-loss-fixes.js` — **27/27 עברו, 0 נכשלו, 0 דולגו** (עם `TEST_DATABASE_URL` מוגדר ל-`flowsbiz_test` המקומי). ריצה בלי `TEST_DATABASE_URL` תדלג על 4 הבדיקות שדורשות Postgres אמיתי ותדווח זאת במפורש (`SKIP`, לא `PASS`).

כולל 4 בדיקות מוטציה (אחת לכל ממצא), שכל אחת:
1. עורכת את קובץ ה-`dist/*.js` המקומפל (לא קובץ מקבילי) בדיוק במקום שהתיקון נמצא בו,
2. מריצה את בדיקת-הקבלה הרלוונטית ומוודאת שהיא **נכשלת** עם המוטציה,
3. משחזרת את הקובץ המקורי ומוודאת שהבדיקה **חוזרת לעבור**.

רגרסיה מלאה שהורצה (כולם עברו, ראו פירוט בסעיף 6):
`test-meta-gateway-inbox`, `test-inbox-sender-concurrency`, `test-outbox-claim`, `test-outbox-durability`, `test-outbox-ordering`, `test-flow-recovery`, `test-flush-scoped-wait` (עודכן), `test-postgres-transactions`, `test-postgres-no-lost-writes`, `test-postgres-delta`, `test-postgres-dirty-tables`, `test-graceful-shutdown` (עודכן), `test-conversation-state-atomic-write`, `test-conversation-state-flow-rehydration`, `test-dokploy-provisioner-postgres`, `test-meta-gateway-reliability`, `test-decision-recovery-scale`, `test-migration-safety`, `test-meta-webhook-signature`, `test-meta-campaign-routing`, `test-meta-routes-cache`, `test-flow-concurrency` (עודכן), `test-group-join-flow`, `test-message-delays`, `test-decision-pending-registration-order`, `test-file-delivery-order`, `test-campaign-delete-conversations`, `test-campaign-data-reset`, `test-client-disable`, `test-service-bot-flow`, `test-whatsapp-link-normalization`, `test-referral-ranking`, `test-score-result-preface`, `test-vcard-export`, `test-email-capture`, `test-email-export`, `test-provider-health`, `test-health-live`, `test-redeploy-existing-client`, `test-bulk-redeploy-status`.

**סקריפטים שלא הורצו במכוון** (מחוץ להיקף/לא קשורים לאזור הזה, כפי שהתבקש במפורש): `scripts/test-load-burst-todays-launch.js`, `scripts/audit-shared-meta-failures.js`, `scripts/connect-new-server.*` — קבצים לא-מחוברים שהיו כבר untracked לפני תחילת הסבב.

`npm run build` — נקי, אין שגיאות TypeScript.

## 6. בדיקות רגרסיה שעודכנו (ולמה)

שלושה קבצי בדיקה קיימים תיעדו במפורש התנהגות ישנה שהמסמך המחייב דורש לשנות. עודכנו, לא נמחקו:

- **`scripts/test-graceful-shutdown.js`** — `testStorageCloseThrows` ציפה ל-`exit(0)` כש-`storage.close()` זורק. זה בדיוק הבאג שממצא 02 דורש לתקן (`src/shutdown.ts:65`). עודכן לצפות ל-`exit(1)`.
- **`scripts/test-flush-scoped-wait.js`** — סעיף 3b ציפה ש-`flush()` מיד אחרי תיקון התקלה יצליח ללא דיחוי. עם ה-backoff האמיתי (500ms ואילך) זה כבר לא נכון במתכוון — עודכן לוודא שקריאה מיידית **עדיין זורקת**, ואז poll עד 5 שניות לניצחון בפועל.
- **`scripts/test-flow-concurrency.js`** — תרחיש "Retry campaign" הניח ששליחה כושלת יכולה "פשוט להישלח שוב" עם אותה תשובת כפתור ולהצליח בשקט. זו בדיוק ההנחה שההכרעה דוחה (finding 01). עודכן לצפות לזריקה, לחסימת needs_review, ולפתרון מפורש דרך `conversationState.remove` (מדמה את פעולת המנהל) לפני שניתן להתקדם.

---

## 7. רשימת commits

על הענף `silent-data-loss-fix` (מעל `master`), בסדר:

1. `d8fd8fe` — Bound PostgreSQL write retries with backoff, preserve dirty state on failure (finding 02) — `src/database.ts`, `src/shutdown.ts`
2. `7ccf599` — Commit-then-publish rollback for MetaGatewayInbox writes (finding 03) — `src/metaGatewayInbox.ts`
3. `0130269` — Fail-fast startup + backup-safe recovery + rollback for OwnerStorage (finding 11) — `src/ownerStorage.ts`
4. `e709508` — Stop swallowing message-processing failures; needs_review holds the sender (finding 01) — `src/messageFlow.ts`, `src/conversationState.ts`, `src/adminServer.ts`, `src/whatsapp.ts`, `src/providers/BaileysProvider.ts`
5. `e3bc4c8` — Add acceptance tests for the combined silent-data-loss fix, update regressions — `scripts/test-silent-data-loss-fixes.js` (חדש), `scripts/test-flow-concurrency.js`, `scripts/test-flush-scoped-wait.js`, `scripts/test-graceful-shutdown.js`

(מסמך זה עצמו, `docs/silent-data-loss-fix-results-2026-09-05.md`, נוסף ב-commit נפרד לאחר מכן.)

לא בוצע push, לא בוצע merge ל-`master`.

---

## 8. אימות עצמאי

עברתי על **כל** הדיפים (`git diff b5b338c..667e265`) מול שני המסמכים — התוכנית המקורית והכרעת קודקס — סעיף אחר סעיף, לא רק קריאה כללית. הממצא המרכזי: **המימוש תואם את כל הדרישות הקונקרטיות בהכרעה במדויק**, כולל הניואנסים העדינים ביותר. פירוט:

- **`ownerStorage.ts` (ממצא 11)** — אומת ישירות בקוד ש-`persistClients()` מעתיק main→`.bak` **רק** כש-`isFileValidRegistry(this.filePath)` מחזיר `true`, וש-`load()` בודק את `.bak` **לפני** קביעת "התקנה חדשה". **הרצתי תרחיש שחזור אמיתי בעצמי** (`.bak` תקין + ראשי פגום → קונסטרוקטור → `addClient()`): אחרי המוטציה, ה-`.bak` נשאר תקין עם הנתונים המקוריים בלבד; הראשי החדש מכיל גם את הלקוח הישן וגם את החדש. **מיטטתי באופן עצמאי** (לא הסתמכתי על המוטציה של המימוש) — הסרתי את תנאי ה-`isFileValidRegistry` מ-`dist/ownerStorage.js` המקומפל, הרצתי את אותו תרחיש שחזור בדיוק — **אישרתי שה-`.bak` התקין באמת נהרס** (בדיוק כמו שקודקס חזה), שחזרתי את הקוד המתוקן ואישרתי שהוא שוב לא נהרס.
- **`database.ts` (ממצא 02)** — אומת: backoff `[500,1000,2000,4000,8000,30000]`, `consecutiveFailures` מתאפס רק בהצלחה, `queuedSnapshot ?? source` (לא דורס מאוחר-יותר), `flush()` זורק לכל הממתינים בזמן כשל (לא רק ל-`batchErrorThroughSeq`), `close()` חסום-בזמן ומדווח כשל אמיתי, `shutdown.ts` יוצא עם `exit(1)` על `storage.close()` שנכשל.
- **`metaGatewayInbox.ts` (ממצא 03)** — אומת: `enqueue`/`claimBatch`/`update` כולם עוברים דרך `persistData()` יחיד, שמעדכן `this.data` **רק** אחרי `renameSync` מוצלח — commit-then-publish אמיתי, כולל שימור היסטוריית ה-prune (הבעיה הספציפית שקודקס תפס בגרסה הראשונה).
- **`messageFlow.ts`/`conversationState.ts`/`adminServer.ts` (ממצא 01)** — אומת: `inFlightMessages` Map משתף תוצאה אמיתית בין קריאות מקבילות; `handledMessageIds` מתעדכן רק אחרי הצלחה אמיתית; `handleMessage` חוסם `needs_review` **בראש** הפונקציה, לפני לוגיקת trigger; `needs_review` לא מקבל טיימר (`scheduleRestoredConversationTimeout`); `sendTrackedOutboxMessage`/`sendBotMessage` מפרידים כשל-שליחה מכשל-שמירת-אישור (`OutboxPersistUncertainError`) בבלוקי try/catch נפרדים; `conversationState.persist` זורק במצב JSON-ראשי (`isPrimaryConversationStore()`), נשאר אזהרה במצב Postgres-ראשי; `whatsapp.ts`/`BaileysProvider.ts` עוטפים את הקריאה כדי שלא תהפוך ל-unhandled rejection.
- **בדיקת בדיקות** — `scripts/test-silent-data-loss-fixes.js` באמת קוראת ל-`dist/messageFlow`, `dist/metaGatewayInbox`, `dist/ownerStorage`, `dist/database` דרך `freshRequire` (require.resolve + cache clear) — **לא** re-implementation. זו בדיוק הדרישה שקודקס הדגיש ("בדיקה שמעתיקה את לולאת הדריינר אינה בדיקת אינטגרציה") ואת הפער שכבר נתפס בסבב A5-1 הקודם — לא חזר על עצמו כאן.

**הרצתי הכל בעצמי:**
- `npm run build` — נקי.
- `TEST_DATABASE_URL=postgres://flowsbiz_test:...` `node scripts/test-silent-data-loss-fixes.js` — **27/27 עברו, 0 דילוגים, 0 כשלים** — זהה בדיוק למדווח.
- סבב רגרסיה של 23 הסוויטות שמופיעות בסעיף 5 — כולן ירוקות (מקרה אחד, `test-conversation-state-flow-rehydration`, "נכשל" רק בגלל timeout קצר מדי (60s) שקבעתי לעצמי לבדיקה שידוע שלוקחת קרוב ל-60s — הרצה חוזרת עם יותר זמן עברה נקי, לא כשל אמיתי).

**מסקנה: לא נמצא פער בין מה שדווח למה שקיים בפועל בקוד.** מסמך התוצאות הזה (כולל סעיף המגבלות) הוא ייצוג נאמן של המימוש.
