# תוכנית טכנית — בטיחות, מהירות, פריסה

נכתב ב-02/09/2026, אחרי פריסת התיקונים ל-B2-1/`flush()` (ר' `docs/flush-transaction-fix-results-2026-09-02.md`
ו-`docs/campaign-scale-load-test-results-2026-09-02.md`) ואחרי לוג בנייה קרה אמיתי שאושש את ניתוח הבנייה
של קודקס במדויק.

מסמך זה ממתין לסקירת קודקס לפני מימוש. שום שינוי לא בוצע עדיין.

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

### א.1 — מטפל SIGTERM (F2) — הכי דחוף בתוכנית הזו

**הבעיה:** `src/index.ts:23-25` — רק `unhandledRejection`. אפס `SIGTERM`/`SIGINT` בכל `src/`. כל דיפלוי הורג
את התהליך מיד, באמצע כתיבות אפשריות. אם SIGTERM מגיע בין שליחת הודעה ל-`flush()`, אחרי restart המשתתף
מקבל את אותו שלב **פעמיים**.

**מכשול טכני:** `startAdminServer(storage: Storage): void` (`adminServer.ts:1244`) לא מחזיר את ה-`http.Server`,
ו-`app.listen(...)` (`adminServer.ts:4433`) פאייר-אנד-פורגט. אי אפשר לסגור אותו נקי בלי שינוי.

**התיקון המוצע:**

