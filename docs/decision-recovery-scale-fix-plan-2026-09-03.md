# תוכנית טכנית — תיקון קנה-מידה של שחזור החלטות (עדיפות 2.2) + אמינות "פרוס מחדש את כולם"

מסמך לסקירת קודקס. שני חלקים בלתי-תלויים: A (שחזור החלטות ל-24 שעות — הגורם שנשאר מ-`docs/post-campaign-fixes-2026-09-01.md` §2.2) ו-B (הכפתור הגורף בדשבורד המנהל).

## עדכון — הערות קודקס (סבב 1+2) שולבו

- **A מאושר סופית.** תיקון האינדקס ל-`Set<jid>` נכון; קודקס אישר שאין נתיב כתיבה נוסף ל-`this.map` מלבד `set`/`pause`/`remove`/`removeByPhone`/`removeByCampaign`/`restore` — כל השישה מכוסים בתוכנית.
- **B מאושר עקרונית, עם פרטי מימוש שאומתו בפועל מול Dokploy** (לא עוד הנחות): ה-API האמיתי הוא **`GET /api/deployment.all?applicationId=...`**, לא POST דרך ה-helper הקיים; שמות השדות אומתו (`deploymentId`, `title`, `status`, `errorMessage`, ועוד). הפולינג עצמו משתנה: מזהים את הדיפלוי שלנו לפי **title ייחודי** שאנחנו שולחים, לא רק "מזהה חדש שהופיע" — הגנה טובה יותר מפני race עם דיפלוי מקביל. נוסף גם דרישה לכפתור נפרד לחלוטין ל"עדכון תצורה לכולם" (B.3, חדש) — לא לערבב עם "פרוס מחדש", ראה למטה.

## רקע — מה כבר נבדק ומה עדיין פתוח

`docs/post-campaign-fixes-2026-09-01.md` הציג שני סעיפים תחת "עדיפות 2":

- **§2.1** (`campaignEvents`/`campaignResults` הן הטבלאות הגדולות) — **בדיקה מחדש מגלה שזה כבר תוקן**. הקומיטים `ce7abee` ו-`a329514` (29/8, **לפני** כתיבת המסמך) כבר הוסיפו מעקב ברמת שורה ל-`campaignResults` (`syncCampaignResultsDelta` עם `dirtyRowIds`) ומסלול append-only ל-`campaignEvents` (`syncCampaignEventsDelta`). אימתתי ישירות בקוד: `storage.ts:1626-1629`, `recordCampaignEvent()` כבר מתייג `dirtyRowIds: { campaignResults: event.campaignResultId }`. הרצתי שוב את `scripts/test-postgres-dirty-tables-benchmark.js` (אחרי שתיקנתי בו mock pool שבור, לא קשור) — מחזור שליחה מלא (4 קריאות `persist()`): 2059ms→271ms, פי 7.6 מהיר. **§2.1 סגור, אין צורך בעבודה נוספת שם.** המסמך המקורי לא עודכן לשקף זאת — כדאי לתקן שם בנפרד, לא חלק מהמשימה הזו.

- **§2.2** (שמירת `expired-decision` ל-24 שעות) — **עדיין פתוח, וזיהיתי את הגורם המדויק** (לא רק "24 שעות זה הרבה" כמו שהמסמך המקורי ניסח, אלא שני מנגנוני **O(n) בפועל** על הנתיב החם). זה הנושא של המסמך הזה.

## חלק A — שני מנגנוני O(n) בנתיב החם, לא רק "24 שעות"

הפרופיל ב-C-1 (`post-campaign-fixes-2026-09-01.md:197-217`) מדד עלייה ליניארית ב-`handleIncomingWhatsAppMessage` עם מספר השיחות שנצברו (429ms→570ms, 0→3000 שיחות `expired-decision`). מצאתי שני מקומות קונקרטיים שגורמים לזה — לא ניחוש, קריאה ישירה בקוד:

### A.1 — `rememberTimedOutDecision()` סורק את כל ה-Map בכל קריאה

`src/messageFlow.ts:218-229`:

