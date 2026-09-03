# תוצאות מימוש — תיקון קנה-מידה של שחזור החלטות + אמינות "פרוס מחדש את כולם"

מימוש של `docs/decision-recovery-scale-fix-plan-2026-09-03.md`. ענף: `decision-recovery-scale-fix` (מקומי בלבד — לא נדחף ולא מוזג).

תאריך: 2026-09-03.

---

## 1. מה בוצע — פירוט לפי קובץ

### חלק A — `src/messageFlow.ts` (A.1)

`rememberTimedOutDecision()` (שורות ~218‑240): הוחלף הסריקה המלאה של `timedOutDecisions` בכל קריאה
בחיתוך מההתחלה (`amortized O(1)`).

- הרשומות מקבלות TTL קבוע (`FLOW_RECOVERY_WINDOW_MS`) מרגע ההוספה, ולכן **סדר ההוספה = סדר התפוגה**.
  לולאת ה-`while` מוחקת מראש ה-`Map` כל עוד הרשומה הראשונה פגה, ועוצרת ברגע שהראשונה עדיין בתוקף.
- **`delete` לפני `set`** על מפתח קיים: כשאותו שולח מקבל timeout שני, המחיקה-לפני-הוספה מזיזה את
  הרשומה המעודכנת לסוף סדר ההוספה. בלי זה `Map.set` היה משאיר אותה במקומה הישן, וה-trim (או תקרת
  ה-`size > 5000`) היה יכול למחוק רשומה מרועננת עדיין-בתוקף לפי המיקום הישן שלה.
- תקרת ה-`size > 5000` נשמרה כפי שהייתה.

נוסף `export const __recoveryScaleTestHooks` — נקודות גישה לבדיקה בלבד (`rememberTimedOutDecision`,
`timedOutDecisionsSize`, `timedOutDecisionKeysInOrder`, `hasTimedOutDecision`, `peekTimedOutDecision`,
`clearAllTimedOutDecisions`). לא בשימוש קוד ה-production.

### חלק A — `src/conversationState.ts` (A.2)

נוסף אינדקס `private readonly phoneIndex = new Map<string, Set<string>>()` — `normalizedPhone → jids`
לפי סדר הוספה.

- **`findByPhone()`**: במקום `for (const state of this.map.values())` — עכשיו `phoneIndex.get(normalized)`
  ואז `jids.values().next().value`. `Set` שומר סדר הוספה כמו `Map`, כך שהאיבר הראשון ב-`Set` שקול
  בדיוק ל"ראשון שנמצא בסריקה המלאה" — כולל המקרה של שני jid שחולקים טלפון מנורמל (מחזירים את
  הראשון, לא האחרון).
- שני helpers פרטיים חדשים: `reindexPhone(jid, phone)` (מוריד רישום ישן של אותו jid לפי הטלפון
  הקודם שלו, ואז מוסיף לטלפון הנוכחי) ו-`unindexPhone(jid, phone)` (מסיר; מוחק `Set` ריק כדי לא
  לדלוף).
- כל שש נקודות הכתיבה ל-`this.map` מסונכרנות:
  | מתודה | שינוי |
  | --- | --- |
  | `set()` | `reindexPhone(jid, state.senderPhone)` לפני `this.map.set` |
  | `pause()` | `reindexPhone(jid, state.senderPhone)` (senderPhone לא משתנה היום — הגנה עתידית) |
  | `remove()` | קורא `this.map.get(jid)` לפני המחיקה, `unindexPhone` על ה-senderPhone שלו |
  | `removeByPhone()` | `unindexPhone(jid, state.senderPhone)` בתוך הלולאה, לכל jid שנמחק |
  | `removeByCampaign()` | `unindexPhone(jid, state.senderPhone)` בתוך הלולאה, לכל jid שנמחק |
  | `restore()` | `reindexPhone(jid, hydrated.senderPhone)` בתוך הלולאה, לפני `this.map.set` — כי `restore()` כותב ישירות ל-`this.map` ולא דרך `set()`. בלי זה האינדקס היה ריק אחרי כל restart עד שהודעה חדשה נוגעת בכל שיחה. |

