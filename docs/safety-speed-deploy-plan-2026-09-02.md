# תוכנית טכנית — בטיחות, מהירות, פריסה

נכתב ב-02/09/2026, אחרי פריסת התיקונים ל-B2-1/`flush()` (ר' `docs/flush-transaction-fix-results-2026-09-02.md`
ו-`docs/campaign-scale-load-test-results-2026-09-02.md`) ואחרי לוג בנייה קרה אמיתי שאושש את ניתוח הבנייה
של קודקס במדויק. **עודכן אחרי סקירה שנייה של קודקס — כל התיקונים שלו אומתו מול הקוד ושולבו.**

מסמך זה ממתין לביצוע בפועל. שום שינוי קוד לא בוצע עדיין, שום פריסה.

## אישור מהלוג האמיתי

לוג בנייה קרה (ללא Docker cache) על `client-account-be61c10f`:

| שלב | זמן נמדד |
|---|---|
| Chromium + תלויות מערכת | 134.9s |
| `npm ci` (builder) | 137.3s |
| `tsc` | 40.8s |
| `npm ci --omit=dev` (runtime) | 54.6s |
| export image | 11.9s |
| **סה"כ** | **~6.5 דקות** |

---

## חלק א׳ — פריסה

### א.1 — מטפל SIGTERM (F2) — עודכן, יש חורים נוספים שצריך לסגור

**הבעיה:** `src/index.ts:23-25` — רק `unhandledRejection`. אפס `SIGTERM`/`SIGINT` בכל `src/`. כל דיפלוי הורג
את התהליך מיד, באמצע כתיבות אפשריות.

**מכשול טכני:** `startAdminServer(storage: Storage): void` (`adminServer.ts:1244`) לא מחזיר את ה-`http.Server`.

**מה שנוסף בסקירה השנייה — שלושה workers רצים ברקע ולא נעצרים:**

| worker | קובץ | מנגנון עצירה היום |
|---|---|---|
| `startContactSaveQueue` | `contactQueue.ts:55` | **אין בכלל** — `while (true)` אינסופי, אין דגל עצירה |
| `startOutboxDispatcher` | `outboxDispatcher.ts:81` | מחזיר `NodeJS.Timeout` — אפשר `clearInterval`, אבל לא מחכה ל-tick שרץ עכשיו |
| `startServiceBotFollowUpDispatcher` | `serviceBotFollowUpDispatcher.ts:9` | אותו דבר — `clearInterval` בלבד |

אם `storage.close()` נקרא בזמן שאחד מהם באמצע כתיבה, הוא עלול לכתוב אחרי הסגירה או להיכשל מול pool סגור.
`server.close()` גם לא ממתין בפועל — הוא callback-based, וקריאה בלי `await`/Promise משמעה שיכול להיות
request פעיל שממשיך בזמן שה-storage כבר נסגר.

**התיקון המוצע (מעודכן):**

```ts
// contactQueue.ts
let stopping = false;
export function startContactSaveQueue(storage: Storage): { stop: () => Promise<void> } {
  if (workerStarted) return { stop: async () => {} };
  workerStarted = true;
  let currentIteration: Promise<void> = Promise.resolve();

  const loop = (async () => {
    console.log('   Contact queue worker started.');
    while (!stopping) {
      const job = storage.getDueContactSaveJob(new Date(), { includeGoogle: isGoogleConnected() });
      if (!job) { await sleep(IDLE_DELAY_MS); continue; }
      currentIteration = processOne(storage, job);
      await currentIteration;
      await sleep(SUCCESS_DELAY_MS);
    }
  })();

  return { stop: async () => { stopping = true; await loop; } };
}
```

`startOutboxDispatcher`/`startServiceBotFollowUpDispatcher` — אותו דפוס: `clearInterval(handle)` +
דגל `stopping` שנבדק גם בתוך `tick()` הנוכחי, ולהחזיר `{ stop }` שמחכה ל-tick האחרון שכבר רץ.