```ts
function rememberTimedOutDecision(context: Omit<TimedOutDecisionContext, 'expiresAt'>): void {
  const now = Date.now();
  for (const [key, item] of timedOutDecisions.entries()) {
    if (item.expiresAt <= now) timedOutDecisions.delete(key);
  }
  const key = senderWorkKey(context.senderPhone || context.senderJid);
  timedOutDecisions.set(key, { ...context, expiresAt: now + FLOW_RECOVERY_WINDOW_MS });
  ...
}
```

בכל פעם שהחלטה פגה ונשמרת ל-24 שעות, הפונקציה סורקת **את כל ה-Map** (עד אלפי רשומות) כדי לנקות רשומות שפגו — לפני שהיא בכלל מוסיפה את הרשומה החדשה. זה בדיוק תואם את המדידה: `set()` עולה מ-0.67ms (Map ריק) ל-17.49ms (4000 רשומות) — לינארי במספר הרשומות שנצברו, בדיוק כמו שה-C-1 measured.

**התיקון:** `Map` שומר סדר הוספה, וכל הרשומות מקבלות אותו TTL קבוע (`FLOW_RECOVERY_WINDOW_MS`) יחסית לזמן ההוספה שלהן — כלומר **סדר ההוספה זהה לסדר התפוגה**. אין צורך לסרוק הכל; מספיק לחתוך מההתחלה כל עוד הרשומה הראשונה פגה:

```ts
function rememberTimedOutDecision(context: Omit<TimedOutDecisionContext, 'expiresAt'>): void {
  const now = Date.now();
  // Map preserves insertion order, and every entry gets the same fixed TTL from
  // its own insertion time — so insertion order === expiry order. Trimming from
  // the front while the oldest entry has expired is equivalent to a full sweep,
  // but O(1) amortized instead of O(n) per call.
  let oldest = timedOutDecisions.entries().next();
  while (!oldest.done && oldest.value[1].expiresAt <= now) {
    timedOutDecisions.delete(oldest.value[0]);
    oldest = timedOutDecisions.entries().next();
  }
  const key = senderWorkKey(context.senderPhone || context.senderJid);
  timedOutDecisions.set(key, { ...context, expiresAt: now + FLOW_RECOVERY_WINDOW_MS });
  if (timedOutDecisions.size > 5000) {
    const oldestKey = timedOutDecisions.keys().next().value;
    if (oldestKey) timedOutDecisions.delete(oldestKey);
  }
}
```

**סיכון:** אם `key` כבר קיים ב-Map (אותו שולח מקבל timeout שני), `Map.set` על מפתח קיים **לא** מזיז אותו לסוף סדר ההוספה — הוא נשאר במקומו המקורי. זה שובר את ההנחה "סדר הוספה = סדר תפוגה" עבור אותה רשומה ספציפית (התאריך תפוגה מתעדכן, אבל המיקום ב-iteration order לא). המשמעות בפועל: רשומה מעודכנת עלולה להימחק ע"י ה-trim **מוקדם מדי** (לפי המיקום הישן שלה, לא ה-`expiresAt` החדש) — באג עדין. **תיקון נדרש:** למחוק את המפתח לפני `set` כשהוא כבר קיים, כדי ש-`Map` יכניס אותו מחדש בסוף סדר ההוספה:

```ts
  const key = senderWorkKey(context.senderPhone || context.senderJid);
  timedOutDecisions.delete(key); // re-insert at the end so insertion order stays expiry order
  timedOutDecisions.set(key, { ...context, expiresAt: now + FLOW_RECOVERY_WINDOW_MS });
```

### A.2 — `conversationState.findByPhone()` סורק את כל השיחות הממתינות, בכל הודעה נכנסת

`src/conversationState.ts:274-281`:

```ts
findByPhone(phone: string | undefined): PendingConversation | undefined {
  const normalized = normalizePhone(phone);
  if (!normalized) return undefined;
  for (const state of this.map.values()) {
    if (normalizePhone(state.senderPhone) === normalized) return state;
  }
  return undefined;
}
```