נוספו `__debugEntriesForTest()` ו-`__debugPhoneIndexForTest()` — אינטרוספקציה לבדיקה בלבד (רשימת
שיחות בסדר הוספה חי, ותוכן האינדקס לבדיקת דליפות). לא בשימוש קוד ה-production.

### חלק B — `src/dokployProvisioner.ts` (B.0 / B.1 / B.2)

טיפוסים חדשים: `DokployDeployment` (שורת `deployment.all`), `RedeployExistingClientResult`
(`ok` / `skipped` / `error` / `retried`), `RedeployExistingClientOptions` (`timeoutMs` /
`pollIntervalMs` / `retryDelayMs` / `sleepFn` — `sleepFn` הוא test seam). קבועים:
`TRANSIENT_CLONE_ERROR = /could not read Username|fatal: could not read/i`,
`DEFAULT_REDEPLOY_TIMEOUT_MS = 5*60_000`, `DEFAULT_REDEPLOY_POLL_INTERVAL_MS = 5_000`,
`DEFAULT_REDEPLOY_RETRY_DELAY_MS = 45_000`.

**`redeployExistingClient(client, options?)`** — מסלול חדש, **נפרד לחלוטין מ-`provision()` / `runProvision()`**:

- לקוח בלי `dokployApplicationId` → `{ ok:false, skipped:true, error:'...provision it explicitly...' }`,
  **בלי אף קריאת API**.
- אחרת: קורא **רק** `application.redeploy` עם `title` ייחודי
  (`Bulk redeploy <clientId> <timestamp>-<counter>-<8 hex>` — הקאונטר + random מוסיפים ודאוּת שהניסיון
  החוזר לא יתנגש בניסיון הראשון גם אם שניהם באותה מילישנייה), ואז `waitForTitledDeployment`.
- **אף פעם לא** קורא ל-`application.saveGitProvider` / `saveEnvironment` / `saveBuildType` /
  `mounts.create` / `postgres.create` / `postgres.deploy` / `domain.create` / `application.deploy` /
  `application.create`. זו בדיוק התקלה מ-03/09 (ה-`saveGitProvider` הלא-מותנה ב-`runProvision`
  דרס Git Provider ל-Custom בלי credentials).
- **B.2 retry**: אם `waitForTitledDeployment` מחזיר `ok:false` וה-`error` תואם `TRANSIENT_CLONE_ERROR` —
  המתנה `retryDelayMs` וניסיון **בודד** נוסף. כל שגיאה אחרת (כולל `401 Unauthorized` גנרי) נכשלת
  מיד, בלי retry.

**`waitForTitledDeployment(applicationId, title, timeoutMs, pollIntervalMs, sleepFn)`** — פרטי:

- לולאת polling עד `deadline`. בכל סבב `GET deployment.all?applicationId=...` דרך `getJson`.
- שלב 1: מוצא את השורה עם `row.title === title` → שומר `trackedId = row.deploymentId`.
- שלב 2: עוקב **רק** אחרי `row.deploymentId === trackedId`. `status === 'done'` → `{ ok:true }`;
  `status === 'error'` → `{ ok:false, error: row.errorMessage || 'Deployment failed' }`. כל דיפלוי
  אחר על אותו applicationId (title שונה — deploy ידני / Autodeploy) **מתעלמים ממנו לגמרי**.
- כשל זמני של ה-GET עצמו לא מפיל את ההמתנה — לוג warning והמשך polling עד ה-deadline.
- אחרי ה-timeout: `{ ok:false, error:'Deployment did not finish within Ns' }` — לא נתקע לנצח.

**`getJson<T>(route, query)`** — helper GET חדש (ה-`post()` הקיים הוא POST בלבד): בונה `URL`,
מוסיף `searchParams`, `fetch` עם header `x-api-key` בלבד, אותו טיפול שגיאות כמו `post()`.

### חלק B — `src/adminServer.ts`

