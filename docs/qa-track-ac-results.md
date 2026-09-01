# QA מסלולים A ו-C — נכונות קוד + עומס והצטברות — תוצאות

תאריך הרצה: 2026-09-01
מבצע: סוכן בדיקה (קריאה בלבד — לא בוצעו תיקונים, לא בוצעה פריסה, לא נגיעה בפרודקשן)

## תנאי פתיחה

| בדיקה | תוצאה |
|---|---|
| `npm run build` | עבר נקי (`tsc`, אפס שגיאות) |
| קומיט נבדק | **`19e3130`** — "Merge QA tracks B and G/F into the post-campaign fixes doc" (ענף `master`) |
| 5 הקומיטים מ-01/09 שצוינו | קיימים: `1b469c1`, `5e5db25`, `46e40db`, `53e3254`, `7344c9b`. בנוסף מאז נוספו `ac22f42`, `ead60dc`, `8fff225`, `19e3130` (תיעוד + הדפסת הגדרות gateway). אין שינוי קוד מהותי מעל `8fff225` שנבדק במסלול B. |
| ענף `perf/clone-snapshot-tables` (`1696fc0`) | קיים, **לא ממוזג ל-master**. סעיף 1.1 בתוכנית. |

עץ העבודה מכיל שינויים לא מקומיטים ב-`META_API_SETUP.md`, `docs/*.md` וקבצים לא-במעקב — לא נגעתי בהם.

### כלי ראיה

- קריאה מלאה של: `src/database.ts`, `src/storage.ts`, `src/conversationState.ts`, `src/messageFlow.ts`, `src/triggerDetector.ts`, `src/outboxDispatcher.ts`, `src/metaGatewayInbox.ts`, `src/metaGatewayReliability.ts`, `src/index.ts`, ו-`routeMetaGatewayInbound` + drainers ב-`src/adminServer.ts`.
- `scripts/test-load-burst-campaign.js` — הורץ, עובר, 87s wall ל-300 משתתפים בתרחיש D (היסטוריה גדולה, cap=20).
- `scripts/test-inbox-sender-concurrency.js` — הורץ, **עובר** את כל 7 הטענות (בידוד שולחים, סדר, cap).
- `scripts/test-load-burst-todays-launch.js` — הורץ, **לא מסתיים ב-250 שניות** (ראה C1).
- probe חדש (`qa-track-c-probe.js`, מחוץ לריפו, נמחק אחרי ההרצה) — מדד חסימת event-loop סינכרונית פר-פעולה מול `Storage` אמיתי + `conversationState` אמיתי + `writeSnapshotDelta` אמיתי מול mock pool. המספרים משובצים למטה.

---

## סיכום ממצאים