זה נקרא **בכל הודעה נכנסת**, לא רק בטריגר — `src/messageFlow.ts:771` (זרימת שחזור) ו-`:811` (`handleMessage`, הנתיב הראשי):

```ts
let pending = conversationState.get(senderJid) || conversationState.findByPhone(senderPhone);
```

`conversationState.get(senderJid)` הוא O(1) אבל מפספס בכל פעם שה-jid לא זהה בדיוק לזה שנשמר (נפוץ ב-WhatsApp — פורמט jid משתנה בין מקורות). כשזה מפספס, `findByPhone` סורק **את כל ה-Map**, כולל כל רשומות ה-`expired-decision` שנצברו (עד 1075 בפרודקשן אמיתי, לפי `post-campaign-fixes-2026-09-01.md:46`). זה כנראה הגורם הדומיננטי במדידת ה-C-1 (429ms→570ms) — יותר מ-A.1, כי זה רץ על **כל הודעה**, לא רק על הודעות שמעוררות timeout חדש.

**התיקון (מתוקן לפי הערת קודקס):** הסריקה המקורית מחזירה את ה-**ראשון** שנמצא ב-`this.map.values()` (סדר הוספה). אינדקס `Map<phone, jid>` יחיד לא שומר על זה — כשיש שני jid לאותו טלפון מנורמל (מצב נדיר אך אפשרי, למשל כפילות רגעית), `Map.set` על אותו מפתח דורס את הערך הקודם, כך שהאינדקס ה"יחיד" יחזיר את **האחרון שנכתב**, לא את הראשון. זו רגרסיה סמנטית עדינה, גם אם נדירה. **התיקון: `Map<phone, Set<jid>>`, ומחזירים את האיבר הראשון ב-`Set`** (Set שומר סדר הוספה כמו Map, אז "ראשון ב-Set של הטלפון הזה" שקול ל"ראשון שנמצא בסריקה המלאה בין הרשומות שחולקות את הטלפון הזה"):

```ts
class ConversationStateManager {
  private readonly map = new Map<string, PendingConversation>();
  private readonly phoneIndex = new Map<string, Set<string>>(); // normalizedPhone -> jids, insertion order

  set(jid: string, state: PendingConversation): void {
    this.clearTimer(this.map.get(jid));
    this.reindexPhone(jid, state.senderPhone);
    this.map.set(jid, state);
    this.persist([jid]);
  }

  remove(jid: string): void {
    const existing = this.map.get(jid);
    this.clearTimer(existing);
    if (existing) this.unindexPhone(jid, existing.senderPhone);
    this.map.delete(jid);
    this.persist([jid]);
  }

  findByPhone(phone: string | undefined): PendingConversation | undefined {
    const normalized = normalizePhone(phone);
    if (!normalized) return undefined;
    const jids = this.phoneIndex.get(normalized);
    if (!jids) return undefined;
    const firstJid = jids.values().next().value;
    return firstJid ? this.map.get(firstJid) : undefined;
  }

  private reindexPhone(jid: string, phone: string | undefined): void {
    const existing = this.map.get(jid);
    if (existing) this.unindexPhone(jid, existing.senderPhone);
    const normalized = normalizePhone(phone);
    if (!normalized) return;
    let set = this.phoneIndex.get(normalized);
    if (!set) {
      set = new Set();
      this.phoneIndex.set(normalized, set);
    }
    set.add(jid);
  }

  private unindexPhone(jid: string, phone: string | undefined): void {
    const normalized = normalizePhone(phone);
    if (!normalized) return;
    const set = this.phoneIndex.get(normalized);
    if (!set) return;
    set.delete(jid);
    if (set.size === 0) this.phoneIndex.delete(normalized); // don't leak empty Sets
  }
  ...
}
```

**נקודות שדורשות תשומת לב, לא רק ה-happy path:**