- `BulkRedeployResult` הורחב: `+ skipped?: boolean` `+ retried?: boolean`.
- `runBulkRedeploy()`: קורא עכשיו `dokployProvisioner.redeployExistingClient(client)` במקום
  `provisionClient(client.id)`. רושם את התוצאה האמיתית לכל לקוח (`ok` / `error` / `skipped` /
  `retried`). נוסף **stagger של 8 שניות** בין לקוחות (`BULK_REDEPLOY_STAGGER_MS`), לא אחרי האחרון.
- `exposeBulkRedeployJob()`: `failed` כבר לא סופר `skipped` (`!item.ok && !item.skipped`), ונוסף
  שדה `skipped`.
- **`provisionClient()` לא שונה ולא נמחק** — עדיין בשימוש ב-3 המסלולים הפר-לקוחיים
  (`/owner/api/clients/:id/provision` ודומיו). השינוי היחיד: הכפתור הגורף כבר לא קורא לו.

### חלק B — `owner-public/index.html`

`pollBulkRedeploy()`: הודעת הסיום מציגה עכשיו "`N מתוך M לקוחות הסתיימו בהצלחה`" (כי `ok` עכשיו =
build שהגיע ל-`done`, לא "הבקשה התקבלה"), ומוסיפה ספירת `דולגו (אין עדיין יחידת Dokploy)`.

---

## 2. בדיקות שנכתבו + תוצאות ריצה

### `scripts/test-decision-recovery-scale.js` (חלק A)

```
  rememberTimedOutDecision (20k calls):
       0 seeded: 91.2 ms
    1000 seeded: 90.5 ms
    3000 seeded: 104.4 ms
    4000 seeded: 111.8 ms
  findByPhone new / O(1) index (20k calls):
       0 seeded: 1.7 ms
    1000 seeded: 1.0 ms
    3000 seeded: 0.7 ms
    4000 seeded: 0.8 ms
  findByPhone OLD / scan oracle (2k calls):
       0 seeded: 0.6 ms
    1000 seeded: 146.1 ms
    3000 seeded: 468.2 ms
    4000 seeded: 621.5 ms
  rememberTimedOutDecision OLD / full-sweep oracle (2k calls):
       0 seeded: 0.5 ms
    1000 seeded: 432.9 ms
    3000 seeded: 1379.3 ms
    4000 seeded: 1871.5 ms
  mutation guard: old findByPhone scan grew 4.3x, old remember sweep grew 4.3x from 1000->4000 (linear, as expected)
1. timing stays ~flat for both hot-path functions; old scan is confirmed linear.
2. a refreshed entry is repositioned so the front trim cannot drop it early.
3. phoneIndex stays in sync with the full-scan oracle across set/pause/remove/removeByPhone/removeByCampaign.
3a. findByPhone returns the first inserted jid for a shared phone, not the last.
4. restore() builds the phoneIndex itself - findByPhone works with no fresh message.
6. no empty Sets, no stale jids in phoneIndex after heavy churn.

Decision-recovery scale tests passed.
```

מכסה את כל 6 סעיפי "בדיקות ל-חלק A" מהתוכנית:

1. **benchmark חזרה (0/1000/3000/4000)** — הזמן של שתי הפונקציות החדשות נשאר ~שטוח
   (`rememberTimedOutDecision` ~91→112ms, יחס 1.2x; `findByPhone` ~1.7→0.8ms). קריטריון:
   יחס 0→4000 < 4x (קבוע גדול מספיק לרעש CI, רחוק מליניארי).
2. **re-insert ב-TTL** — `testRefreshedEntryTrim`: יוצר A,B,C; מעדכן את A; מוודא שסדר ההוספה עכשיו
   `[B,C,A]` (A עבר לסוף). ואז מסמן את B,C כפגו (`peekTimedOutDecision(...).expiresAt = past`),
   קורא `rememberTimedOutDecision` חדש, ומוודא ש-B,C נמחקו וש-A (מעודכן, בתוקף) שרד — כלומר
   ה-trim עבד **כי** A מוקם מחדש בסוף ולא חוסם.