```ts
// adminServer.ts
export function startAdminServer(storage: Storage): http.Server {
  // ... כל הקוד הקיים ללא שינוי ...
  return app.listen(config.ADMIN_PORT, () => {
    console.log(`🖥️  Admin dashboard → http://localhost:${config.ADMIN_PORT}`);
  });
}
```

```ts
// index.ts, בתוך main(), אחרי startAdminServer:
const server = startAdminServer(storage);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, draining…`);
  server.close(); // מפסיק לקבל בקשות חדשות
  const forceExit = setTimeout(() => {
    console.error('Shutdown grace period exceeded, forcing exit.');
    process.exit(1);
  }, 8_000);
  forceExit.unref();
  try {
    await storage.flush();
  } catch (err) {
    console.error('flush() on shutdown failed:', err);
  }
  try {
    await storage.close();
  } catch { /* already logged inside flush/close */ }
  clearTimeout(forceExit);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

**שאלות לקודקס:**
1. `storage.flush()` עכשיו scoped ל-generation (אחרי תיקון היום) — האם זה מספיק ל-shutdown, או שצריך את
   אותה סמנטיקת "שקט מלא" ש-`backend.close()` כבר עושה? (`storage.close()` קורא ל-`backend?.close()`,
   וזה כבר עושה שקט מלא — כנראה מספיק, לא צריך `flush()` נפרד לפניו.)
2. 8 שניות grace — מספיק? Dokploy נותן כמה זמן בין SIGTERM ל-SIGKILL בפועל? (לא נראה מהריפו, תלוי
   בהגדרת הפלטפורמה.)
3. `startContactSaveQueue`/`startOutboxDispatcher`/`startServiceBotFollowUpDispatcher` (`index.ts:96-98`) —
   האם יש להם עבודה בטיסה שצריך לעצור בצורה מסודרת, או שמספיק ש-`storage.close()` מכסה את כל מה שהם כותבים?

**בדיקות מתוכננות:** תרחיש שמדמה SIGTERM באמצע `sendTrackedOutboxMessage` (בין `send()` ל-`markOutboxSent`+
`flush()`) — לוודא: (א) אחרי restart אין כפילות שליחה, (ב) `server.close()` באמת חוסם בקשות חדשות,
(ג) timeout הכפוי עובד אם `flush()` נתקע.

**סיכון:** נמוך-בינוני. שינוי מבנה קטן (טיפוס החזרה), התנהגות חדשה רק ב-SIGTERM/SIGINT.

---

### א.2 — `HEALTHCHECK` ב-Dockerfile (F4-1)

**הבעיה:** אפס `HEALTHCHECK` ב-`Dockerfile`. Dokploy/Traefik לא יודעים להבדיל בין קונטיינר חי לתקוע —
זה חלק מהמקור ל-502 שראינו.

**התיקון המוצע:**

```dockerfile
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
```

**בעיה נלווית:** `/health` היום עושה עבודה לא-טריוויאלית (`getCampaigns()`+5 filters, `getContactQueueStats()`,
`getFailedDeliveries(100)` — `adminServer.ts:1415-1444`). תחת event loop עמוס, ה-HEALTHCHECK עצמו יכול
להיתקע מאחורי אותה עבודה. מוצע `/health/live` נפרד וזול (מחזיר 200 בלי לגעת ב-storage) לשימוש
ה-HEALTHCHECK/פרוקסי, ולהשאיר את `/health` הכבד לדשבורד בלבד.

**שאלה לקודקס:** `start-period=40s` — מספיק? זמן העלייה כולל `applyMigrations` + `loadSnapshot` (יכול
לסרוק ~13 טבלאות בקנה מידה גדול).

**סיכון:** נמוך. שינוי metadata של ה-image + endpoint חדש קריא-בלבד.

---

### א.3 — זמן בנייה: הסרת Chromium + `npm ci` כפול (F1)

**תיקונים עצמאיים, סיכון נמוך, לא נוגעים ב-Meta/Baileys split:**

1. **`npm ci` כפול** (`Dockerfile:6`, `Dockerfile:29`) → להעתיק `node_modules` מה-builder ולגזום:
   ```dockerfile
   COPY --from=builder /app/node_modules ./node_modules
   RUN npm prune --omit=dev
   ```
   חוסך ~55 שניות. סיכון: `npm prune` פחות דטרמיניסטי מ-`npm ci` — קודקס, יש העדפה בין זה לבין
   `npm ci --omit=dev` עם `--mount=type=cache`?

2. **`COPY . .` לפני `npm run build`** (`Dockerfile:7`) — מבטל cache בכל שינוי קובץ, כולל `docs/`.
   להעתיק ממוקד:
   ```dockerfile
   COPY tsconfig.json ./
   COPY src ./src
   RUN npm run build
   ```

**התיקון המהותי (Chromium) — קודקס אמר במפורש לא לגעת בו תוך כדי קמפיין, ולבדוק כמו-שצריך:**

3. **הסרת Chromium מ-Meta-only images.** `BAILEYS_FALLBACK_TO_WEBJS=false` קשיח בכל לקוח Meta
   (`dokployProvisioner.ts:395`) — אף לקוח קיים לא יכול להגיע לקוד ש-Chromium נחוץ לו. חוסך ~135 שניות
   ו-759MB.

**שאלה מרכזית לקודקס:** מה המנגנון הנכון — build arg יחיד ב-Dockerfile אחד (`ARG INCLUDE_CHROMIUM=true`,
עם `RUN if [ "$INCLUDE_CHROMIUM" = "true" ]; then apt-get install...; fi`), או שני Dockerfiles נפרדים
לגמרי (`Dockerfile.meta`, `Dockerfile.baileys`)? Docker לא תומך ב-conditional `COPY`/multi-stage בקלות עם
ARG בודד — צריך תבנית מדויקת. `dokployProvisioner.ts` יצטרך להעביר את הפרמטר/לבחור קובץ בזמן
`application.create`/`saveBuildType`.

**סיכון:** בינוני — נוגע בתשתית ההקמה עצמה, לא רק בקוד ריצה. **לא לבצע תוך כדי הקמפיין הנוכחי**, גם אם אין
קמפיין גדול השבוע — קודקס ביקש בדיקה מסודרת קודם.

---

## חלק ב׳ — בטיחות

### ב.1 — `META_APP_SECRET` לא נדרש בהקמת לקוח Meta (G2-1)

**הבעיה:** `dokployProvisioner.ts:488-497` — `assertClientProvisioningConfig` דורש 4 שדות Meta אבל **לא**
`metaAppSecret`. בלעדיו, אימות חתימת `X-Hub-Signature-256` על ה-webhook כבוי — כל גורם שמכיר את כתובת
ה-webhook יכול להזריק הודעות מזויפות.

**התיקון המוצע:**

```ts
const missing = [
  !this.config?.metaAccessToken && 'DOKPLOY_META_ACCESS_TOKEN',
  !this.config?.metaPhoneNumberId && 'DOKPLOY_META_PHONE_NUMBER_ID',
  !this.config?.metaDisplayPhoneNumber && 'DOKPLOY_META_DISPLAY_PHONE_NUMBER',
  !this.config?.metaVerifyToken && 'DOKPLOY_META_VERIFY_TOKEN',
  !this.config?.metaAppSecret && 'DOKPLOY_META_APP_SECRET', // חדש
].filter(Boolean);
```

**שאלה לקודקס:** יש לקוחות **קיימים** שכבר הוקמו בלי `metaAppSecret`? אם כן, זה לא ישפיע עליהם (רק על
הקמות עתידיות) — צריך תוכנית נפרדת לאתר ולתקן לקוחות קיימים חשופים (`grep` על env בפועל, לא בריפו).

**סיכון:** נמוך — רק מוסיף דרישת ולידציה, לא משנה זרימה קיימת. לא נוגע בלקוח פעיל.

### ב.2 — מחיקה/עריכת קמפיין לא מנקה שיחות פעילות (A4-1)

**הבעיה:** `DELETE /api/campaigns/:id` (`adminServer.ts:4365-4368`) ו-`PUT /api/campaigns/:id`
(`adminServer.ts:4285`) לא קוראים `conversationState.removeByCampaign` — בניגוד ל-
`/api/campaign-results/:id/reset` שכן קורא. שיחה פעילה ממשיכה לרוץ על קמפיין מחוק/ערוך עד ה-restart הבא.

**התיקון המוצע:**

```ts
app.delete('/api/campaigns/:id', requireWritableClient, (req, res) => {
  const id = String(req.params.id);
  conversationState.removeByCampaign(id); // חדש
  const ok = storage.deleteCampaign(id);
  res.json({ ok });
});
```

עבור `PUT` — רק כשהודעת `conversation.decisionFlow` משתנה בפועל (לא בכל עריכה, כדי לא לנתק שיחות בגלל
שינוי טקסט לא-קשור). שאלה לקודקס: איך להשוות "flow השתנה מהותית" בלי false positive על שינויי ניסוח?

**סיכון:** נמוך — `removeByCampaign` כבר קיים ובשימוש במקום אחר.

### ב.3 — `conversation-state.json` נכתב לא-אטומית (B4-1)

**הבעיה:** `conversationState.ts:392` — `fs.writeFileSync` ישיר, בלי temp+rename, בלי `.bak`. קריסה
באמצע כתיבה = כל השיחות הממתינות אובדות באותו restart.

**התיקון המוצע** (תואם ל-`storage.ts`/`metaGatewayInbox.ts` שכבר עושים נכון):

```ts
const tempPath = `${this.filePath}.tmp`;
fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf-8');
if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
fs.renameSync(tempPath, this.filePath);
```

**שאלה לקודקס:** במצב Postgres, `restore()` קורא קודם מ-`backend.loadConversationStateSnapshot()` — הקובץ
הוא רק גיבוי משני. עדיף לתקן את הכתיבה עצמה (למעלה), או לדלג על כתיבת הקובץ לגמרי במצב Postgres
(המקור-אמת הוא הטבלה)?

**סיכון:** נמוך.

---

## חלק ג׳ — מהירות (כבר מתועד, קישור בלבד — לא לפרט שוב)

אלה כבר מפורטים במלואם ב-`docs/post-campaign-fixes-2026-09-01.md` ולא אכפיל כאן:

- **1.6** `FILE_DELIVERY_WAIT_TIMEOUT_MS=20s` — אומת בפועל (9 מקרים בשעה).
- **2.2 / G3-2** `FLOW_RECOVERY_WINDOW_MS=24h` — מנוע ההצטברות.
- **2.1** `campaignEvents`/`campaignResults` — הטבלאות הגדולות.
- **A5-1** לקוח אחד עמוס מפיל ניתוב לכל 4 הלקוחות.
- **עדיפות 0.6, שלב 3** גיזום outbox מודע-סטטוס.

---

## סדר ביצוע מוצע

1. **א.1 (SIGTERM)** — הכי דחוף, סיכון נמוך-בינוני, לא תלוי בכלום.
2. **ב.1 (META_APP_SECRET)** — שורה אחת, אבטחה.
3. **ב.2 (A4-1)** — קטן, נכונות.
4. **א.2 (HEALTHCHECK)** — metadata בלבד.
5. **ב.3 (B4-1)** — קטן.
6. **א.3 (npm ci כפול + COPY ממוקד)** — שני שינויים עצמאיים ב-Dockerfile, בטוחים.
7. **א.3 (Chromium/Meta-Baileys split)** — **בנפרד, אחרי בדיקה מסודרת, לא תוך כדי שום קמפיין** — כפי
   שקודקס ביקש.

---

## סטטוס

**ממתין לסקירת קודקס. לא בוצע שינוי קוד, לא בוצעה פריסה.**