1. **כל מקום שממחק/מחליף רשומה חייב לעדכן את האינדקס.** קודקס אישר (סבב 2) שאין נתיב כתיבה נוסף ל-`this.map` מלבד השישה האלה — **`set`, `pause`, `remove`, `removeByPhone`, `removeByCampaign`, `restore`** — כל השישה חייבים כיסוי. `pause()` לא אמור לשנות `senderPhone` בפועל, אבל נכון להשאיר אותו בבדיקת העקביות בכל זאת (הגנה מפני שינוי עתידי, לא רק המצב הנוכחי).
2. **`restore()` (`conversationState.ts:350`) כותב ישירות ל-`this.map.set(jid, ...)` בעלייה, בלי לעבור דרך המתודה הציבורית `set()`** — כלומר האינדקס **לא** ייבנה משם אוטומטית אם מסתמכים רק על `set()` הציבורית. חייבים להוסיף `this.reindexPhone(jid, hydrated.senderPhone)` בתוך הלולאה ב-`restore()` (שורה 344-351), לפני/אחרי ה-`this.map.set` — אחרת האינדקס יהיה ריק אחרי כל restart עד שהודעה חדשה תיגע בכל שיחה, מה שמחזיר בעצם את הבאג המקורי (fallback ל-scan מלא, כי `phoneIndex` ריק) לזמן לא מוגדר אחרי כל דיפלוי.
3. **שני jid יכולים לחלוק אותו מספר טלפון מנורמל** — מטופל עכשיו נכון ע"י `Set` ששומר את כל ה-jid-ים לפי סדר הוספה, ומחזיר את הראשון — זהה בדיוק להתנהגות הקיימת.
4. **`removeByPhone`/`removeByCampaign` עוברות על כמה רשומות** — כל אחת צריכה `unindexPhone` בנפרד בתוך הלולאה הקיימת.

## בדיקות ל-חלק A

סקריפט חדש `scripts/test-decision-recovery-scale.js`:

1. **מדידת חזרה על ה-C-1 probe** — לזרוע `timedOutDecisions`/`conversationState` (in-process, לא צריך DB) עם 0 / 1,000 / 3,000 / 4,000 רשומות `expired-decision`, למדוד `rememberTimedOutDecision()` ו-`findByPhone()` ישירות. קריטריון הצלחה: **זמן לא גדל יותר מ-~2x** בין 0 ל-4000 רשומות (לא צריך להיות בדיוק שטוח — יש עלות קבועה כלשהי — אבל בהחלט לא ליניארי כמו קודם).
2. **מבחן ה-re-insert בעדכון TTL** — ליצור רשומה, לעדכן אותה (`rememberTimedOutDecision` שוב על אותו sender), להוסיף עוד רשומות ישנות שכבר פגו לפניה, ולוודא שה-trim לא מוחק אותה מוקדם מדי (זה בדיוק הבאג שתואר ב-A.1 אם ה-`delete`-לפני-`set` לא מיושם).
3. **מבחן עקביות אינדקס-טלפון, עם ה-scan הישן כ-oracle** — קודקס אישר שזו בדיוק הדרך הנכונה: הסריקה המלאה הקיימת (`for (const state of this.map.values())`) היא ה-**oracle** — לא רק "תבדוק שזה עובד", אלא helper ייעודי (`function scanFindByPhone(map, phone) { ... }`, עותק מדויק של הלוגיקה הישנה) שמריץ **גם** את הסריקה המלאה **וגם** את `findByPhone` החדש אחרי כל פעולה (`set`/`remove`/`removeByPhone`/`removeByCampaign`/`pause`/עדכון טלפון על jid קיים), ומשווה תוצאה-לתוצאה. כל פער = רגרסיה תפוסה מיידית, לא תלוי בכיסוי ידני של כל מקרה קצה.
3א. **מבחן "ראשון, לא אחרון"** — ליצור שני jid שונים עם אותו טלפון מנורמל (בסדר ידוע), לוודא ש-`findByPhone` מחזיר את הראשון שנוסף — לא את השני. זה המקרה הספציפי שהערת קודקס תפסה; חובה שיהיה מבחן ייעודי לו, לא רק חלק מבדיקת העקביות הכללית.
4. **מבחן שחזור מדיסק (`restore()`)** — לזרוע קובץ snapshot עם כמה שיחות שחולקות טלפון (כולל המקרה של 3א), לקרוא ל-`restore()`, ולוודא ש-`findByPhone` עובד **מיד אחרי** ה-restore בלי שאף הודעה חדשה נגעה בשיחות — כלומר שהאינדקס נבנה בפועל בתוך `restore()`, לא רק ב-`set()` הרגילה. זה בודק ישירות את הפער שקודקס ציין (כתיבה ישירה ל-`this.map` ב-`restore()`).
5. **מוטציה** — להחזיר את `findByPhone` לסריקה המלאה, לוודא שהבדיקה בסעיף 1 נכשלת (מוכיחה שהבדיקה תופסת רגרסיה אמיתית, לא רק "עובר").
6. **רגרסיה מלאה** — `test-flow-recovery.js`, `test-flow-concurrency.js`, `test-conversation-state-flow-rehydration.js`, `test-decision-pending-registration-order.js` — כל אלה נוגעים ישירות ב-`ConversationStateManager`.