3. **עקביות אינדקס עם scan הישן כ-oracle** — `assertIndexMatchesOracle` מריץ אחרי **כל** מוטציה
   (`set` ×3, `set` שמחליף טלפון על jid קיים, `pause`, `remove`, `removeByPhone`, `removeByCampaign`)
   גם את `scanFindByPhone` (עותק מדויק של הלוגיקה הישנה) וגם את `findByPhone` החדש, על כל טלפון
   שנגע + טלפון שלא קיים, ומשווה `senderJid`-ל-`senderJid`.
   3א. **"ראשון, לא אחרון"** — `testFirstNotLast`: שני jid (`...@c.us` ואז בלי) עם אותו טלפון
   מנורמל; מוודא ש-`findByPhone` מחזיר את הראשון; אחרי `remove` של הראשון — מחזיר את השני.
4. **`restore()` בלי הודעה חדשה** — `testRestoreBuildsIndex`: זורע snapshot עם 3 שיחות (2 חולקות
   טלפון), קורא `restore()`, ומיד — בלי שום `inbound` — קורא `findByPhone` ומוודא שהוא עובד ומחזיר
   את ה-jid הראשון. גם `assertIndexMatchesOracle` מיד אחרי restore.
5. **מוטציה** — שני oracle-ים (`scanFindByPhone`, `timeOldRememberSweep`) רצים על אותם נתונים
   זרועים בתוך הבדיקה ומוכיחים גידול ליניארי (יחס 1000→4000 > 2.5x). זה מבטיח שהבנצ'מרק בסעיף 1
   באמת מבחין. בנוסף בוצעה מוטציה על הקוד עצמו — ראה §3.
6. **בדיקת דליפות אינדקס** — `testNoIndexLeak`: 200 שיחות + churn (מחיקה, הוספה מחדש, `pause`),
   מוודא שאין `Set` ריק ואין jid מת באינדקס, ושכל שיחה חיה נמצאת; אחרי ניקוי מלא — האינדקס ריק.

**רגרסיה של חלק A** (כל אלה נוגעים ב-`ConversationStateManager`):

| בדיקה | תוצאה |
| --- | --- |
| `test-flow-recovery.js` | ✅ עבר |
| `test-flow-concurrency.js` | ✅ עבר |
| `test-conversation-state-flow-rehydration.js` | ✅ עבר |
| `test-decision-pending-registration-order.js` | ✅ עבר |
| `test-conversation-state-atomic-write.js` | ✅ עבר |
| `test-campaign-delete-conversations.js` | ✅ עבר |

### `scripts/test-redeploy-existing-client.js` (חלק B — B.0/B.1)

```
1. existing client: only application.redeploy + deployment.all(GET); no config routes touched.
2. client with no dokployApplicationId: skipped, zero API calls, no silent provisioning.

redeployExistingClient tests passed.
```

- **מקרה 1**: לקוח עם `dokployApplicationId`. `mock fetch` רושם כל route. Assertion:
  `[...new Set(routes)].sort()` שווה בדיוק ל-`['application.redeploy', 'deployment.all']` — כל route
  אחר (למשל `saveGitProvider` שחזר בטעות) יישבר את ה-`deepEqual`. בנוסף לולאה על `FORBIDDEN_ROUTES`.
  מוודא: `application.redeploy` נקרא פעם אחת, `POST`, `applicationId` נכון, `title` בפורמט הייחודי;
  `deployment.all` נקרא כ-`GET`.
- **מקרה 2**: `dokployApplicationId: undefined` → `result.skipped === true`, `result.ok === false`,
  `calls.length === 0`.

### `scripts/test-bulk-redeploy-status.js` (חלק B — B.1/B.2)

```
1. running→running→done: ok:true only after the tracked deploymentId is done.
2. status "error": ok:false with the real errorMessage, no blind retry.
3. race: an unrelated "done" deployment does not cause an early success report.
4. timeout: stuck "running" → ok:false after the deadline, no infinite loop.
5a. transient clone failure → single retry → ok:true, retried:true, second redeploy issued.
5b. generic "401 Unauthorized": no retry, immediate failure.

bulk redeploy status/polling tests passed.
```

