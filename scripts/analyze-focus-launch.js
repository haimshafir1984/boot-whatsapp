'use strict';
const fs = require('fs');
const CLIENT_LOG = process.argv[2] || 'C:/Users/haim/Downloads/focus-FULL-log-20261017.txt';
const GATEWAY_LOG = process.argv[3] || 'C:/Users/haim/Downloads/gateway-FULL-log-20261017.txt';
const OUT_FILE = process.argv[4] || 'C:/Users/haim/Projects/parpar sagol/docs/results-data/focus-launch-analysis-2026-10-17.txt';
const lines = (file) => fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).map((l) => (l.endsWith(String.fromCharCode(13)) ? l.slice(0, -1) : l));
const CL = lines(CLIENT_LOG);
const GW = lines(GATEWAY_LOG);
// Reusable for any campaign client: CAMPAIGN_CLIENT_ID (client id prefix), LAUNCH_DAY (YYYY-MM-DD, day of the first triggers, UTC), TEST_PHONES (comma list)
// override the Focus defaults. Usage: node scripts/analyze-focus-launch.js <client-log> <gateway-log> <out-file>
const FOCUS_ID = process.env.CAMPAIGN_CLIENT_ID || '4b004adb';
const TESTERS = new Set((process.env.TEST_PHONES || '972504213243,972583226413,972586100142').split(','));   // owner / tester / client's own numbers
const T = (l) => new Date(l.slice(0, 30)).getTime();
const hhmm = (t) => new Date(t + 3 * 3600e3).toISOString().slice(11, 16);   // Israel time (UTC+3)
const day = (t) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const st = (a) => a.length ? `n=${a.length} p50=${q(a, .5)} p90=${q(a, .9)} p99=${q(a, .99)} max=${Math.max(...a)}` : 'n=0';
const out = [];
const P = (s = '') => { out.push(s); console.log(s); };