## חלק B — אמינות "פרוס מחדש את כל הלקוחות"

מה שקרה בפועל (03/09): לחיצה על הכפתור הריצה תור סדרתי (`for...await`, `adminServer.ts:2316-2329` — **כבר סדרתי, לא מקבילי**), אבל 9 מתוך 11 לקוחות נכשלו ב-clone עם `fatal: could not read Username for 'https://github.com'`, בעוד `ok:true` דווח לכולם. אחרי כמה שעות (ללא פעולה נוספת) כל 13 השירותים עלו בהצלחה עם הקוד החדש — כנראה rate-limit זמני של GitHub על clone אנונימי מאותה כתובת IP, שחלף מעצמו.

**שלוש בעיות נפרדות, לא שתיים** (קודקס הוסיף את הראשונה, הקריטית ביותר):

0. **[חובה, לפי קודקס] הכפתור הגורף לא יכול להמשיך לקרוא ל-`provisionClient()`.** `provisionClient` → `dokployProvisioner.runProvision` (`dokployProvisioner.ts:291-485`) קורא **תמיד** ל-`application.saveGitProvider` עם `customGitUrl` גולמי (שורות 374-382), **בלי תנאי** — כלומר בכל הרצה, גם עבור לקוח שכבר קיים ומוגדר תקין, זה מחזיר את ה-Git Provider שלו ל-"Custom" בלי credentials. **זו בדיוק התקלה שגרמה לכשל שראינו.** בנוסף, כשלא מתקיים `preserveExistingEnvironment`, זה גם קורא ל-`application.saveEnvironment` שדורס את משתני הסביבה — מיועד ליצירה/עדכון תצורה, לא לדיפלוי חוזר גרידא. **הכפתור הגורף חייב מסלול נפרד לגמרי**, לא רק "לתקן את מה שיש".
1. **`ok:true` לא אומר שהדיפלוי הצליח.** התשובה מ-Dokploy מגיעה ברגע שהבקשה **מתקבלת**, לא כשה-build בפועל מסתיים בהצלחה.
2. **אין staggering בין לקוחות**, אז אם יש כשל שתלוי בקצב (rate-limit, עומס רגעי על ה-worker), כל הלקוחות ברשימה נחשפים לאותו חלון בעייתי ברצף צפוף.

### B.0 — עקרון: מסלול נפרד `redeployExistingClient()`, בלי לגעת בתצורה

**חוזה הפונקציה** (המימוש המלא, כולל ה-polling, מופיע ב-B.1 למטה — כאן רק העקרון המחייב):