```ts
// index.ts
const server = startAdminServer(storage);
const contactQueue = startContactSaveQueue(storage);
const outbox = startOutboxDispatcher(storage, currentOutboundTransport);
const followUps = startServiceBotFollowUpDispatcher(storage, currentOutboundTransport);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, draining…`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown grace period exceeded, forcing exit.');
    process.exit(1);
  }, 22_000); // ר' סעיף א.1.1 למטה - לא 8 שניות
  forceExit.unref();

  // 1. להפסיק לקבל בקשות/עבודה חדשה - HTTP קודם, לא storage
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // 2. לעצור workers ולחכות לעבודה שכבר בטיסה
  await Promise.all([contactQueue.stop(), outbox.stop(), followUps.stop()]);
  // 3. רק עכשיו לסגור את ה-storage - הוא כבר מנקז שקט מלא (backend.close())
  try {
    await storage.close();
  } catch (err) {
    console.error('storage.close() on shutdown failed:', err);
  }

  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

**אושר בסקירה:** `storage.flush()` נפרד **לא נדרש** לפני `storage.close()` — `close()` כבר קורא
`backend?.close()` שעושה שקט מלא (המתנה ל-`draining || queuedSnapshot`), לא ה-flush החדש ה-scoped.

**חשוב לדייק בציפייה, כפי שקודקס ציין:** shutdown מסודר **מקטין משמעותית** כפילויות, אבל **לא מבטיח אפס**
כפילויות בין שליחת HTTP בפועל ל-Meta לבין שמירת אישור השליחה — זו בעיית exactly-once קלאסית, ובלי
idempotency בצד Meta עצמו אי אפשר להבטיח אותה לחלוטין. `sendTrackedOutboxMessage` כבר עושה `flush()`
לפני השליחה (שומר את הבקשה כ-`processing`), אז החלון הפתוח הוא רק בין `send()` בפועל ל-`markOutboxSent`+
`flush()` שאחריו — קצר, לא אפס.

#### א.1.1 — grace period: 20-25 שניות, לא 8

**הבעיה עם 8 שניות:** אין בריפו את זמן ה-SIGKILL בפועל של Dokploy. 8 שניות עלול לקטוע `flush()`/`close()`
בדיוק כשהם מגנים על נתונים.

**התיקון:** timeout כפוי באפליקציה של **20-22 שניות**. **תלוי בהגדרת Dokploy** — אם ה-grace period שם קצר
מ-20 שניות, ה-timeout הפנימי לא עוזר (SIGKILL יגיע קודם בכל מקרה). צריך לבדוק/להגדיר ב-Dokploy grace period
של **לפחות 30 שניות** לפני שמסתמכים על זה.

**שאלה פתוחה לביצוע:** האם יש גישה להגדרות ה-stop grace period של Dokploy (docker-compose `stop_grace_period`
המקביל, אם קיים בממשק)? אם לא, לתעד את המגבלה בפירוש בקוד/תיעוד.

**בדיקות מתוכננות:** תרחיש SIGTERM באמצע `sendTrackedOutboxMessage`, worker `outboxDispatcher` באמצע tick,
`server.close()` עם בקשה פעילה — לוודא סדר הסגירה (HTTP → workers → storage) נשמר ולא מתהפך.

**סיכון:** נמוך-בינוני. שינוי מבנה (טיפוסי החזרה של שלושת ה-`start*`), התנהגות חדשה רק ב-SIGTERM/SIGINT.

---

### א.2 — `HEALTHCHECK` ב-Dockerfile (F4-1) — `start-period` עודכן

**הבעיה:** אפס `HEALTHCHECK`. Dokploy/Traefik לא יודעים להבדיל בין קונטיינר חי לתקוע.

**התיקון:**

```dockerfile
HEALTHCHECK --interval=15s --timeout=5s --start-period=100s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
```

**`/health/live` נפרד וזול** — מחזיר `200` בלי לגעת ב-storage, למניעת מצב שה-HEALTHCHECK עצמו נתקע מאחורי
עבודת `/health` הכבד (`getCampaigns()`+5 filters, `getContactQueueStats()`, `getFailedDeliveries(100)`).

**עודכן: `start-period=100s`, לא 40s.** לפי הסקירה — 40 שניות אופטימי מדי לפני שנמדדת עלייה אמיתית עם DB
גדול (`applyMigrations` + `loadSnapshot` על ~13 טבלאות). **לחזור ולכייל אחרי מדידה אמיתית** בפריסה הבאה
(לוג הזמן בפועל בין boot ל-`storage.ready`).

