'use strict';
// Gateway vs client, message by message, for one client's FULL logs. Joins on the wamid of every inbound message.
//   node scripts/compare-gateway-client.js <client-log> <gateway-log> [clientIdPrefix=4b004adb] [launchIsoUtc=2026-10-17T16:35:00Z]
const fs = require('fs');
const CLIENT_LOG = process.argv[2]; const GATEWAY_LOG = process.argv[3];
const CLIENT_ID = process.argv[4] || '4b004adb';
const LAUNCH = Date.parse(process.argv[5] || '2026-10-17T16:35:00Z');
if (!CLIENT_LOG || !GATEWAY_LOG) { console.error('usage: node scripts/compare-gateway-client.js <client-log> <gateway-log> [clientIdPrefix] [launchIsoUtc]'); process.exit(2); }
const NL = String.fromCharCode(10), CR = String.fromCharCode(13);
const readLines = (f) => fs.readFileSync(f, 'utf8').split(NL).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));
const CL = readLines(CLIENT_LOG), GW = readLines(GATEWAY_LOG);
const TESTERS = new Set((process.env.TEST_PHONES || '972504213243,972583226413,972586100142').split(','));   // override with TEST_PHONES
const T = (l) => new Date(l.slice(0, 30)).getTime();
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const out = []; const P = (s = '') => { out.push(s); console.log(s); };
const row = (label, a) => P(label.padEnd(34) + String(a.length).padStart(6) + String(q(a, 0.5)).padStart(9) + String(q(a, 0.9)).padStart(9) + String(q(a, 0.99)).padStart(9) + String(a.length ? Math.max(...a) : null).padStart(9));
const head = () => P('                                      n      p50      p90      p99      max   (ms)');

// ------------------------------------------------------------------ parse
const gwIn = new Map();   // wamid -> {t, phone, type}
const gwOut = new Map();  // wamid -> t   (ROUTED to this client)
for (const l of GW) {
  if (l.length < 31) continue; let m;
  if ((m = /\[META_GATEWAY_INBOUND\] (\S+) (\d+) type=(\w+)/.exec(l))) gwIn.set(m[1], { t: T(l), phone: m[2], type: m[3] });
  if ((m = /\[META_GATEWAY_ROUTED\] (\S+) (\S+)/.exec(l)) && m[2].startsWith(CLIENT_ID)) gwOut.set(m[1], T(l));
}
const clientIn = new Map(); const sends = new Map(); const sentSeen = new Set();
for (const l of CL) {
  if (l.length < 31) continue; let m; const t = T(l);
  if ((m = /\[META_INBOUND\] (\S+) (\d+) /.exec(l))) clientIn.set(m[1], { t, phone: m[2] });
  if ((m = /\[META_DELIVERY\] to=whatsapp:(\d+) wamid=(\S+) status=sent/.exec(l)) && !sentSeen.has(m[2])) { sentSeen.add(m[2]); if (!sends.has(m[1])) sends.set(m[1], []); sends.get(m[1]).push(t); }
}
for (const a of sends.values()) a.sort((x, y) => x - y);

// ------------------------------------------------------------------ 1. reconciliation: did every routed message arrive?
const routed = [...gwOut.keys()].filter((w) => gwIn.has(w) && gwIn.get(w).t >= LAUNCH && !TESTERS.has(gwIn.get(w).phone));
const arrived = routed.filter((w) => clientIn.has(w));
const missing = routed.filter((w) => !clientIn.has(w));
const clientOnly = [...clientIn.keys()].filter((w) => clientIn.get(w).t >= LAUNCH && !TESTERS.has(clientIn.get(w).phone) && !gwOut.has(w));
P('==================== 1. התאמת ספירות: שער מול לקוחה ====================');
P('הודעות נכנסות שהשער ניתב ללקוחה מאז ההשקה:   ' + routed.length);
P('מתוכן הלקוחה רשמה קבלה (אותו wamid):          ' + arrived.length);
P('נותבו ולא נרשמו אצל הלקוחה:                  ' + missing.length);
P('נרשמו אצל הלקוחה בלי שורת ניתוב בשער:        ' + clientOnly.length);
if (missing.length) { const lastGw = Math.max(...[...gwIn.values()].map((x) => x.t)); P('   (ייתכן שאלה הודעות שהגיעו ברגעים האחרונים של הלוג) — הכי מאוחרת: ' + new Date(Math.max(...missing.map((w) => gwIn.get(w).t))).toISOString() + ' | סוף לוג שער: ' + new Date(lastGw).toISOString()); }

// ------------------------------------------------------------------ per-message legs
const trigNth = new Map();
const msgs = [];
for (const w of arrived) {
  const i = gwIn.get(w); const o = gwOut.get(w); const c = clientIn.get(w);
  const s = (sends.get(i.phone) || []).find((t) => t >= c.t);
  const isTrigger = i.type === 'text';
  msgs.push({ w, phone: i.phone, type: i.type, isTrigger, tIn: i.t, gw: o - i.t, queue: c.t - o, work: s ? s - c.t : null, total: s ? s - i.t : null });
}
msgs.sort((a, b) => a.tIn - b.tIn);
for (const m of msgs) if (m.isTrigger) { m.nth = (trigNth.get(m.phone) || 0) + 1; trigNth.set(m.phone, m.nth); }
const firstTrig = msgs.filter((m) => m.isTrigger && m.nth === 1);
const repTrig = msgs.filter((m) => m.isTrigger && m.nth > 1);
const answers = msgs.filter((m) => !m.isTrigger);