מכסה את כל 6 סעיפי "בדיקות לחלק B" (סעיף 6 = "רק mock, לא Dokploy אמיתי" — מקוים):

1. `running`→`running`→`done` — מוודא `ok:true` רק אחרי שהסטטוס של **ה-deploymentId שלנו** = `done`,
   ושבוצעו ≥3 polls.
2. `status:'error'` עם `errorMessage` אמיתי לא-transient → `ok:false`, `error` = ה-`errorMessage`
   המדויק, `retried` לא הוגדר, `application.redeploy` נקרא פעם אחת.
3. **race** — ה-mock מחזיר שתי שורות: אחת עם `title: 'Manual deploy by admin'` שמגיעה מיד ל-`done`,
   ואחת עם ה-`title` שלנו שנשארת `running` עד poll 3. מוודא שלא דיווחנו הצלחה מוקדם (≥4 polls),
   ובסוף `ok:true` על שלנו.
4. **timeout** — ה-mock מחזיר תמיד `running`. `timeoutMs: 40` → `ok:false`, `error` תואם
   `/did not finish within/`, וחזר תוך פחות מ-5 שניות.
5. **retry** — ניסיון 1 מסתיים `error` עם `"fatal: could not read Username for 'https://github.com'..."`,
   ניסיון 2 → `done`. מוודא `ok:true`, `retried:true`, שני `application.redeploy`, ו-`title` שונה בין
   הניסיונות. **מקרה נגדי (5b)**: `errorMessage: '401 Unauthorized'` → `ok:false`, `retried` לא true,
   `application.redeploy` נקרא פעם אחת בלבד.

---

## 3. מוטציות שהורצו

| # | מה שברתי | קובץ | תוצאה |
| --- | --- | --- | --- |
| A-1 | החזרת `findByPhone` לסריקה מלאה — מדומה בתוך הבדיקה ע"י ה-oracle `scanFindByPhone` שרץ על אותם נתונים | (in-test) | ה-oracle גדל **4.3x** מ-1000 ל-4000 רשומות → ה-assertion `scanRatio > 2.5` מאשרת שהבנצ'מרק מבחין. הפונקציה החדשה באותו טווח: יחס ~1x. |
| A-2 | החזרת `rememberTimedOutDecision` לסריקה מלאה — מדומה ע"י `timeOldRememberSweep` | (in-test) | ה-oracle גדל **4.3x** מ-1000 ל-4000 → `sweepRatio > 2.5` מאשרת. |
| B-1 | הוספת `await this.post('application.saveGitProvider', { applicationId })` בתוך `runOnce()` ב-`redeployExistingClient` (קומפילציה + `node scripts/test-redeploy-existing-client.js`) | `src/dokployProvisioner.ts` | **הבדיקה נכשלה** כמצופה: `AssertionError ... only application.redeploy + deployment.all may be called, saw: application.saveGitProvider, application.redeploy, deployment.all`. `test-bulk-redeploy-status.js` גם נכשל (ה-mock שם זורק על route לא צפוי). המוטציה הוחזרה, שתי הבדיקות עברו שוב. |

המוטציה על A (repositioning / delete-before-set) מכוסה גם ע"י `testRefreshedEntryTrim` — הסרת
ה-`delete` לפני ה-`set` הופכת את ה-assertion `deepEqual(order, ['...002','...003','...001'])` לכושלת
(A נשאר ראשון).

---

## 4. סבב רגרסיה מלא

הורצו **48** סקריפטי `scripts/test-*.js` (כל הסוויטה למעט `*load*` — load tests הוחרגו לפי ההנחיה).
עטיפת `timeout 120` לכל בדיקה.

**תוצאה: 46 עברו, 2 "נכשלו" — שתיהן לא קשורות לשינוי הזה ולא רגרסיה:**