**תנאי חובה לפני שממשיכים:** **לוודא ש-Dokploy/Swarm בפועל משתמשים ב-HEALTHCHECK לניתוב תעבורה/rolling
replace** — אחרת זו רק אינדיקציה תפעולית (רואים "unhealthy" בממשק) ולא מנגנון שמונע 502 בפועל. לבדוק בממשק
Dokploy (Deploy Settings) אם יש אפשרות rolling/health-gated deploy, לפני שמניחים שההוספה פותרת את ה-502.

**סיכון:** נמוך. שינוי metadata + endpoint חדש קריא-בלבד.

---

### א.3 — זמן בנייה (F1) — תוקן: `docs/` כבר מוחרג, `npm prune` נדחה

**תיקון עובדתי:** `.dockerignore` **כבר** כולל `docs/` בשורה האחרונה — `COPY . .` **לא** מבטל cache בגלל
שינויי תיעוד כפי שכתבתי קודם. זה תוקן. `COPY . .` עדיין מעתיק קבצים אחרים לא-מוחרגים ברמת השורש
(`.migration/`, קבצי `.md` ברמת השורש כמו `META_API_SETUP.md`, `.tmp-*`) — העתקה ממוקדת (`tsconfig.json`+`src`)
עדיין משפרת cache locality, אבל בעדיפות **נמוכה יותר** ממה שהוצג קודם, לא תיקון דחוף.

**`npm ci` כפול — ההמלצה השתנתה: להשאיר `npm ci --omit=dev`, לא לעבור ל-`npm prune`.** קודקס: `npm prune`
פחות דטרמיניסטי. אופציה עתידית: cache של npm ב-BuildKit (`--mount=type=cache,target=/root/.npm`) — זו
אופטימיזציה, לא תיקון דחוף, ודורשת בדיקה נפרדת (תלוי אם Dokploy/הבילדר תומכים ב-BuildKit cache mounts).

**Chromium — נשאר הפריט המהותי, אבל המנגנון הוכרע:**

**מנגנון: Dockerfile אחד עם Build Arg, לא שני Dockerfiles נפרדים.**

```dockerfile
ARG INCLUDE_CHROMIUM=true

# ...

RUN if [ "$INCLUDE_CHROMIUM" = "true" ]; then \
      apt-get update && apt-get install -y \
        chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-freefont-ttf \
        --no-install-recommends && rm -rf /var/lib/apt/lists/*; \
    fi
```

**ברירת המחדל חייבת להיות `true`** — כדי לא לסכן לקוחות Baileys קיימים שממשיכים לצפות ל-Chromium.
**רק שירותי Meta מאומתים** (מתועדים/מתויגים בבירור) יקבלו `INCLUDE_CHROMIUM=false` דרך build arg בזמן
`application.create`/`saveBuildType` ב-`dokployProvisioner.ts`. שני Dockerfiles נפרדים נפסלו — סיכון שהם
יסטו זה מזה עם הזמן.

**זה שינוי תשתיתי — לביצוע בנפרד, עם בדיקת Meta מלאה ותוכנית rollback, לא באותה משימה עם שאר הפריטים.**

**סיכון:** בינוני. **לא לבצע תוך כדי קמפיין**.

---

## חלק ב׳ — בטיחות

### ב.1 — אימות חתימת Meta לא קיים בכלל (חמור יותר ממה שתועד קודם)

**זו טעות בגרסה הקודמת של המסמך.** התיקון לא היה "שורה אחת ב-`assertClientProvisioningConfig`" — זה
היה מספיק כדי למנוע **הקמת לקוחות חדשים** בלי secret, אבל **לא הגן על ה-webhook הקיים בכלל**.

**אומת בקוד:** `META_APP_SECRET` נטען לקונפיגורציה (`config.ts:32`) ומועבר ללקוחות חדשים
(`dokployProvisioner.ts:440`) — **אבל אין שום שימוש בו לאימות חתימה בשום מקום בקוד.**
`grep -rn "X-Hub-Signature\|createHmac" src/*.ts` מחזיר רק שימושי Twilio ו-Google — **אפס** התייחסות
ל-Meta. `POST /webhooks/meta/whatsapp` (`adminServer.ts:1940`) מקבל כל בקשה, ללא בדיקה, ישר ל-`enqueue`.