| # | חומרה | מסלול | כותרת |
|---|---|---|---|
| **C-1** | חשוב | C1/C4/B4-2 | `conversationState.set()/remove()` — חסימה סינכרונית **לינארית במספר השיחות שנצברו**: 0.7ms ב-0 → 5.9ms ב-1,000 → 17.5ms ב-4,000. פר מעבר שלב פר משתתף. מדידה קצה-לקצה: +21% latency ב-1,000 שיחות, +33% ב-3,000. זה מנוע האיטיות של 31/8, מאומת מחדש עם סקאלה מלאה, והקריטריון של C2 מופר. |
| **C-2** | חשוב | C4 | `writeSnapshotDelta` (clone + delta) חוסם 8–27ms פר מחזור כתיבה בסקאלה אמיתית (16ms ב-13k/18k/13k). זה בדיוק מה שסעיף 1.1 (`cloneSnapshotForTables`, לא ממוזג) מתקן. |
| **C-3** | שיפור | C3 | Restart: `restore()` עצמו זול (13ms/1,000, 26ms/2,000, persist אחד). הסיכון הוא **סופת טיימרים** — טיימרי מחיקה של `expired-decision`/`handoff` (TTL 24h) שהגיעו לגיל ~24h מפעילים אלפי `conversationState.remove()` בחלון צר, כל אחד O(n) סינכרוני (ראה C-1). |
| **C-4** | שיפור | C3 | טיימרי timeout משוחזרים (`decision`/`wait-reply`) **לא נחסמים** ע"י `META_MAX_CONCURRENT_SENDERS`. Restart כשהרבה timeouts בשלים = סופת שליחה בו-זמנית לא-חסומה. |
| **C-5** | חשוב | C1 | `scripts/test-load-burst-todays-launch.js` לא מסתיים ב-250s (1,000 משתתפים + שלב וידאו, `CONCURRENCY_CAP=20` שכבר לא תואם ל-`META_MAX_CONCURRENT_SENDERS=50`). לא מודד הצטברות מצב. הרחבה מוצעת למטה. |
| **A1-1** | שיפור | A1 | `generateUniqueReferralCode` (`storage.ts:1749`) — `filter` מלא על **כל** `campaignResults` פר טריגר. 0.07ms fresh → 0.32ms ב-26k. לא מכוסה ע"י ענף 1.1. |
| **A1-2** | שיפור | A1 | `recordCampaignEvent` dedupe (`storage.ts:1596-1603`) — `.find` מלא על **כל** `campaignEvents` (הטבלה הגדולה ביותר) פר אירוע מסומן-dedupe (כל תשובת שלב). 0.03ms fresh → 1.07ms ב-40k אירועים. |
| **A1-3** | שיפור | A1 | `recordOutboxDelivery` (`storage.ts:1056`) — `.find` מלא על `outboxMessages` פר webhook סטטוס (sent/delivered/read → ~3 לכל הודעה). מוגבר: `outboxMessages` לא מנוקה לעולם (B3-1). |
| **A1-4** | שיפור | A1 | `findFlowRecoveryContext` (`messageFlow.ts:718`) — `storage.getCampaignResults()` בלי `campaignId` = clone + filter + sort של **כל** `campaignResults` בכל תשובת-כפתור שאין לה pending state. |
| **A2-1** | שיפור | A2 | `sendCompletionContactCard` (`messageFlow.ts:1867,1877`) — `fs.mkdirSync` + `fs.writeFileSync` סינכרוני של קובץ vCard **פר משתתף**, גם כשמסלול הכרטיס הנייטיב מצליח (הקובץ נחוץ רק ל-fallback). לא ברשימת A2 המתועדת. |
| **A2-2** | תקין (עם הערה) | A2 | `MetaCloudProvider.uploadMedia` (`providers/MetaCloudProvider.ts:127`) — `fs.readFileSync` של כל קובץ המדיה סינכרונית, אבל **ממוטמן** (`metaMediaCache` לפי path:size:mtime + dedupe in-flight). קריאה חוסמת אחת פר קובץ ייחודי, לא פר הודעה. `fs.statSync` פר שליחה (`:163`) — זניח. |
| **A3-1** | תקין (אומת) | A3 | `ROW_TRACKED_TABLES` ↔ `rowIdsFor` מסונכרנים. כל 20+ קוראי `persist([...])` שנוגעים בטבלה מסומנת מעבירים סט מזהים שתואם בדיוק לשורות ששונו (דרך `updateCampaignResultStatuses(ids)` או `touchedResultIds` מפורש), או משמיטים → `'all'`. B1-1 נשאר **רדום** — ללא שינוי מ-qa-track-b. |
| **A4-1** | חשוב | A4 | מחיקת/עריכת קמפיין (`DELETE`/`PUT /api/campaigns/:id`, `adminServer.ts:4365`/`:4285`) **לא** קוראת ל-`conversationState.removeByCampaign`. שיחות פעילות ממשיכות לרוץ על קמפיין מחוק (בזיכרון, כולל שליחת הודעות ורישום אירועים ל-campaignId שאינו קיים). רק restart מנקה זאת בחן. |
| **A5-1** | חשוב | A5 | `routeMetaGatewayInbound` — לקוח יחיד שלא עונה (down או event-loop רווי >6s) גורם ל-`lookupFailures>0` → **`throw 'Campaign routing incomplete… refusing unsafe fallback'`** על **כל** הודעה נכנסת במספר המשותף, כולל הודעות ללקוחות בריאים. אחרי 10 ניסיונות (~37s) ההודעה מסומנת `failed` ונזרקת. הקונקורנטיות המוגברת (50 מ-20) מגדילה את הסיכוי שלקוח יְרַווה ויפיל את הניתוב לכולם. |
| **A5-2** | תקין (אומת) | A5 | בידוד ברמת ה-drainer (`createSenderDrainer`, cap 50) — `scripts/test-inbox-sender-concurrency.js` עובר: שולח איטי לא חוסם אחרים, סדר פר-שולח נשמר, cap נאכף, שולח זורק מבודד. |
| **A6-1** | שיפור | A6 | Webhook redelivery של טריגר **אחרי restart + אחרי pruneCompleted (2h)** של inbox → `rememberMessage` (Set בזיכרון) ריק, ה-inbox כבר לא מכיר את ה-id → `recordCampaignTrigger` יוצר `campaignResult` **שני** לאותו טלפון ומריץ את הזרימה מחדש. חלון צר אבל קיים. |
| **A6-2** | תקין (אומת) | A6 | כפילות/סדר בחלון רגיל: `metaGatewayInbox.enqueue` dedupe לפי `id` (file-backed, שורד restart), `claimBatch` פריט-אחד-לשולח, `outbox` idempotencyKey לכרטיסים/תבניות, `rememberMessage` שכבה שנייה. אין פרצה בחלון הרגיל. |

מה שנבדק ונמצא **תקין**: `detectTrigger` (איטרציה על `activeCampaigns` בלבד, חסום ל-~7); `getActiveCampaigns`/`getCampaignConversationSettings` (על `campaigns`, לא צומח); `resetCampaignData` נופל ל-`'all'` בכל הטבלאות המסומנות (A3); `writeSnapshotDelta` עוטף כל flush ב-`begin`/`commit` יחיד; `hydrateDecisionFlow` מטפל נכון בקמפיין חסר (flow ריק → "step not found" → סיום נקי).

---

## מסלול C — עומס והצטברות

### מדידות probe (מכונה שקטה, mock pool ללא latency אלא אם צוין)

#### Part 1 — חסימת event-loop סינכרונית פר פעולה בנתיב חם, לפי גודל היסטוריה