- **רק `application.redeploy`**, אף פעם לא `application.deploy`/`saveGitProvider`/`saveEnvironment`/`saveBuildType`/`mounts.create`/`postgres.create`/`domain.create` — המסלול הזה לא נוגע בשום דבר מלבד "תבנה שוב את מה שכבר מוגדר".
- לקוח בלי `dokployApplicationId` (טרם עבר provisioning ראשוני) → `skipped`, **לא** ניסיון provisioning חדש בשקט. אם רוצים ליצור לקוח חדש, זו פעולה מפורשת נפרדת (`provisionClient` הקיים, מופעל ידנית פר-לקוח), לא חלק מ"פרוס מחדש לכולם".
- `runBulkRedeploy` (`adminServer.ts:2305-2334`) עובר לקרוא ל-`redeployExistingClient` במקום `provisionClient`.

### B.1 — Polling לפי title ייחודי + deploymentId, מאומת מול Dokploy בפועל

**API מאומת בפועל (לא הנחה עוד):**

```
GET /api/deployment.all?applicationId=<applicationId>
```

שדות מאומתים בתשובה: `deploymentId`, `title`, `description`, `status`, `createdAt`, `startedAt`, `finishedAt`, `errorMessage`. `status === 'done'` = הצלחה אמיתית, `status === 'error'` = כשל אמיתי. **זה GET, לא POST** — ה-helper הקיים `this.post()` (`dokployProvisioner.ts:511-531`) לא מתאים; צריך `private async get<T>(route: string, query: Record<string, string>): Promise<T>` נפרד ב-`DokployProvisioner`, עם אותו header `x-api-key`.

**זיהוי הדיפלוי שלנו: לפי `title` ייחודי שאנחנו שולחים, לא רק "מזהה חדש שהופיע".** זה חסין יותר ל-race מול דיפלוי מקביל (ידני או Autodeploy) שיכול להופיע באותו רגע:

```ts
private async getJson<T = unknown>(route: string, query: Record<string, string>): Promise<T> {
  const url = new URL(`${this.config!.endpoint}/api/${route}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { 'x-api-key': this.config!.token } });
  if (!response.ok) throw new Error(`Dokploy API GET ${route} failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function redeployExistingClient(client: ManagedClient): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!client.dokployApplicationId) {
    return { ok: false, skipped: true, error: 'No existing Dokploy application — use provisionClient() explicitly.' };
  }
  const title = `Bulk redeploy ${client.id} ${Date.now()}`; // unique per invocation
  await this.post('application.redeploy', { applicationId: client.dokployApplicationId, title, description: 'Redeploy existing client with current code — no config changes' });
  return this.waitForTitledDeployment(client.dokployApplicationId, title);
}

async function waitForTitledDeployment(
  applicationId: string,
  title: string,
  timeoutMs = 5 * 60_000,
  pollIntervalMs = 5_000,
): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let trackedId: string | undefined;
  while (Date.now() < deadline) {
    const deployments = await this.getJson<DokployDeployment[]>('deployment.all', { applicationId });
    if (!trackedId) {
      const match = deployments.find((d) => d.title === title);
      if (match) trackedId = match.deploymentId;
    } else {
      const tracked = deployments.find((d) => d.deploymentId === trackedId);
      if (tracked?.status === 'done') return { ok: true };
      if (tracked?.status === 'error') return { ok: false, error: tracked.errorMessage ?? 'Deployment failed' };
      // still running — keep polling the SAME tracked id, ignore anything newer/unrelated.
    }
    await sleep(pollIntervalMs);
  }
  return { ok: false, error: `Deployment did not finish within ${timeoutMs / 1000}s` };
}
```

שני שלבי חיפוש (למצוא לפי `title`, ואז לעקוב לפי `deploymentId`) ולא סתם "המזהה האחרון" — כי `title` ייחודי-לחלוטין (כולל timestamp), אז גם אם שני דיפלויים רצים ממש באותו רגע על אותו applicationId, אין דו-משמעות איזה מהם שלנו.

### B.2 — retry רק לכשל transient מזוהה, לא לכשל תצורה

- **retry בודד** רק כשההודעה תואמת דפוס clone-transient ידוע (`could not read Username`, `fatal: could not read`), עם השהיה 30-60 שניות. **לא** retry אוטומטי על כל כשל — למשל שגיאת הרשאה אמיתית (טוקן פג, repo נמחק) היא כשל תצורה שדורש בן אדם, וניסיון חוזר עיוור רק מסתיר את זה וגורם לבזבוז זמן/build quota.
- staggering — השהיה קצרה (5-10 שניות) בין לקוחות ב-`runBulkRedeploy`, לפזר את החלון החשוף ל-rate limit. אבל **ה-polling עד לסיום אמיתי הוא ההגנה העיקרית**, לא ה-staggering — staggering לבדו לא היה מונע את מה שקרה (רצף סדרתי כבר היה קיים, וזה עדיין נכשל בשקט).
- הצגת תוצאה אמיתית ב-`owner-public/index.html` — היום `ok:true` = "הבקשה התקבלה", אחרי התיקון = "הדיפלוי אכן הסתיים בהצלחה".

### B.3 — כפתור נפרד "עדכן תצורה לכל הלקוחות" (חדש, לפי דרישת קודקס)

יש תרחיש לגיטימי שבו כן רוצים לגעת בתצורה של כל הלקוחות — למשל `META_APP_SECRET` חדש, או שינוי ב-URL משותף. זה **לא** אמור לקרות דרך "פרוס מחדש", אלא דרך פעולה נפרדת ומודעת-סיכון:

- שם ברור, נפרד מ"פרוס מחדש": **"עדכן תצורה לכל הלקוחות"**.
- לפני ביצוע — **מציג בפירוש מה עומד להשתנות** (diff של משתני הסביבה שישתנו, לא רק "עדכון תצורה" כללי).
- דורש אישור מפורש נפרד (לא אותו כפתור, לא checkbox ששוכחים).
- רק אז קורא ל-`provisionClient()` הקיים (שכבר עושה `saveGitProvider`+`saveEnvironment`+redeploy) — פר-לקוח, ברצף עם staggering, עם אותו polling מ-B.1 (לא סתם `ok:true` על קבלת הבקשה).
- מציג תוצאה אמיתית לכל לקוח בנפרד, לא רק "בוצע לכולם".

**זה משמעותי: `provisionClient()` הקיים לא נמחק ולא משתנה** — הוא ממשיך לשמש ליצירת לקוחות חדשים ולעדכון תצורה מכוון. השינוי היחיד הוא **שהכפתור הגורף "פרוס מחדש" מפסיק לקרוא לו**, ועובר ל-`redeployExistingClient()` הבטוח. "עדכן תצורה לכולם" הוא כפתור נוסף, לא תיקון לקיים — לא חובה למימוש באותו סבב אם רוצים לצמצם היקף, אבל צריך להיות מתועד כדי שברור שהיכולת לעדכן תצורה גורפת עדיין קיימת במקום מפורש, לא נעלמה.

### סדר ביצוע מומלץ (לפי קודקס)

1. חלק A, עם תיקון האינדקס ל-`Set` ובניית האינדקס גם ב-`restore()`.
2. B.0 — מסלול `redeployExistingClient()` נפרד, שלא נוגע ב-Git Provider/Environment. זה מה שעוצר את התקלה שראינו מלחזור על עצמה.
3. B.1 — `GET /api/deployment.all` (helper GET נפרד), polling לפי `title` ייחודי + `deploymentId`, תצוגת תוצאה אמיתית.
4. B.2 — retry יחיד, רק לכשל transient מזוהה.
5. B.3 — כפתור "עדכן תצורה לכל הלקוחות" נפרד (אופציונלי לסבב הזה, אך מתועד ומאושר עקרונית).

## בדיקות לחלק B

1. **`scripts/test-redeploy-existing-client.js`** — עם Dokploy API מדומה (mock fetch): מוודא ש-`redeployExistingClient` **לא** קורא אף פעם ל-`saveGitProvider`/`saveEnvironment`/`mounts.create`/`postgres.create`/`domain.create` (assertion על רשימת הקריאות שנרשמו ל-mock, לא רק על התוצאה הסופית) — רק `application.redeploy`. לקוח בלי `dokployApplicationId` → מוודא `skipped:true` ושאף קריאת API לא נשלחה.
2. **`scripts/test-bulk-redeploy-status.js`** — מדמה `GET deployment.all` שמחזיר `running`→`running`→`done` עבור title שנשלח, מוודא ש-`waitForTitledDeployment` מוצא את הדיפלוי הנכון לפי `title`, עובר למעקב לפי `deploymentId`, ומחזיר `ok:true` רק אחרי הסטטוס הסופי **של אותו deploymentId**. מקרה נוסף: `error` מוחזר עם ה-`errorMessage` האמיתי.
3. **מבחן race עם דיפלוי מקביל** — mock שמחזיר deployment **אחר** (title שונה, למשל מ-deploy ידני או Autodeploy) שמגיע ל-`done` מיד, בזמן שה-deployment עם ה-title שלנו עדיין `running` — מוודא שהקוד **לא** מדווח הצלחה מוקדמת מדי בגלל ה-deployment הלא-קשור. זה בדיוק המקרה שקודקס הצביע עליו, ולמה `title` ייחודי עדיף על "מזהה חדש שהופיע".
4. **מבחן timeout** — Dokploy API "תקוע" ב-`running` לנצח, מוודא ש-`waitForTitledDeployment` חוזר `ok:false` אחרי ה-timeout, לא נתקע לנצח.
5. **מבחן retry** — mock ש-clone נכשל פעם ראשונה עם ההודעה המדויקת שראינו, מצליח בשנייה — מוודא שהתוצאה הסופית `ok:true` והניסיון החוזר קרה בפועל. מקרה נגדי: שגיאה שלא תואמת את הדפוס הידוע (למשל "401 Unauthorized" גנרי) — מוודא ש**אין** retry אוטומטי, מדווח ככשל מיידי.
6. **לא לרוץ בפועל מול Dokploy אמיתי בבדיקות אוטומטיות** — רק mock. אימות מול Dokploy אמיתי (curl ידני לבדיקת שמות שדות) הוא שלב נפרד לפני המימוש, לא חלק מסוויטת הבדיקות.

## מה לא כלול (מפורש)

- **§2.1 לא נוגעים** — כבר תקין, מאומת. (מומלץ לעדכן את `post-campaign-fixes-2026-09-01.md` בנפרד לשקף שזה סגור, לא חלק מהמשימה הזו.)
- **קיצור `FLOW_RECOVERY_WINDOW_MS` מ-24 שעות** — לא חלק מהתיקון הזה. התיקון ב-A הופך את העלות לבלתי-תלויה בכמות הרשומות שנצברות, כך שאין עוד צורך "לקצר את החלון כדי שהמערכת תישאר מהירה" — 24 שעות יכולות להישאר כמות שהן. אם בעתיד ירצו לקצר מסיבה מוצרית (לא ביצועית), זו החלטה נפרדת.
- **הקמפיין הבא** — התיקון הזה לא חוסם התחלת קמפיין; הוא מקטין עוד יותר את הזנב הארוך שכבר טופל ברובו ב-B2-1/flush().

## סטטוס שאלות פתוחות — כולן נסגרו בסבב 2

1. ~~נתיב כתיבה נוסף ל-`this.map`?~~ **נסגר** — קודקס אישר שאין נתיב נוסף מלבד השישה שכבר מכוסים.
2. ~~דרך טובה יותר לבדוק סנכרון אינדקס?~~ **נסגר** — השוואה ל-scan מלא כ-oracle היא בדיוק הדרך הנכונה, אושר.
3. ~~האם "עדכן תצורה לכולם" צריך להיות כפתור נפרד?~~ **נסגר** — כן, נוסף כ-B.3.
4. ~~מי מאמת את שמות שדות ה-API של Dokploy?~~ **נסגר** — אומת בפועל: `GET /api/deployment.all?applicationId=...`, שדות `deploymentId`/`title`/`description`/`status`/`createdAt`/`startedAt`/`finishedAt`/`errorMessage`. שולב ב-B.1.

**התוכנית מאושרת לביצוע.** אין שאלות פתוחות נותרות — מוכנה לפרומפט מימוש.