**מכשול נוסף:** `express.json({ limit: '24mb' })` מותקן גלובלית (`adminServer.ts:1260`) **לפני** ה-route,
כלומר ה-body הגולמי **כבר נצרך** ל-JSON עד שההנדלר רץ — אי אפשר לחשב HMAC על גוף שכבר נעלם. חייבים לתפוס
את ה-buffer הגולמי ב-`verify` callback של `express.json`.

**התיקון המלא (3 חלקים, לא אחד):**

1. **תפיסת ה-body הגולמי** — להוסיף `verify` ל-`express.json()` הגלובלי:
   ```ts
   app.use(express.json({
     limit: '24mb',
     verify: (req, _res, buf) => { (req as any).rawBody = buf; },
   }));
   ```

2. **אימות HMAC בשער** — middleware ייעודי על `/webhooks/meta/whatsapp` (ה-route של הגייטווי, שמקבל
   תעבורה ישירות מ-Meta):
   ```ts
   function verifyMetaSignature(req: Request, res: Response, next: NextFunction): void {
     const secret = config.META_APP_SECRET;
     if (!secret) { next(); return; } // ר' סעיף 3 - לא לחייב לפני audit
     const signature = String(req.headers['x-hub-signature-256'] || '');
     const expected = 'sha256=' + crypto.createHmac('sha256', secret)
       .update((req as any).rawBody ?? Buffer.alloc(0)).digest('hex');
     const sigBuf = Buffer.from(signature);
     const expBuf = Buffer.from(expected);
     if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
       res.sendStatus(403);
       return;
     }
     next();
   }
   app.post('/webhooks/meta/whatsapp', verifyMetaSignature, (req, res) => { /* קיים */ });
   ```
   **403 חייב לחזור לפני `enqueue`/ניתוב** — לא אחרי.

3. **Audit לפני החלה מלאה** — לפני שמחייבים את המשתנה בכל מקום (כולל `assertClientProvisioningConfig`
   כמו שכבר תועד), **לבדוק אילו לקוחות קיימים בפועל רצים בלי `META_APP_SECRET` מוגדר** (env אמיתי בכל
   קונטיינר, לא הריפו). אם יש כאלה, אימות ה-HMAC שם יכשל תמיד (403 על כל webhook אמיתי) — צריך תוכנית
   הפצת secret ללקוחות קיימים **לפני** שהאימות הופך לחובה, לא בו-זמנית.

**זה בעדיפות אבטחתית גבוהה יותר מכל שאר הפריטים ברשימה — לבצע ראשון.**

**סיכון:** בינוני — נוגע בנתיב שמקבל תעבורה אמיתית מ-Meta. אימות מוקפד עם הצפנה אמיתית (חתימת בקשת בדיקה
עם ה-secret האמיתי, לוודא שהיא עוברת; חתימה שגויה/חסרה, לוודא 403) לפני כל מגע בלקוח פעיל.

### ב.2 — מחיקת קמפיין — סדר פעולות הפוך

**התיקון המוצע (מתוקן — `deleteCampaign` קודם, לא אחרי):**

```ts
app.delete('/api/campaigns/:id', requireWritableClient, (req, res) => {
  const id = String(req.params.id);
  const ok = storage.deleteCampaign(id);
  if (ok) conversationState.removeByCampaign(id); // רק אם המחיקה הצליחה בפועל
  res.json({ ok });
});
```

**הנימוק:** הסדר הקודם (ניקוי שיחות לפני המחיקה) חשוף למצב שבו המחיקה נכשלת אחרי שכבר ניתקו שיחות פעילות
בלי שהקמפיין באמת נמחק — נזק בלי תועלת.