| בדיקה | מה קרה | האם קשור לשינוי |
| --- | --- | --- |
| `test-postgres-migration-pilot.js` | `POSTGRES MIGRATION PILOT: FAIL — DATABASE_URL is required and must point to an empty pilot database` | **לא.** דרישת סביבה (צריך DB פיילוט ריק ב-`DATABASE_URL`). אומת שנכשל **זהה על `master`** (`git checkout master` + ריצה → אותה הודעה בדיוק). לא נוגע ל-`messageFlow`/`conversationState`/`dokployProvisioner`. |
| `test-referral-ranking.js` | ה-assertions עברו (`Referral ranking and menu tests passed.`, exit 0) אך הריצה נמשכה ~4 דקות wall-clock (0.37s CPU — כולה המתנה לטיימרים), מעבר לעטיפת ה-120s של הרנר שהרגה את התהליך בזמן שהתרוקן. | **לא.** קובץ הבדיקה עודכן לאחרונה 2026-08-31, לפני הענף (`git merge-base --is-ancestor` → הקומיט של הקובץ הוא ancestor של הענף). אין ל-`process.exit(0)` בהצלחה, ולכן התהליך נשאר חי עד שכל הטיימרים מתנקזים — משך תלוי-תזמון, קרוב לגבול. השינויים שלי רק **מזרזים** את `conversationState` (אינדקס O(1) במקום סריקה) ולא מוסיפים שום השהיה. ריצה בודדת עם `timeout 240` על הענף: `Referral ranking and menu tests passed.` / `real 4m0.082s` / `exit=0`. |

הבדיקות של חלק A ו-B מ-§2 כלולות בסבב הזה ועברו:
`test-decision-recovery-scale.js` (6s), `test-redeploy-existing-client.js` (0s),
`test-bulk-redeploy-status.js` (0s).

הרשימה המלאה של 46 שעברו (זמן ריצה):

```
test-bulk-redeploy-status(0s) test-campaign-data-reset(1s) test-campaign-delete-conversations(2s)
test-client-disable(0s) test-contacts-provider-default(0s) test-conversation-state-atomic-write(0s)
test-conversation-state-flow-rehydration(60s) test-decision-pending-registration-order(3s)
test-decision-recovery-scale(6s) test-dokploy-provisioner-postgres(0s) test-email-capture(3s)
test-email-export(2s) test-file-delivery-order(3s) test-flow-concurrency(5s) test-flow-recovery(1s)
test-flush-scoped-wait(4s) test-graceful-shutdown(5s) test-group-join-flow(0s) test-health-live(2s)
test-inbox-sender-concurrency(3s) test-message-delays(0s) test-meta-campaign-routing(1s)
test-meta-gateway-inbox(0s) test-meta-gateway-reliability(0s) test-meta-media-cache(0s)
test-meta-speed-and-list-presentation(1s) test-meta-trigger-age-window(0s) test-meta-typing-indicator(0s)
test-meta-webhook-signature(1s) test-migration-safety(1s) test-outbox-claim(0s) test-outbox-durability(1s)
test-outbox-ordering(0s) test-postgres-burst(2s) test-postgres-delta(1s)
test-postgres-dirty-tables-benchmark(2s) test-postgres-dirty-tables(0s) test-postgres-no-lost-writes(0s)
test-postgres-transactions(3s) test-provider-health(2s) test-redeploy-existing-client(0s)
test-score-result-preface(0s) test-service-bot-flow(2s) test-service-bot-ui(1s) test-vcard-export(1s)
test-whatsapp-link-normalization(1s)
```

---

## 5. פריטים שלא אומתו עצמאית — "לא ידוע, דורש בדיקה נוספת"