P('');
P('==================== 2. טבלת זמנים: כל שלב בדרך (מרגע שה-webhook הגיע לשער) ====================');
P('שלבים:  שער = קבלה ← ניתוב ← העברה ללקוחה | תור לקוחה = ההעברה הסתיימה ← הלקוחה התחילה לעבד | עבודה = עיבוד ← ההודעה הבאה התקבלה ב-Meta');
for (const [label, set] of [['טריגר ראשון של משתתפת', firstTrig], ['טריגר חוזר', repTrig], ['תשובה / לחיצה על כפתור', answers]]) {
  P('');
  P('--- ' + label + ' (' + set.length + ' הודעות) ---');
  head();
  row('שער (קבלה ← הועברה)', set.map((m) => m.gw));
  row('תור לקוחה (הועברה ← התחילה)', set.map((m) => m.queue));
  row('עבודה בלקוחה (← הודעה הבאה ב-Meta)', set.filter((m) => m.work !== null).map((m) => m.work));
  row('סה"כ מהגעה לשער', set.filter((m) => m.total !== null).map((m) => m.total));
}

// ------------------------------------------------------------------ 3. by hour
P('');
P('==================== 3. לפי שעה (שעון ישראל): טריגרים ראשונים ====================');
P('שעה     הודעות(כל הסוגים)  טריגרים  שער p50/p99   תור-לקוחה p50/p99   עבודה p50/p99   סה"כ p50/p90/max');
const il = (t) => new Date(t + 3 * 3600e3).toISOString();
const byHour = new Map();
for (const m of msgs) { const d = il(m.tIn); const k = d.slice(5, 10) + ' ' + d.slice(11, 13) + ':00'; if (!byHour.has(k)) byHour.set(k, []); byHour.get(k).push(m); }
for (const [k, set] of [...byHour.entries()].sort()) {
  const f = set.filter((m) => m.isTrigger && m.nth === 1);
  if (!f.length) { P(k + '   ' + String(set.length).padStart(8) + '           0'); continue; }
  const tot = f.filter((m) => m.total !== null).map((m) => m.total);
  P(k + '   ' + String(set.length).padStart(8) + String(f.length).padStart(14) + '    ' + (q(f.map((m) => m.gw), 0.5) + '/' + q(f.map((m) => m.gw), 0.99)).padEnd(12) + (q(f.map((m) => m.queue), 0.5) + '/' + q(f.map((m) => m.queue), 0.99)).padEnd(18) + (q(f.filter((m) => m.work !== null).map((m) => m.work), 0.5) + '/' + q(f.filter((m) => m.work !== null).map((m) => m.work), 0.99)).padEnd(14) + q(tot, 0.5) + '/' + q(tot, 0.9) + '/' + Math.max(...tot));
}

// ------------------------------------------------------------------ 4. slow messages
P('');
P('==================== 4. הודעות איטיות (תור-לקוחה מעל 3 שניות) ====================');
const slow = msgs.filter((m) => m.queue > 3000);
const cls = (m) => (m.isTrigger ? (m.nth > 1 ? 'טריגר חוזר' : 'טריגר ראשון') : 'תשובה');
const by = {}; for (const m of slow) by[cls(m)] = (by[cls(m)] || 0) + 1;
P('סה"כ ' + slow.length + ' מתוך ' + msgs.length + ' (' + (slow.length / msgs.length * 100).toFixed(1) + '%) | לפי סוג: ' + JSON.stringify(by));
const prevWithin = (m) => msgs.some((x) => x.phone === m.phone && x.tIn < m.tIn && m.tIn - x.tIn < 40000);
P('עם הודעה קודמת מאותה משתתפת ב-40 השניות שלפני: ' + slow.filter(prevWithin).length + ' מתוך ' + slow.length);
const allWithPrev = msgs.filter(prevWithin).length;
P('(בקרה: ' + Math.round(allWithPrev / msgs.length * 100) + '% מכל ההודעות הן כאלה, ולכן זה לא מבדיל בפני עצמו)');
P('טריגרים ראשונים איטיים: ' + slow.filter((m) => m.isTrigger && m.nth === 1).length + ' מתוך ' + firstTrig.length);
P('טריגרים חוזרים איטיים:  ' + slow.filter((m) => m.isTrigger && m.nth > 1).length + ' מתוך ' + repTrig.length);
P('תשובות איטיות:          ' + slow.filter((m) => !m.isTrigger).length + ' מתוך ' + answers.length);
P('');
P('15 האיטיות ביותר:');
for (const m of slow.sort((a, b) => b.queue - a.queue).slice(0, 15)) P('  ' + il(m.tIn).slice(5, 19).replace('T', ' ') + '  ' + cls(m).padEnd(12) + ' תור-לקוחה ' + String(m.queue).padStart(6) + 'ms   שער ' + String(m.gw).padStart(5) + 'ms');

// ------------------------------------------------------------------ 5. gateway-only view for all clients (context)
const gwAllRoute = GW.filter((l) => l.length > 31 && T(l) >= LAUNCH && /route_ms=/.test(l)).map((l) => Number((/route_ms=(\d+)/.exec(l) || [0, 0])[1]));
P('');
P('==================== 5. הקשר: ניתוב בשער לכל הלקוחות ====================');
head(); row('route_ms (כל הלקוחות)', gwAllRoute);
const allIn = [...gwIn.values()].filter((x) => x.t >= LAUNCH).length;
P('הודעות נכנסות לשער בסך הכול מאז ההשקה: ' + allIn + ' | מתוכן ללקוחה הזו: ' + routed.length + ' (' + Math.round(routed.length / allIn * 100) + '%)');

fs.writeFileSync(CLIENT_LOG.replace(/\.txt$/, '') + '.gateway-vs-client.txt', out.join(NL));