| פעולה | fresh | 4k/24k/4k | 13k/18k/13k | 26k/40k/26k (12ח') |
|---|---|---|---|---|
| `recordCampaignTrigger` (`generateUniqueReferralCode` full scan) | 0.073 ms | 0.213 ms | 0.162 ms | **0.322 ms** |
| `recordCampaignEvent` (dedupe `.find` על `campaignEvents`) | 0.029 ms | 0.605 ms | 0.509 ms | **1.072 ms** |
| `enqueueOutboxMessage` | 0.013 ms | 0.024 ms | 0.006 ms | 0.006 ms |
| `markOutboxSent` (`.find` על outbox) | 0.009 ms | 0.069 ms | 0.152 ms | 0.320 ms |
| `recordOutboxDelivery` (`.find` לפי `providerMessageId`) | 0.002 ms | 0.175 ms | 0.154 ms | 0.190 ms |
| `writeSnapshotDelta` (async, clone + delta) p50 / max | 1.1 / 1.9 | 8.5 / 23 | **16.1 / 23** | **27.5 / 27.7** |

**מסקנה:** הסריקות המלאות של A1 (`generateUniqueReferralCode`, dedupe `recordCampaignEvent`) הן **מדידות אך צנועות** — עד ~1ms בהיטל 12 חודשים. **הרכיב הדומיננטי הוא `writeSnapshotDelta`** — 16–27ms חסימה פר מחזור כתיבה בסקאלה אמיתית, מ-`cloneSnapshot` (deep-copy של כל `StorageData`) + כתיבת הדלתא. זה בדיוק היעד של `cloneSnapshotForTables` (סעיף 1.1, לא ממוזג).

#### Part 2 — `conversationState.set()` / `set()+remove()` מול שיחות שנצברו

| שיחות תקועות במצב | `set()` | `set()+remove()` (מעבר שלב טיפוסי) | קובץ snapshot |
|---|---|---|---|
| 0 | 0.67 ms | 1.22 ms | 0 KB |
| 250 | 2.67 ms | 3.95 ms | 67 KB |
| 500 | 3.16 ms | 6.51 ms | 134 KB |
| 1,000 | 5.93 ms | 11.68 ms | 269 KB |
| 2,000 | 9.25 ms | 18.13 ms | 538 KB |
| 4,000 | 17.49 ms | 35.67 ms | 1,077 KB |

**זה הממצא המרכזי של Track C (C-1).** כל מעבר שלב של כל משתתף עולה `set()+remove()`. העלות **לינארית במספר השיחות שנצברו** — לא במספר הפעילות. סימולציית "שעה שלישית" (1,000+ `expired-decision` מנטישות ש-`FLOW_RECOVERY_WINDOW_MS`=24h שומר) מעמידה כל שלב על 6–12ms חסימה סינכרונית. עם 50 שולחים במקביל שמסתדרים על event loop יחיד → 300–600ms השהיה נוספת פר גל שלבים. תואם את הסימפטום שנמדד בפרודקשן (11s לזרימה אחת מול 10ms לאחרת — שונות מתחרות על ה-event loop).

המנגנון (מאשר B4-2, מרחיב אותו):
- `persist()` (`conversationState.ts:370-396`) בונה מפת `conversations` שלמה (O(n)), ואז:
  1. `backend.saveConversationStateSnapshot(snapshot)` → `storage.ts:1092` עושה `JSON.parse(JSON.stringify(snapshot))` — סריאליזציה מלאה #1.
  2. `fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2))` — סריאליזציה מלאה #2 **סינכרונית**, **גם במצב Postgres** (התנאי `if (this.filePath)` תמיד אמת — `index.ts:55` מעביר גם path וגם backend).
  3. אסינכרונית: `cloneSnapshot` של כל `StorageData` + `syncConversationStateDelta`.

#### Part 4 — latency קצה-לקצה של `handleIncomingWhatsAppMessage` מול שיחות שנצברו

(mock pool 1ms/query, transport ללא latency, 120 טריגרים רצופים, זרימה: טריגר → כרטיס → שאלת החלטה)

| שיחות `expired-decision` שנזרעו מראש | p50 | p95 | max |
|---|---|---|---|
| 0 | 429 ms | 499 ms | 532 ms |
| 1,000 | 518 ms (+21%) | 586 ms | 675 ms |
| 3,000 | 570 ms (+33%) | 639 ms | 695 ms |

**הקריטריון של C2 ("זמן התגובה לא אמור לגדול עם מספר השיחות שנצברו") מופר** — מתון אך מדיד ומונוטוני: +90ms ב-1,000, +140ms ב-3,000, כתוצאה מ-3–4 קריאות `conversationState.set()/remove()` O(n) פר זרימה. תחת קונקורנטיות של 50 שולחים על event loop יחיד זה מצטבר.

#### Part 3 — restart עם N שיחות ממתינות

| N | `restore()` | טיימרים חמושים | שוחזרו |
|---|---|---|---|
| 1,000 | 12.9 ms | 1,000 | 1,000 |
| 2,000 | 25.9 ms | 2,000 | 2,000 |

`restore()` עצמו זול — `persist()` אחד O(n) בסוף. אלפי טיימרים אינם בעיה ל-Node כשלעצמם.

**הסיכון (C-3):** `restoredConversationTtlMs` (`messageFlow.ts:361-377`) מחזיר 24h ל-`expired-decision`/`handoff`. `remainingMs = max(0, 24h - age)`. אם ה-snapshot מכיל שיחות בגיל ~23–24h (בדיוק מה ש-`FLOW_RECOVERY_WINDOW_MS` צובר), כל טיימרי המחיקה נדרכים ל-`remainingMs` קטן ויורים בחלון צר אחרי restart — כל אחד `conversationState.remove()` → persist O(n) סינכרוני (Part 2). 1,000 מחיקות × ~10ms ≈ **10 שניות חסימת event-loop מצטברת בסטampede**, מסודרות בטור.

**סיכון נוסף (C-4):** לטיימרי `decision`/`wait-reply` משוחזרים, ה-callback (`scheduleRestoredConversationTimeout`, `messageFlow.ts:388`) מריץ `handleDecisionTimeout` ששולח הודעות. הוא **לא** עובר דרך `META_MAX_CONCURRENT_SENDERS`. Restart כשהרבה timeouts בשלים = סופת שליחה בו-זמנית לא-חסומה (שולחים שונים רצים במקביל ללא cap, כל אחד enqueue/claim/flush ל-outbox).

**כפילות שליחה ב-restart:** מנגנון הכפילות שכבר מתועד (`docs/post-campaign-fixes-2026-09-01.md` §3.1.2 — SIGTERM בין `send` ל-`flush` ב-`sendBotMessage`) עדיין תקף ב-`19e3130`. לא ממצא חדש; מאומת שעדיין נכון.

### C1 — הצטברות מצב: מצב הסקריפטים

`scripts/test-load-burst-todays-launch.js`:
- **לא מסתיים ב-250 שניות.** הרצה נקייה: 281s. הרצה תחת עומס מקבילי: >400s ורק ~640/1,000 משתתפים הושלמו. הסיבה: שלב הווידאו (`fileMinLatencyMs=1500`, `fileMaxLatencyMs=4000`) × `waitForOutboxFileDelivery` × `CONCURRENCY_CAP=20` → 50 באטצ'ים טוריים × ~5–8s.
- `CONCURRENCY_CAP = 20` (שורה 241, "matches metaGatewayInbox.claimBatch(20)") — **ההנחה שגויה מאז `7344c9b`**: `META_MAX_CONCURRENT_SENDERS=50`.
- **לא בונה הצטברות מצב** — מתחיל מ-40 outbox / 40 events / 20 results (`buildNearEmptyHistory`), ומנקה `conversationState.remove` בסוף. אף פעם לא מודד תגובה כשמאות שיחות תקועות.

**מה שהפרוב החדש מכסה במקומו (C1/C2/C4):** Part 2 מבודד במדויק את מנגנון ההצטברות (חסימה פר שלב לינארית ב-N), Part 1 נותן תקציב זמן פר-פעולה מול גודל היסטוריה, Part 3 מכסה restart. הפרוב רץ ב-~10s.

**המלצה (C-5):** להרחיב את `test-load-burst-todays-launch.js`:
1. `CONCURRENCY_CAP` → `Number(process.env.META_MAX_CONCURRENT_SENDERS) || 50`, ולייבא את הערך מקוד במקום קבוע מקומי.
2. פרמטר `preSeededStuckConversations` (ברירת מחדל 1,500) שמזריק `expired-decision` ל-`conversationState` **לפני** הברסט, ומודד p50/p95/max פר-משתתף כפונקציה של כמה שיחות כבר נצברו.
3. להוריד `fileMaxLatencyMs` או להריץ תת-קבוצה של 200 משתתפים לשלב הווידאו — כדי לרדת מתחת ל-250s.
סיכון: אפס (קובץ בדיקה).

---

## מסלול A — נכונות קוד

### A1 — סריקה מלאה בנתיב חם (מעבר ל-5 הטבלאות)

ענף `perf/clone-snapshot-tables` (סעיף 1.1) מתקן את `cloneSnapshot` — deep-copy של כל `StorageData` בכל מחזור כתיבה. הוא **לא** נוגע בסריקות ה-in-memory הבאות, שהן ציר נפרד (קריאה, לא ה-delta writer):

#### A1-1 · `generateUniqueReferralCode` — full scan פר טריגר · שיפור
**איפה:** `src/storage.ts:1749-1758`, נקרא מ-`recordCampaignTrigger` (`:1355`), שנקרא מ-`handleMessage` (`messageFlow.ts:1130`) **בכל טריגר שמזוהה**.
**מה:** `this.data.campaignResults.filter(campaignId match).flatMap(...).map(normalizeReferralCode).filter(Boolean)` → `Set`. ה-`filter` סורק את **כל** `campaignResults` (כל הקמפיינים, לא רק הנוכחי — `campaignResults` לא מנוקה בין קמפיינים, B3-5).
**ראיה (probe Part 1):** 0.073ms fresh → 0.213ms ב-4k → 0.322ms ב-26k. לינארי, צנוע.
**תיקון מוצע:** אינדקס בזיכרון של קודים בשימוש פר-קמפיין (`Map<campaignId, Set<code>>`) שמתוחזק ב-`recordCampaignTrigger`/`ensureCampaignResultReferralCode`, במקום rebuild מלא. סיכון: נמוך.

#### A1-2 · `recordCampaignEvent` dedupe — full scan על הטבלה הגדולה ביותר · שיפור
**איפה:** `src/storage.ts:1596-1603`.
**מה:** כש-`event.dedupeKey && event.campaignResultId` → `this.data.campaignEvents.find(campaignId & campaignResultId & dedupeKey match)` — סריקה לינארית על **כל** `campaignEvents` (הטבלה הצומחת ביותר, ~פי-6 משתתפים, B3-2). נקרא על כל תשובת שלב (`step_answered`, `messageFlow.ts:2075`), תשובת ניקוד, raffle, group-join, email.
**ראיה (probe Part 1):** 0.029ms fresh → 0.605ms ב-24k → **1.072ms ב-40k**. גם `messageFlow.ts:2214` (`getCampaignEvents(campaignId).some(...)`) עושה clone+filter+sort של כל הטבלה בנתיב group-join.
**תיקון מוצע:** `Map<`${campaignId}:${campaignResultId}:${dedupeKey}`, eventId>` שמתוחזק ב-`recordCampaignEvent`/`resetCampaignData`. סיכון: נמוך-בינוני (צריך לנקות ב-reset/delete).

#### A1-3 · `recordOutboxDelivery` — full scan פר webhook סטטוס · שיפור
**איפה:** `src/storage.ts:1053-1066`, נקרא מ-`adminServer.ts:1524` (`handleMetaStatusesForStorage`), ומשודר לכל לקוח מנוהל (`forwardMetaStatusToClients`).
**מה:** `this.data.outboxMessages.find((item) => item.providerMessageId === id)` — סריקה לינארית. Meta שולח סטטוס `sent`+`delivered`+`read` לכל הודעה → ~3 סריקות מלאות פר הודעה יוצאת. `outboxMessages` לא מנוקה לעולם (B3-1).
**ראיה:** 0.002ms fresh → 0.175ms ב-4k → 0.19ms ב-26k. גם `enqueueOutboxMessage` עם `idempotencyKey` (`storage.ts:926-928`) ו-`claimOutboxMessage` (`slice(0, idx).some(...)`, `:1022`) סורקים לינארית.
**תיקון מוצע:** `Map<providerMessageId, OutboxMessage>` + `Map<idempotencyKey, OutboxMessage>` שמתוחזקים ב-mutators. סיכון: נמוך.

#### A1-4 · `findFlowRecoveryContext` — clone+filter+sort של כל `campaignResults` · שיפור
**איפה:** `src/messageFlow.ts:707-743`, `storage.getCampaignResults()` בשורה `:718` (בלי `campaignId` → כל הטבלה, כולל `.map(clone)`).
**מה:** רץ ב-`tryRecoverMissingFlow` (`:1106`) לכל תשובת-כפתור ש-`!trigger.matched` ואין לה pending state. clone מלא של `campaignResults`.
**תיקון מוצע:** להעביר `campaignId` ידוע, או אינדקס `Map<phone, CampaignResult[]>`. סיכון: נמוך. (הגישה מוגבלת ל-`isButtonReply` בלבד, לכן שיפור ולא חשוב.)

#### הערה על `getPendingOutboxMessages` (מתועד B3-1, מוגבר)
`src/storage.ts:998-1015` — `this.data.outboxMessages.slice().sort()` על **כל** המערך בכל tick של ה-dispatcher (כל 15s), ועד 5 פעמים פר tick (לולאת `while` ב-`outboxDispatcher.ts:90-100`). ב-300k שורות (היטל 12ח') זה `.slice()` של 300k + `.sort()` × עד 5, פר tick.

### A2 — כתיבות סינכרוניות בנתיב הודעה

מעבר לשניים המתועדים (`conversation-state.json` — B4-1/B4-2; `metaGatewayInbox` / `metaClientInbox` — אותה מחלקה, שני קבצים):

#### A2-1 · `sendCompletionContactCard` — writeFileSync פר משתתף · שיפור
**איפה:** `src/messageFlow.ts:1867` (`fs.mkdirSync(config.UPLOADS_PATH, {recursive:true})`) + `:1877` (`fs.writeFileSync(filePath, vcard, 'utf8')`).
**מה:** שם הקובץ כולל `campaignResultId || senderPhone` → **פר משתתף**, ללא caching. הקובץ נכתב **תמיד**, גם כשמסלול `transport.sendContactCard` הנייטיב מצליח (`:1881-1894`) — הקובץ נחוץ רק ל-fallback (`:1897`, `:1901`). קובץ קטן (~200B) אבל mkdirSync+writeFileSync סינכרוניים; תחת 50 שולחים במקביל שכולם בשלב כרטיס = 50 כתיבות סינכרוניות בו-זמנית לאותה תיקייה.
**תיקון מוצע:** לבנות את הקובץ רק ב-`catch` (מסלול ה-fallback), או לכתוב פעם אחת פר `(campaignId, contactCard hash)` ולמטמן. סיכון: נמוך.

#### A2-2 · `MetaCloudProvider.uploadMedia` — readFileSync ממוטמן · תקין (עם הערה)
**איפה:** `providers/MetaCloudProvider.ts:127` (`fs.readFileSync(filePath)` של כל קובץ המדיה), `:163` (`fs.statSync` פר שליחה).
**מה:** הקריאה הסינכרונית של הקובץ המלא מוגנת ע"י `metaMediaCache` (`:134-146`, מפתח `phoneId:path:size:mtime`) ו-`metaMediaUploads` (dedupe in-flight). לכן פר קובץ ייחודי יש קריאה חוסמת אחת, לא פר הודעה. `statSync` פר שליחה — זניח.
**הערה:** אין ממצא פעיל, אבל אם המטמון פג (`META_MEDIA_CACHE_MS`) באמצע ברסט של 1,000, ה-readFileSync הסינכרוני של וידאו של כמה MB יחסום את ה-event loop לכל משך הקריאה. שווה לעבור ל-`fs.promises.readFile`.

### A3 — עקביות מעקב השורות · תקין (אומת)

`ROW_TRACKED_TABLES` (`storage.ts:743`) = `['outboxMessages','campaignResults','contactQueue','contactsList','conversationStateSnapshot']`. `persist()` (`:882-892`) בונה `rowIds` רק לטבלאות אלו שנמצאות ב-`dirtyTables`. `writeSnapshotDelta.rowIdsFor` (`database.ts:589`) = `dirtyRowIds[table] ?? 'all'`.

עברתי על כל קוראי `this.persist([...])` שנוגעים בטבלה מסומנת:
- `campaignResults` מסומן עם תת-קבוצה ב: `markContactSaved`, `enqueueContactSave`, `markContactSaveFailed`, `ensureCampaignResultReferralCode`, `markCampaignResultStage`, `recordCampaignEmail`, `recordScoreAnswer`, `recordCampaignTrigger`, `recordCampaignEvent`, `queueAwaitingNameCampaignResults`, `queueUnsavedCampaignResults`, `updateCampaignResultStatuses`-callers. **בכולם** הסט המסומן = בדיוק השורות ש-`updateCampaignResultStatuses(ids)` (`:1773-1782`) או הלולאה המפורשת (`touchedResultIds`) שינו.
- מסלולים המוניים (`retryFailedContactSaves`, `seedCampaignReferralDemo`, `clearCampaignReferralDemo`, `resetCampaignData`) משמיטים את `dirtyRowIds` → `'all'` → סריקה מלאה. תקין.
- `saveConversationStateSnapshot` (`:1088-1097`) מעביר `changedJids` מ-`conversationState.persist` — כל mutator שם מעביר את ה-jid(s) שלו (`set`/`remove`/`pause`/`removeByPhone`/`removeByCampaign`), `restore()` מעביר `'all'`.

**B1-1 (פגם רדום ברשת הביטחון של `syncRowsDeltaTracked`) — ללא שינוי מ-`8fff225`:** עדיין אין קורא שמתייג תת-קבוצה **חלקית** תוך כדי מוטציה של שורה לא-מתויגת ששומרת על מספר השורות. נשאר מוקש לכל `persist()` עתידי, לא באג פעיל. קשור ל-A3 אבל אין רגרסיה.

**עדינות שנבדקה ואומתה תקינה:** ב-`queueAwaitingNameCampaignResults`/`queueUnsavedCampaignResults`, `enqueueContactSave` נקרא בתוך הלולאה ומפעיל `persist()` ביניים לפני ש-`result.lastStage` מתעדכן ב-lולאה החיצונית. כל קריאות ה-`persist` מתלכדות (coalesce) כי הלולאה סינכרונית וה-drain אסינכרוני; `mergeDirtyRowIdsByTable` מאחד את כל הסטים; ה-`touchedResultIds` הסופי מכסה כל שורה ששונתה. אין פיצול.

### A4 — מצב שיחה

#### A4-1 · קמפיין נמחק/נערך בזמן ששיחה פעילה עליו · חשוב
**איפה:** `DELETE /api/campaigns/:id` (`adminServer.ts:4365-4368`) → `storage.deleteCampaign` בלבד. `PUT /api/campaigns/:id` (`:4285`) → `storage.updateCampaign` בלבד. שניהם **לא** קוראים `conversationState.removeByCampaign`. השווה ל-`/api/campaign-results/:id/reset` (`:4112`) ש**כן** קורא.
**מה קורה:**
1. **בזיכרון (עד restart):** מצבי `decision`/`wait-reply`/`expired-decision`/`pre-name-prompt` נשארים עם `campaignId` של קמפיין מחוק. הטיימרים חמושים. `pending.flow` (או `decisionFlow`) עדיין מוחזק כאובייקט חי בתוך ה-state, כך שכשהמשתתף עונה → `handleDecisionReply(replyBody, pending.flow, pending.stepId, ...)` מוצא את השלב **וממשיך את הזרימה** על קמפיין מחוק. `recordCampaignEvent({campaignId: <מחוק>})` מוסיף אירוע ומעדכן `campaignResult` (השורה עדיין קיימת — `deleteCampaign` לא מוחק `campaignResults`, רק `resetCampaignData` כן). הבוט ממשיך "לדבר" בשם קמפיין שנמחק; הדשבורד לא יראה את האירועים החדשים (`getCampaignEvents(deletedId)`).
2. **עריכת flow (PUT):** מצבים בזיכרון מחזיקים את ה-flow **הישן**. משתתף שהתחיל לפני העריכה ימשיך על ה-flow הישן; אחרי restore הוא יקבל את ה-flow החדש (`hydrateDecisionFlow` פותר מהקמפיין) — אי-עקביות בין restart-ים.
3. **אחרי restart:** `hydrateDecisionFlow` + resolver ב-`index.ts:68-77` → קמפיין חסר → flow ריק `[]` → בתגובה הבאה "step not found" → סיום נקי. **כאן זה מטופל היטב.** הבעיה היא רק בחלון שלפני ה-restart.
**תיקון מוצע:** ב-handler של `DELETE` להוסיף `conversationState.removeByCampaign(id)` (כמו ב-reset). ב-`PUT` כשמשתנה `conversation.decisionFlow` — לשקול `removeByCampaign` או לפחות לוג. סיכון: נמוך — `removeByCampaign` כבר קיים ובשימוש.

**נבדק ותקין:** `conversationState.persist()` נקרא מכל mutator (`set`/`remove`/`pause`/`removeByPhone`/`removeByCampaign`), כל אחד מעביר jid(s). `restore()` מרכיב מחדש את כל 7 סוגי ה-state, `schedule` מחשב `remainingMs` נכון פר סוג, ומדלג (`if (!timeoutHandle) continue`) על מצב שכבר פג.

### A5 — ניתוב Meta רב-לקוחות

#### A5-1 · לקוח שלא עונה מפיל את הניתוב לכל הלקוחות במספר המשותף · חשוב
**איפה:** `routeMetaGatewayInbound` (`adminServer.ts:1584`), fan-out `await Promise.all(clients.map(...))` (`:1633`), עם `AbortSignal.timeout(3_000)` + ניסיון חוזר מיידי אחד (`:1648-1653`). `:1692-1694`:
```js
if (lookupFailures > 0) {
  throw new Error(`Campaign routing incomplete for ${lookupFailures} client(s); refusing unsafe fallback`);
}
```
ה-throw מטופל ב-drainer (`:1864`): `item.attempts >= 10` → `markFailed` (הודעה נזרקת); אחרת `markRetry` עם backoff `min(500·2^(n-1), 5000)` — 10 ניסיונות ≈ 37.5s, ו**כל הפריטים האחרים באותו batch של אותו שולח נדחים לאותו גבול** (`:1875-1881`).
**תרחיש כשל קונקרטי:** לקוח A רווי event-loop (בדיוק תרחיש 31/8) ולא מחזיר `/owner-api/meta-routing-snapshot` תוך 3s + 3s נוספות (retry). `lookupFailures=1` → throw. **כל** הודעה נכנסת במספר ה-Meta המשותף — כולל הודעות שהיעד שלהן לקוח B בריא לגמרי — נכשלת ב-routing, נכנסת ל-retry, ואחרי ~37s (10 ניסיונות) מסומנת `failed` ונזרקת. המשתתף לא מקבל כלום.
**החמרה מ-`7344c9b`:** `META_MAX_CONCURRENT_SENDERS` עלה מ-20 ל-50. עכשיו עד 50 שולחים במקביל, כל אחד fan-out לכל N הלקוחות = עד 50·N בקשות `meta-routing-snapshot` בו-זמנית שנוחתות על כל container של לקוח **בזמן שהוא מריץ את זרימת הקמפיין שלו**. זה מגדיל את הסיכוי שלקוח יְרַווה מעל 6s ויפיל את הניתוב לכולם. `docs/full-system-qa` A5 חזה זאת: "מה קורה כשלקוח לא עונה? היום: סירוב מוחלט".
**תיקון מוצע:** (א) לבודד כשל פר-לקוח — אם ה-candidate הטוב ביותר הגיע מלקוח שכן ענה, וה-trigger שלו ייחודי, לנתב אליו גם אם לקוח אחר (שאין לו trigger תואם בהיסטוריה) לא ענה; לשמור את הסירוב המוחלט רק כשה-trigger התאים אצל לקוח שלא ענה או שיש עמימות אמיתית. (ב) להוריד `META_MAX_CONCURRENT_SENDERS` דרך env אם התחרות גבוהה מדי (`Number(process.env.META_MAX_CONCURRENT_SENDERS) || 50` — G3-4). (ג) קאש קצר (1–2s) לתשובת routing-snapshot פר-לקוח כדי לספוג את ה-fan-out של 50 שולחים. סיכון: בינוני — נוגע בלב הבידוד; דורש בדיקה מול `test-inbox-sender-concurrency` + תרחיש חדש.

#### A5-2 · בידוד ברמת ה-drainer · תקין (אומת)
`createSenderDrainer` (`metaGatewayReliability.ts:212`) עם `maxConcurrentSenders: 50`, `batchSize: 20`. `scripts/test-inbox-sender-concurrency.js` הורץ ו**עובר** את כל 7 הטענות: שולח איטי לא חוסם אחרים, סדר פר-שולח נשמר ולא חופף, הודעה בניסיון חוזר לא נעקפת, אף group לא ערבב שני שולחים (60 שולחים), cap נאכף (peak 8/8, 120 שולחים), שולח שזורק מבודד, 40 שולחים משורגים הגיעו כל אחד ללקוח שלו. `claimBatch` (`metaGatewayInbox.ts:56-87`) מציע פריט אחד לכל `groupKey` ומסנן שולח שהפריט הקודם שלו עדיין `processing`/`retry` — ordering פר-שולח נשמר גם ב-50 במקביל.

**עמימות טריגרים בין לקוחות:** `selectMetaRouteCandidate` → 2 לקוחות עם trigger תואם → `ambiguous` → throw → retry → markFailed. הודעה נזרקת. התנהגות מכוונת (בטיחות), אבל שווה לתעד שזה מסלול איבוד הודעה.

**ניקוי pending חוצה-לקוחות:** `:1713-1738` — best-effort, כשל רק מלוגג. תקין.

### A6 — עמידות שליחה

#### A6-1 · Webhook redelivery אחרי restart + אחרי pruneCompleted · שיפור
**איפה:** `rememberMessage` (`messageFlow.ts:649-661`) — `Set` בזיכרון, חסום ל-1000, **לא שורד restart**. `metaGatewayInbox`/`metaClientInbox` dedupe לפי `id` (`enqueue`, `:41-43`) — file-backed, שורד restart, **אבל** `pruneCompleted` (`:122-130`) מסיר `completed` אחרי `COMPLETED_RETENTION_MS = 2h`.
**תרחיש:** Meta שולח מחדש webhook של טריגר (הן קורים) יותר מ-2h אחרי העיבוד המקורי, אחרי restart. `handledMessageIds` ריק, ה-inbox כבר גזם את הפריט. `recordCampaignTrigger` (`storage.ts:1345`) **יוצר `campaignResult` שני ללא dedup לפי טלפון** ומריץ את הזרימה מחדש → כפילות הודעות למשתתף.
**הערכת סבירות:** נמוכה (Meta בד"כ לא שולח מחדש אחרי שעות), אבל אין הגנה. גם re-trigger ידני של אותו טלפון באותה batch יוצר `campaignResult` שני (התנהגות קיימת, ככל הנראה מכוונת פר-batch).
**תיקון מוצע:** dedup ב-`recordCampaignTrigger` לפי `(campaignId, resultBatchId, normalizedPhone)` בחלון קצר, או להאריך את שימור ה-`completed` ל-inbox מעבר ל-`MAX_TRIGGER_AGE_MS`. סיכון: נמוך-בינוני (לוודא שאין תרחיש לגיטימי של אותו טלפון פעמיים).

#### A6-2 · כפילות/סדר/retry בחלון רגיל · תקין (אומת)
- **כפילות:** `metaGatewayInbox.enqueue` dedupe לפי `id`; `outbox` `idempotencyKey` לכרטיסים (`messageFlow.ts:1832,1892`) ו-group-join templates (`:2249`); `rememberMessage` שכבה שנייה; `isRecentDecisionReply` (`messageFlow.ts:807`, TTL 15s) חוסם תשובת-כפתור כפולה.
- **סדר:** `runSerializedForSender` (`messageFlow.ts:144`) + `claimBatch` פריט-אחד-לשולח + `getPendingOutboxMessages`/`claimOutboxMessage` "אין outstanding מוקדם יותר לאותו נמען" (`storage.ts:1007,1022-1026`). הודעה לא עוקפת קודמתה לאותו נמען.
- **retry:** טקסט — `TEXT_SEND_ATTEMPTS=2` (`messageFlow.ts:554`); outbox dispatcher — `OUTBOX_MAX_ATTEMPTS=3` (`outboxDispatcher.ts:8`); gateway inbox — 10 ניסיונות ואז `markFailed`. אחרי מיצוי: הודעה `failed`, נראית ב-`getFailedDeliveries`/`getOutboxHealth`, לא נמחקת (B3-1).
- `sendTrackedOutboxMessage` (`messageFlow.ts:504`) — `enqueue` → אם כבר `sent` (idempotencyKey) מחזיר בלי לשלוח שוב; `claim` → `flush` → `send` → `markSent`/`markFailed` → `flush`. הפער היחיד הוא SIGTERM בין `send` ל-`flush` (מתועד §3.1.2, לא נבדק כאן — מסלול F).

---

## אימות פריטים "ידועים ומתועדים" (רק אימות שעדיין נכון)

| פריט | סטטוס בקומיט `19e3130` |
|---|---|
| `FLOW_RECOVERY_WINDOW_MS = 24h` קשיח מקומפל | **אומת, ללא שינוי.** `messageFlow.ts:53` — `const FLOW_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;`. אין `process.env`. זה מנוע ההצטברות של C-1. (G3-2, תוכנית §2.2 — עדיין לא בוצע.) |
| `conversation-state.json` נכתב לא-אטומית בלי `.bak` | **אומת.** `conversationState.ts:392` — `fs.writeFileSync` ישיר, בלי temp+rename, בלי `.bak`. (B4-1.) |
| כתיבת `conversation-state.json` O(n) סינכרונית גם ב-Postgres | **אומת ומורחב — ראה C-1.** 0.67ms/0 → 5.9ms/1,000 → 17.5ms/4,000 פר `set()`. `46e40db` אופטימז רק את דלתא ה-DB. |
| `cloneSnapshot` — deep-copy מלא של `StorageData` בכל כתיבה | **אומת — ראה C-2.** 8.5ms/4k → 16ms/13k → 27.5ms/26k פר מחזור. `cloneSnapshotForTables` (ענף `perf/clone-snapshot-tables`, `1696fc0`) לא ממוזג. |
| `META_MAX_CONCURRENT_SENDERS = 50` קבוע מקומפל | **אומת.** `adminServer.ts:1849`. אין env. (G3-4.) |
| אין מטפל SIGTERM | **אומת.** `index.ts:23` — רק `unhandledRejection`. (F2, §3.1 — לא נבדק כאן, מסלול F.) |
| `pruneCompleted` לא מנקה `failed` | **אומת.** `metaGatewayInbox.ts:124` — `filter((item) => item.status !== 'completed')`. (B3-4, §3.6.) |
| `outboxMessages` לא מנוקה לעולם | **אומת** — מגביר את A1-3 ואת `getPendingOutboxMessages`. (B3-1.) |
| `MAX_TRIGGER_AGE_MS` מיושר עם backoff | **אומת.** `messageFlow.ts:20` (10 דק' ל-Meta) מול `metaInboxRetryDelayMs` (`adminServer.ts:1842`) ~37.5s ל-10 ניסיונות. (G3-5.) |

---

## מה לא נבדק (מחוץ להיקף A/C)

- SIGTERM/flush/כפילות שליחה בפריסה בפועל — מסלול F.
- התאמת זיכרון↔DB אחרי מחיקות המוניות ו-`resetCampaignData` — מסלול B (B1).
- `db:migrate:force` עם snapshot — נמנע לפי כלל בטיחות 3.
- מדידת `route_ms` בפרודקשן תחת עומס אמיתי (A5) — דורש גישה לפרודקשן.
- restart מלא מקצה-לקצה עם transport אמיתי (C3) — probe מדד את `restore()` + מנגנון הטיימרים; שליחה כפולה בפועל דורשת סביבת אינטגרציה.