- **שמות שדות ה-API של Dokploy `GET /api/deployment.all`** (`deploymentId`, `title`, `description`,
  `status`, `createdAt`, `startedAt`, `finishedAt`, `errorMessage`; ערכי `status` = `'running'` /
  `'done'` / `'error'`) — **הועתקו מהתוכנית, לא אומתו מחדש עצמאית מול Dokploy חי** בסשן הזה (אין גישה
  ל-instance / `x-api-key` מכאן). התוכנית מציינת שהם אומתו בפועל בסבב הסקירה, אבל לא אימתתי זאת
  שוב. אם שם שדה שונה במציאות (`errorMessage` מול `error`, `status` מול `state`, וכו') — `interface
  DokployDeployment` ב-`src/dokployProvisioner.ts` הוא הנקודה היחידה לתקן, וה-mock-ים בבדיקות
  משתמשים באותם שמות ולכן לא יתפסו סטייה כזו. **דורש curl ידני אחד מול Dokploy לפני שסומכים על
  המסלול בפרודקשן.**
- **המסלול `GET` דרך `getJson` בפועל מול Dokploy** — נבדק רק מול `mock fetch`. הנתיב שנבנה הוא
  `${endpoint}/deployment.all?applicationId=...` כאשר `endpoint` כבר כולל `/api` (כמו `post()` הקיים).
  לא בוצעה קריאה אמיתית.
- **התנהגות ה-stagger / timeout בפרודקשן** (8s בין לקוחות, 5min timeout לכל דיפלוי) — הערכים סבירים
  אך לא כוילו מול משך build אמיתי של הפרויקט. אם build לוקח יותר מ-5 דקות, ה-polling יחזיר
  `ok:false` (timeout) בעוד הדיפלוי בעצם מצליח מאוחר יותר — כדאי לוודא את משך ה-build הטיפוסי.

---

## 6. B.3 — כפתור "עדכן תצורה לכל הלקוחות" — **לא מומש**

B.3 סומן במפורש כאופציונלי בתוכנית ("אופציונלי לסבב הזה, אך מתועד ומאושר עקרונית"). לא מומש בסבב
הזה כדי לצמצם היקף ולהתמקד בתיקון שעוצר את הרגרסיה (B.0‑B.2).

**מה שקיים היום:** היכולת לעדכן תצורה גורפת **לא נעלמה** — `provisionClient()` נשאר ללא שינוי
וממשיך לעשות `saveGitProvider` + `saveEnvironment` + redeploy. הוא נגיש דרך המסלול הפר-לקוחי
(`POST /owner/api/clients/:id/provision` וכו'), כלומר עדכון תצורה גורף אפשרי היום ע"י הפעלה ידנית
פר-לקוח. מה שהשתנה: הכפתור הגורף "פרוס מחדש" **הפסיק** לקרוא ל-`provisionClient` ולכן כבר לא ישמש
בטעות לעדכון תצורה.

**מה נשאר לעשות ל-B.3 המלא:**

1. Endpoint חדש `POST /owner/api/clients/update-config-all` + job נפרד (לא לערבב עם
   `bulkRedeployJob`).
2. חישוב diff של משתני הסביבה לכל לקוח **לפני** הביצוע — דורש `GET` נוסף מ-Dokploy למשיכת ה-env
   הנוכחי (`application.one` או דומה) והשוואה מול מה ש-`runProvision` יכתוב. להציג את ה-diff
   למשתמש.
3. UI: כפתור נפרד "עדכן תצורה לכל הלקוחות" (לא ליד "פרוס מחדש"), עם תצוגת ה-diff ואישור מפורש
   נפרד (`prompt`/`confirm` ייעודי, לא checkbox).
4. הביצוע: `provisionClient()` פר-לקוח, ברצף עם אותו stagger, עטוף באותו `waitForTitledDeployment`
   מ-B.1 (כרגע `provisionClient` מסתמך על `provisioningStatus: 'deploying'` בלי polling אמיתי).
5. תצוגת תוצאה אמיתית פר-לקוח.
6. בדיקות: שה-diff מחושב נכון, שאישור חסר עוצר, שכל לקוח עובר polling.

---

## 7. קומיטים על הענף `decision-recovery-scale-fix`

| hash | הודעה |
| --- | --- |
| `db3a3e4` | Part A: make decision-recovery hot path O(1) instead of O(n) |
| `d9694ef` | Part B: safe bulk redeploy - separate path, polled to real completion |
| `eb48af2` | Part A: fix method name in test-hook doc comment |

(hash של קומיט מסמך התוצאה הזה יתווסף בעת ה-commit.)

לא בוצע `git push` ולא מיזוג ל-`master`. קבצים לא-קשורים (`ZOMEE service bot`, `.migration/`,
`.tmp-zomee-*`, מסמכי docs אחרים) לא נגעו בהם ולא נוספו ל-git.