**עריכת flow — לא לנחש "שינוי מהותי".** במקום היוריסטיקה להשוואת flow, **פעולה מפורשת**: לשמור את העריכה
תמיד, ובמקרה שבו `conversation.decisionFlow` משתנה — להציג למשתמש בחירה מפורשת בממשק ("לסיים שיחות פעילות
של קמפיין זה?") במקום ניתוק שקט. זה דורש גם שינוי UI (`public/index.html`), לא רק API — שאלה פתוחה: להוסיף
לתוכנית הזו או לפריט נפרד?

**סיכון:** נמוך.

### ב.3 — כתיבת קובץ שיחות — עודכן: לא לכל השינויים ב-Postgres mode

**תיקון: לא להוסיף `copyFileSync`+atomic write לכל מעבר שלב ב-Postgres mode.** במצב הזה ה-DB הוא מקור
האמת והקובץ **עותק משני בלבד** — הוספת mirror מלא בכל שינוי מחזירה בדיוק את עלות ה-I/O שכל העבודה של היום
(B2-1, `flush()` לפי generation) נועדה לצמצם.

**ההמלצה המעודכנת, מפוצלת לפי מצב:**

- **במצב JSON** (אין backend Postgres): כתיבה אטומית מלאה (temp+rename), **כן** רלוונטי — זה עדיין המקור-אמת
  היחיד שם.
  ```ts
  const tempPath = `${this.filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  fs.renameSync(tempPath, this.filePath);
  ```
- **במצב Postgres**: **לא** לכתוב mirror מלא בכל שינוי. במקום זה — **fallback מסודר**: לכתוב את הקובץ
  (או `.bak`) **רק בעת תקלה מתועדת** (כשל ב-DB, לא בכל `set()`/`remove()` רגיל), או ברווחי זמן קבועים
  (למשל כל N דקות) במקום סינכרוני על כל מעבר שלב. זה דורש עיצוב נפרד — לא "התאמת אותו קוד" כמו JSON mode.

**שאלה פתוחה לביצוע:** מה התדירות/הטריגר הנכון לכתיבת ה-fallback ב-Postgres mode? (כל N דקות? רק ב-shutdown
מסודר, כחלק מ-א.1? רק כשה-DB לא זמין?)

**סיכון:** נמוך ב-JSON mode. עיצוב חדש (לא רק "אותו תיקון") ב-Postgres mode.

---

## חלק ג׳ — מהירות (כבר מתועד, קישור בלבד — לא לפרט שוב)

אלה כבר מפורטים במלואם ב-`docs/post-campaign-fixes-2026-09-01.md` ולא אכפיל כאן:

- **1.6** `FILE_DELIVERY_WAIT_TIMEOUT_MS=20s` — אומת בפועל (9 מקרים בשעה).
- **2.2 / G3-2** `FLOW_RECOVERY_WINDOW_MS=24h` — מנוע ההצטברות.
- **2.1** `campaignEvents`/`campaignResults` — הטבלאות הגדולות.
- **A5-1** לקוח אחד עמוס מפיל ניתוב לכל 4 הלקוחות.
- **עדיפות 0.6, שלב 3** גיזום outbox מודע-סטטוס.

---

## סדר ביצוע (מעודכן לפי המלצת קודקס)

1. **ב.1 — אימות חתימת Meta** (כולל audit ל-env הקיים) — הכי גבוה בעדיפות אבטחתית.
2. **א.1 — SIGTERM תקין**: עצירת intake (`server.close()` מחכה בפועל), עצירת שלושת ה-workers עם המתנה
   לעבודה בטיסה, ורק אז `storage.close()`. grace period 20-22 שניות + לוודא הגדרת Dokploy.
3. **ב.2 — תיקון מחיקת קמפיין בלבד** (סדר הפוך: מחיקה קודם). עריכת flow עם בחירה מפורשת — להחליט אם באותה
   משימה.
4. **א.2 — `/health/live` + HEALTHCHECK**, **אחרי** בדיקה ש-Dokploy בפועל משתמש בו לניתוב.
5. **ב.3 — atomic write ל-JSON mode בלבד**; תכנון fallback נפרד ל-Postgres mode (לא אותו קוד).
6. **א.3 — אופטימיזציות build קטנות** (COPY ממוקד, בעדיפות נמוכה אחרי שהתברר ש-`docs/` כבר מוחרג).
7. **א.3 — Chromium דרך Build Arg** (`INCLUDE_CHROMIUM`, ברירת מחדל `true`) — **בפריסה נפרדת לגמרי**, אחרי
   שכל השאר יציב.

---

## סטטוס

**ממתין למימוש בפועל. שום שינוי קוד עדיין, שום פריסה.**