// ---------------------------------------------------------------------------------------- client log
const trig = [];                       // {t, phone, variant, age}
const inbound = new Map();             // wamid -> {t, phone, type, opt}
const sends = new Map();               // phone -> [{t, wamid}]
const sentSeen = new Set();
const invalid = [];                    // {t, phone, step}
const timeouts = [];                   // {t, phone}
const stale = [], fq = [], fdt = [], pgslow = [], dupReply = [], failedStatus = [];
const sendErr = [];
let statusApplied = 0, statusDup = 0, untracked = 0;
for (const l of CL) {
  if (!l || l.length < 31) continue;
  let m; const t = T(l);
  if ((m = /\[MSG\] trigger matched via=\w+ age=(\d+)s campaign="([^"]*)" from=whatsapp:(\d+)/.exec(l))) trig.push({ t, phone: m[3], variant: m[2].replace('פוקוס שירותי משרד לעסקים', '').replace(/^ - /, '') || 'בסיסי', age: Number(m[1]) });
  if ((m = /\[META_INBOUND\] (\S+) (\d+) (\S+)(?: |$)/.exec(l))) {
    const type = /type=interactive/.test(l) ? 'interactive' : /type=text/.test(l) ? 'text' : 'other';
    const opt = /^option-/.test(m[3]) ? m[3] : null;
    inbound.set(m[1], { t, phone: m[2], type, opt });
  }
  if ((m = /\[META_DELIVERY\] to=whatsapp:(\d+) wamid=(\S+) status=(\w+) result=(\w+)/.exec(l))) {
    if (m[3] === 'sent') { if (!sentSeen.has(m[2])) { sentSeen.add(m[2]); if (!sends.has(m[1])) sends.set(m[1], []); sends.get(m[1]).push({ t, wamid: m[2] }); } }
    if (m[3] === 'failed') failedStatus.push({ t, phone: m[1] });
    if (m[4] === 'applied') statusApplied++; else if (m[4] === 'duplicate') statusDup++;
  }
  if (/\[META_DELIVERY_UNTRACKED/.test(l)) untracked++;
  if ((m = /\[INVALID_ANSWER\].*phone=(\d+) step=(\S+)/.exec(l))) invalid.push({ t, phone: m[1], step: m[2] });
  if ((m = /Decision reply timeout - cleared pending state for whatsapp:(\d+)/.exec(l))) timeouts.push({ t, phone: m[1] });
  if (/\[STALE_TIMEOUT_IGNORED\]/.test(l)) stale.push(t);
  if ((m = /\[FLOW_QUEUE_WAIT\].*waitedMs=(\d+)/.exec(l))) fq.push({ t, ms: Number(m[1]) });
  if (/\[FILE_DELIVERY_WAIT_TIMEOUT\]/.test(l)) fdt.push(t);
  if ((m = /\[POSTGRES_BATCH_SLOW\].*commit_ms=(\d+)/.exec(l))) pgslow.push({ t, ms: Number(m[1]) });
  if (/\[DUPLICATE_REPLY_IGNORED\]/.test(l)) dupReply.push(t);
  if (/\[SEND_FAIL\]|\[SEND_RETRY\]|ProviderSendError|Meta message failed|rate limit hit|\(#131056\)/.test(l)) sendErr.push({ t, line: l.slice(31, 150) });
}

// launch window = from the first non-tester trigger on 17.10 (Israel date), everything earlier is testing
const real = trig.filter((x) => !TESTERS.has(x.phone));
const launchStart = real.filter((x) => day(x.t) === (process.env.LAUNCH_DAY || '2026-10-17')).reduce((a, x) => Math.min(a, x.t), Infinity);
const inLaunch = (t) => t >= launchStart;
const L = real.filter((x) => inLaunch(x.t));
// first trigger per participant only (a participant can re-trigger)
const firstTrig = new Map(); for (const x of L) if (!firstTrig.has(x.phone)) firstTrig.set(x.phone, x);
const parts = [...firstTrig.values()].sort((a, b) => a.t - b.t);

P('==================== תקופה ====================');
P(`לוג לקוחה: ${new Date(T(CL[0])).toISOString()} → ${new Date(T(CL.filter(Boolean).slice(-1)[0])).toISOString()}  (${CL.length} שורות)`);
P(`לוג שער:   ${new Date(T(GW[0])).toISOString()} → ${new Date(T(GW.filter(Boolean).slice(-1)[0])).toISOString()}  (${GW.length} שורות)`);
P(`כניסות בדיקה (מספר הבעלים + בודקת) לפני/אחרי ההשקה: ${trig.length - real.length}`);
P(`תחילת ההשקה: ${hhmm(launchStart)} שעון ישראל, ${day(launchStart)}`);

// ---------------------------------------------------------------------------------------- volume
P('\n==================== נפח ====================');
P(`משתתפות ייחודיות מאז ההשקה: ${parts.length}  (כניסות כולל חוזרות: ${L.length})`);
const byVar = {}; for (const x of parts) byVar[x.variant] = (byVar[x.variant] || 0) + 1;
P('לפי לינק: ' + JSON.stringify(byVar));
const byHour = {}; for (const x of parts) { const k = hhmm(x.t).slice(0, 2) + ':00'; byHour[k] = (byHour[k] || 0) + 1; }
P('לפי שעה (ישראל): ' + Object.entries(byHour).map(([k, v]) => `${k}=${v}`).join('  '));
const ts = parts.map((x) => x.t);
let m10 = 0, m60 = 0, m300 = 0, at10 = 0;
for (const a of ts) { let c10 = 0, c60 = 0, c300 = 0; for (const b of ts) { if (b >= a && b < a + 10e3) c10++; if (b >= a && b < a + 60e3) c60++; if (b >= a && b < a + 300e3) c300++; } if (c10 > m10) { m10 = c10; at10 = a; } m60 = Math.max(m60, c60); m300 = Math.max(m300, c300); }
P(`שיא כניסות: ${m10} ב-10 שניות (ב-${hhmm(at10)}), ${m60} בדקה, ${m300} ב-5 דקות.   קיבולת מדודה ב-10 שניות: ~50`);

// ---------------------------------------------------------------------------------------- first response + where the time goes
P('\n==================== זמן תגובה ראשונה ====================');
const first = [];
for (const x of parts) {
  const s = (sends.get(x.phone) || []).filter((v) => v.t >= x.t).sort((a, b) => a.t - b.t);
  if (s.length) first.push({ x, ms: s[0].t - x.t });
}
P('טריגר ← ההודעה הראשונה התקבלה ב-Meta (status=sent): ' + st(first.map((f) => f.ms)));
const noResp = parts.filter((x) => !(sends.get(x.phone) || []).some((v) => v.t >= x.t));
P(`משתתפות בלי שום תגובה: ${noResp.length}`);
P('גיל הטריגר כשעובד (Meta ← שער ← לקוחה, בשניות שלמות): ' + st(L.map((x) => x.age)));
const hourStats = {};
for (const f of first) { const k = hhmm(f.x.t).slice(0, 2) + ':00'; (hourStats[k] = hourStats[k] || []).push(f.ms); }
P('תגובה ראשונה לפי שעה:'); for (const [k, v] of Object.entries(hourStats)) P(`   ${k}  ${st(v)}`);

// ---------------------------------------------------------------------------------------- gateway join
P('\n==================== שער ← לקוחה (הצלבה לפי wamid) ====================');
const gwIn = new Map(), gwOut = new Map();
let gwRouteMs = [];
const gwAll = { inbound: 0, routed: 0, pending: 0 };
const gwFocusClientRoutes = [];
for (const l of GW) {
  if (!l || l.length < 31) continue; const t = T(l); let m;
  if ((m = /\[META_GATEWAY_INBOUND\] (\S+) (\d+) type=(\w+)/.exec(l))) { gwIn.set(m[1], { t, phone: m[2], type: m[3] }); gwAll.inbound++; }
  if ((m = /\[META_GATEWAY_(ROUTED|PENDING_ROUTED)\] (\S+)(?: (\d+))? ?([0-9a-f-]{36})?/.exec(l))) {
    const kind = m[1]; const wamid = m[2];
    const cm = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(l);
    if (kind === 'ROUTED') gwAll.routed++; else gwAll.pending++;
    if (cm && cm[1].startsWith(FOCUS_ID) && kind === 'ROUTED') gwOut.set(wamid, { t, kind });
  }
  if ((m = /route_ms=(\d+)/.exec(l)) && /clients_checked/.test(l)) gwRouteMs.push({ t, ms: Number(m[1]) });
}
const gwStage = { trigger: [], answer: [] }, fwd = [], clientQ = [], e2eIn = [];
let joined = 0;
for (const [w, o] of gwOut) {
  const i = gwIn.get(w); if (!i) continue; if (!inLaunch(i.t) || TESTERS.has(i.phone)) continue;
  const c = inbound.get(w);
  (i.type === 'text' ? gwStage.trigger : gwStage.answer).push(o.t - i.t);
  if (c) { joined++; fwd.push(c.t - o.t); }
}
P(`הודעות של פוקוס שהצלבתי בין שני הלוגים: ${joined}`);
P('שער: קבלת ה-webhook ← הועברה ללקוחה (טריגר חדש):  ' + st(gwStage.trigger));
P('שער: קבלת ה-webhook ← הועברה ללקוחה (תשובה/המשך): ' + st(gwStage.answer));
P('שער ← הלקוחה רשמה קבלה (העברה + תור inbox בלקוחה):  ' + st(fwd));
// full decomposition for triggers: gw in -> routed -> client inbound -> first send
const dec = { gw: [], fwd: [], work: [], total: [] };
for (const [w, o] of gwOut) {
  const i = gwIn.get(w), c = inbound.get(w); if (!i || i.type !== 'text' || !c || !inLaunch(i.t) || TESTERS.has(i.phone)) continue;
  const s = (sends.get(i.phone) || []).filter((v) => v.t >= c.t).sort((a, b) => a.t - b.t)[0]; if (!s) continue;
  dec.gw.push(o.t - i.t); dec.fwd.push(c.t - o.t); dec.work.push(s.t - c.t); dec.total.push(s.t - i.t);
}
P('--- פירוק התגובה הראשונה (n=' + dec.total.length + ', מרגע שה-webhook הגיע לשער) ---');
P('   שער (ניתוב):                 ' + st(dec.gw));
P('   העברה לקוחה + תור:           ' + st(dec.fwd));
P('   עבודה בלקוחה עד שליחה ל-Meta: ' + st(dec.work));
P('   סה"כ מה-webhook:              ' + st(dec.total));
const todayRoute = gwRouteMs.filter((x) => inLaunch(x.t));
P('route_ms בשער מאז ההשקה (כל הלקוחות): ' + st(todayRoute.map((x) => x.ms)));
P(`נפח השער מאז ההשקה: כניסות ${[...gwIn.values()].filter((x) => inLaunch(x.t)).length}, מתוכן לפוקוס ${[...gwOut.keys()].filter((w) => gwIn.get(w) && inLaunch(gwIn.get(w).t)).length}`);

// ---------------------------------------------------------------------------------------- funnel
P('\n==================== משפך: כמה הגיעו לכל שלב ====================');
const STEPS = [
  ['3 שמרתי', /^option-mu525deu/], ['5 יעד (יוון/אירופה)', /^option-mu526mk4/], ['6 ניקוד 1', /^option-(mu528mxv|mu529m82)/], ['7 ניקוד 2', /^option-(mu529qev|mu52afk9)/],
  ['8 ניקוד 3', /^option-(mu52ail0|mu52b34l)/], ['9 ניקוד 4', /^option-(mu52b6f8|mu52brcc)/], ['10 שאלה אחרונה', /^option-(mu52busb|mu52ccw8)/],
  ['13 אשמח לממש', /^option-mv4zr99f/], ['15 שיתפתי', /^option-mu52f2rs/],
];
const reached = STEPS.map(() => new Set());
for (const [, c] of inbound) { if (!c.opt || TESTERS.has(c.phone) || !firstTrig.has(c.phone) || c.t < firstTrig.get(c.phone).t) continue; STEPS.forEach(([, re], i) => { if (re.test(c.opt)) reached[i].add(c.phone); }); }
P(`נכנסו: ${parts.length}`);
STEPS.forEach(([n], i) => P(`   ${n.padEnd(22)} ${String(reached[i].size).padStart(3)}  (${Math.round(reached[i].size / parts.length * 100)}%)`));

// ---------------------------------------------------------------------------------------- race
P('\n==================== מרוץ הטיימר (תשובה לא תקינה) ====================');
const invL = invalid.filter((x) => inLaunch(x.t) && !TESTERS.has(x.phone));
const lastTo = new Map(); const evs = [...timeouts.map((x) => ({ ...x, k: 'to' })), ...invL.map((x) => ({ ...x, k: 'inv' }))].sort((a, b) => a.t - b.t);
const deltas = []; const affected = new Set(); const stepCount = {};
for (const e of evs) { if (e.k === 'to') lastTo.set(e.phone, e.t); else { const t = lastTo.get(e.phone); deltas.push(t ? (e.t - t) / 1000 : -1); affected.add(e.phone); stepCount[e.step.slice(0, 18)] = (stepCount[e.step.slice(0, 18)] || 0) + 1; } }
P(`תשובות לא תקינות: ${invL.length} מ-${affected.size} משתתפות (${Math.round(affected.size / parts.length * 100)}% מהנכנסות)`);
P(`   בתוך 10 שניות מפקיעת טיימר: ${deltas.filter((d) => d >= 0 && d <= 10).length}   עד 60 שנ': ${deltas.filter((d) => d >= 0 && d <= 60).length}   עד 5 דק': ${deltas.filter((d) => d >= 0 && d <= 300).length}   מעל 5 דק': ${deltas.filter((d) => d > 300).length}   בלי טיימר קודם: ${deltas.filter((d) => d < 0).length}`);
P('   לפי צעד: ' + JSON.stringify(stepCount));
const contAfter = [...affected].filter((p) => { const t0 = invL.filter((x) => x.phone === p).sort((a, b) => a.t - b.t)[0].t; return (sends.get(p) || []).some((v) => v.t > t0 + 500); });
P(`   המשיכו לקבל הודעות אחרי הדחייה: ${contAfter.length} מתוך ${affected.size}`);
const toL = timeouts.filter((x) => inLaunch(x.t) && !TESTERS.has(x.phone));
P(`פקיעות טיימר מאז ההשקה: ${toL.length} (STALE_TIMEOUT_IGNORED = טיימר שבוטל בגלל תשובה בו-זמנית: ${stale.filter(inLaunch).length})`);

// ---------------------------------------------------------------------------------------- stability
P('\n==================== יציבות ====================');
P(`שגיאות שליחה / ניסיונות חוזרים / 429 מאז ההשקה: ${sendErr.filter((x) => inLaunch(x.t)).length}`); sendErr.filter((x) => inLaunch(x.t)).slice(0, 5).forEach((x) => P('   ' + x.line));
P(`סטטוסי failed מ-Meta מאז ההשקה: ${failedStatus.filter((x) => inLaunch(x.t) && !TESTERS.has(x.phone)).length}`);
P(`המתנה לאישור מסירה שפגה ב-20ש': ${fdt.filter(inLaunch).length}`);
P('FLOW_QUEUE_WAIT (ms): ' + st(fq.filter((x) => inLaunch(x.t)).map((x) => x.ms)));
P('POSTGRES_BATCH_SLOW commit_ms: ' + st(pgslow.filter((x) => inLaunch(x.t)).map((x) => x.ms)));
P(`תשובה כפולה שנבלעה: ${dupReply.filter(inLaunch).length}`);
P(`סטטוסי מסירה: applied=${statusApplied}, duplicate=${statusDup}, untracked=${untracked} (כל התקופה)`);
const gwBad = GW.filter((l) => l.length > 31 && inLaunch(T(l)) && /CLIENT_SKIPPED|GATEWAY_INBOX_RETRY|CLEAR_PENDING_FAILED|META_GATEWAY_AMBIGUOUS|refusing unsafe/.test(l));
P(`שער: אירועי חסימה/ניסיון חוזר מאז ההשקה: ${gwBad.length}`);
P(`שער: כשלי רענון cache מאז ההשקה: ${GW.filter((l) => l.length > 31 && inLaunch(T(l)) && /ROUTES_CACHE_REFRESH_FAILED/.test(l)).length}`);

// ---------------------------------------------------------------------------------------- messages per participant
P('\n==================== הודעות יוצאות למשתתפת ====================');
const outN = parts.map((x) => (sends.get(x.phone) || []).filter((v) => v.t >= x.t).length);
P('הודעות שנשלחו למשתתפת (ייחודיות לפי wamid): ' + st(outN));
const dist = {}; for (const n of outN) { const b = n >= 30 ? '30+' : n >= 20 ? '20-29' : n >= 10 ? '10-19' : n >= 5 ? '5-9' : '1-4'; dist[b] = (dist[b] || 0) + 1; }
P('התפלגות: ' + JSON.stringify(dist));

// ---------------------------------------------------------------------------------------- did step 13 actually get sent?
P('\n==================== האם שאלת "אשמח לממש" (צעד 13) באמת נשלחה? ====================');
const pressedStep10 = [];
for (const [, c] of inbound) { if (c.opt && /^option-(mu52busb|mu52ccw8)/.test(c.opt) && firstTrig.has(c.phone) && !TESTERS.has(c.phone) && c.t >= firstTrig.get(c.phone).t) pressedStep10.push(c); }
const seenP = new Set(); const uniq10 = pressedStep10.filter((c) => { if (seenP.has(c.phone)) return false; seenP.add(c.phone); return true; });
let sentN = []; let lastGap = [];
for (const c of uniq10) { const s = (sends.get(c.phone) || []).filter((v) => v.t > c.t && v.t <= c.t + 75e3).sort((a, b) => a.t - b.t); sentN.push(s.length); if (s.length) lastGap.push(s[s.length - 1].t - c.t); }
P(`ענו על שאלה 10: ${uniq10.length}`);
P('כמה הודעות נשלחו להן ב-75 השניות שאחרי: ' + st(sentN));
P('הזמן עד ההודעה האחרונה בחלון (צעד 13 אמור להגיע ~30 שנ\' אחרי הודעות 11-12): ' + st(lastGap));
const got13 = uniq10.filter((c, i) => sentN[i] >= 5).length;
P(`נשלחו להן ≥5 הודעות בחלון (כלומר גם שאלה 13 נשלחה): ${got13} מתוך ${uniq10.length}`);
const p13 = reached[7].size; P(`לחצו על כפתור שאלה 13: ${p13} = ${Math.round(p13 / Math.max(1, got13) * 100)}% ממי שקיבלה אותה`);
const shareFocus = [...gwOut.keys()].filter((w) => gwIn.get(w) && inLaunch(gwIn.get(w).t) && !TESTERS.has(gwIn.get(w).phone)).length;
const allIn = [...gwIn.values()].filter((x) => inLaunch(x.t)).length;
P(`\nחלקה של פוקוס בתנועת השער מאז ההשקה: ${shareFocus} מתוך ${allIn} הודעות נכנסות (${Math.round(shareFocus / allIn * 100)}%)`);
fs.writeFileSync(OUT_FILE, out.join('\n'));
