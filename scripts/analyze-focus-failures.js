'use strict';
// Trend over time, restarts and failure scan for the Focus campaign, from the FULL client and gateway logs.
// Companion of analyze-focus-launch.js (same launch definition, same exclusions).
//   node scripts/analyze-focus-failures.js <client-log> <gateway-log>
const fs = require('fs');
const CLIENT_LOG = process.argv[2];
const GATEWAY_LOG = process.argv[3];
if (!CLIENT_LOG || !GATEWAY_LOG) { console.error('usage: node scripts/analyze-focus-failures.js <client-log> <gateway-log>'); process.exit(2); }
const NL = String.fromCharCode(10);
const readLines = (f) => fs.readFileSync(f, 'utf8').split(NL).map((l) => (l.endsWith(String.fromCharCode(13)) ? l.slice(0, -1) : l));
const CL = readLines(CLIENT_LOG);
const GW = readLines(GATEWAY_LOG);
const TESTERS = new Set((process.env.TEST_PHONES || '972504213243,972583226413,972586100142').split(','));   // override with TEST_PHONES
const LAUNCH = Date.parse(process.env.LAUNCH_UTC || '2026-10-17T16:35:00Z');   // override with LAUNCH_UTC
const T = (l) => new Date(l.slice(0, 30)).getTime();
const il = (t) => new Date(t + 3 * 3600e3).toISOString();
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const out = [];
const P = (s = '') => { out.push(s); console.log(s); };

// ---------------------------------------------------------------- participants, first response, 30-minute trend
const trig = new Map(); const sends = new Map(); const seen = new Set();
for (const l of CL) {
  if (l.length < 31) continue; let m; const t = T(l);
  if ((m = /\[MSG\] trigger matched .*from=whatsapp:(\d+)/.exec(l)) && t >= LAUNCH && !TESTERS.has(m[1]) && !trig.has(m[1])) trig.set(m[1], t);
  if ((m = /\[META_DELIVERY\] to=whatsapp:(\d+) wamid=(\S+) status=sent/.exec(l)) && !seen.has(m[2])) { seen.add(m[2]); if (!sends.has(m[1])) sends.set(m[1], []); sends.get(m[1]).push(t); }
}
const rows = [];
for (const [p, t0] of trig) { const s = (sends.get(p) || []).filter((t) => t >= t0).sort((a, b) => a - b); rows.push({ p, t0, ms: s.length ? s[0] - t0 : null }); }
rows.sort((a, b) => a.t0 - b.t0);
const answered = rows.filter((r) => r.ms !== null);
P('משתתפות מאז ההשקה (ייחודיות, בלי בודקות): ' + rows.length + ' | קיבלו תגובה: ' + answered.length + ' | בלי תגובה: ' + (rows.length - answered.length));
P('תגובה ראשונה, כללי: n=' + answered.length + ' p50=' + q(answered.map((r) => r.ms), 0.5) + ' p90=' + q(answered.map((r) => r.ms), 0.9) + ' p99=' + q(answered.map((r) => r.ms), 0.99) + ' max=' + Math.max(...answered.map((r) => r.ms)));
P('');
P('==== מגמה לפי חלונות של 30 דקות (שעון ישראל) ====');
P('חלון         כניסות   p50 / p90 / max (ms)');
const bins = new Map();
for (const r of answered) {
  const d = il(r.t0); const key = d.slice(5, 10) + ' ' + d.slice(11, 13) + ':' + (Number(d.slice(14, 16)) >= 30 ? '30' : '00');
  if (!bins.has(key)) bins.set(key, []); bins.get(key).push(r.ms);
}
for (const [k, v] of [...bins.entries()].sort()) P(k + '   ' + String(v.length).padStart(5) + '      ' + q(v, 0.5) + ' / ' + q(v, 0.9) + ' / ' + Math.max(...v));
const ts = rows.map((r) => r.t0); let m10 = 0, m60 = 0, m300 = 0;
for (const a of ts) { let c10 = 0, c60 = 0, c300 = 0; for (const b of ts) { if (b >= a && b < a + 10e3) c10++; if (b >= a && b < a + 60e3) c60++; if (b >= a && b < a + 300e3) c300++; } m10 = Math.max(m10, c10); m60 = Math.max(m60, c60); m300 = Math.max(m300, c300); }
P('');
P('שיא כניסות: ' + m10 + ' ב-10 שניות, ' + m60 + ' בדקה, ' + m300 + ' ב-5 דקות (קיבולת מדודה ב-10 שניות: כ-50)');
const worst = answered.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
P('5 התגובות הראשונות האיטיות ביותר: ' + worst.map((r) => il(r.t0).slice(11, 19) + '=' + r.ms + 'ms').join('  '));

// ---------------------------------------------------------------- restarts
P('');
P('==== הפעלות מחדש ====');
const starts = CL.filter((l) => l.length > 31 && /WhatsApp Status Bot . starting up/.test(l)).map((l) => T(l));
P('הפעלות של האפליקציה בלוג כולו: ' + starts.length + ' — ' + starts.map((t) => il(t).slice(0, 16).replace('T', ' ')).join(' | '));
P('מאז ההשקה: ' + starts.filter((t) => t >= LAUNCH).length);
const gwStarts = GW.filter((l) => l.length > 31 && /starting up/.test(l)).map((l) => T(l));
P('הפעלות של השער בלוג שלו: ' + gwStarts.length + ' | מאז ההשקה: ' + gwStarts.filter((t) => t >= LAUNCH).length);

// ---------------------------------------------------------------- failure scan (client)
const tagOf = (l) => { const m = /^\S+ (\[[A-Z_0-9]+\])/.exec(l); return m ? m[1] : null; };
const norm = (l) => l.slice(31).split(/wamid\.\S+/).join('WAMID').replace(/\d{9,}/g, 'N').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'UUID').replace(/\d+(\.\d+)?ms/g, 'Nms').replace(/=\d+/g, '=N').slice(0, 115);
const ERR = /Error|ECONN|ETIMEDOUT|EPIPE|TypeError|RangeError|Unhandled|Uncaught|FATAL|SEND_FAIL|SEND_RETRY|failed|ProviderSendError|deadlock|out of memory|SIGTERM|SIGKILL|Cannot|refused|timeout/i;
const tagCount = new Map(); const shapes = new Map(); const errTimes = [];
for (const l of CL) {
  if (l.length < 31 || T(l) < LAUNCH) continue;
  const tg = tagOf(l); if (tg) tagCount.set(tg, (tagCount.get(tg) || 0) + 1);
  if (/\[META_DELIVERY\]|\[META_INBOUND\]|\[MSG\] trigger matched/.test(l)) continue;
  if (ERR.test(l.slice(31).split(/wamid\.\S+/).join('WAMID'))) { const k = norm(l); shapes.set(k, (shapes.get(k) || 0) + 1); errTimes.push(T(l)); }
}
P('');
P('==== בדיקת נפילות: לקוחה, מאז ההשקה ====');
P('כל סוגי שורות הלוג (כדי לוודא שלא פספסתי קטגוריה):');
P([...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join('  '));
P('');
P('שורות שנראות כשגיאה/כשל/timeout (מנורמלות, בלי שורות מסירה ותגובה רגילות):');
if (!shapes.size) P('   אין');
for (const [k, v] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) P('   x' + String(v).padStart(3) + '  ' + k);

// failed delivery statuses and send errors, precisely
const failedStatus = CL.filter((l) => l.length > 31 && T(l) >= LAUNCH && /\[META_DELIVERY\] .* status=failed/.test(l));
const sendErr = CL.filter((l) => l.length > 31 && T(l) >= LAUNCH && /\[SEND_FAIL\]|\[SEND_RETRY\]|ProviderSendError|Meta message failed|\(#131056\)|rate limit hit/.test(l));
P('');
P('סטטוסי failed מ-Meta: ' + failedStatus.length + ' | שגיאות שליחה/ניסיונות חוזרים/429: ' + sendErr.length);
const waitTo = CL.filter((l) => l.length > 31 && T(l) >= LAUNCH && /FILE_DELIVERY_WAIT_TIMEOUT/.test(l));
P('המתנה לאישור מסירה שפגה (20 שנ\'): ' + waitTo.length + (waitTo.length ? ' — ' + waitTo.map((l) => il(T(l)).slice(11, 19)).join(', ') : ''));
const pg = CL.filter((l) => l.length > 31 && T(l) >= LAUNCH && /POSTGRES_BATCH_SLOW/.test(l)).map((l) => Number((/commit_ms=(\d+)/.exec(l) || [0, 0])[1]));
P('POSTGRES_BATCH_SLOW commit_ms: n=' + pg.length + ' p50=' + q(pg, 0.5) + ' p90=' + q(pg, 0.9) + ' max=' + (pg.length ? Math.max(...pg) : 0));
const fq = CL.filter((l) => l.length > 31 && T(l) >= LAUNCH && /FLOW_QUEUE_WAIT/.test(l)).map((l) => Number((/waitedMs=(\d+)/.exec(l) || [0, 0])[1]));
P('FLOW_QUEUE_WAIT ms: n=' + fq.length + ' p50=' + q(fq, 0.5) + ' p90=' + q(fq, 0.9) + ' max=' + (fq.length ? Math.max(...fq) : 0));

// ---------------------------------------------------------------- gateway
const gwTag = new Map(); const gwShapes = new Map();
for (const l of GW) {
  if (l.length < 31 || T(l) < LAUNCH) continue;
  const tg = tagOf(l); if (tg) gwTag.set(tg, (gwTag.get(tg) || 0) + 1);
  if (/META_STATUS_FOREIGN|META_ROUTES_CACHE_HIT|META_ROUTES_CACHE_MISS/.test(l)) continue;
  if (/Error|ECONN|ETIMEDOUT|TypeError|Unhandled|Uncaught|FATAL|refusing|SKIPPED|RETRY|FAILED|unavailable|REFRESH_FAILED/i.test(l.slice(31).split(/wamid\.\S+/).join('WAMID'))) { const k = norm(l); gwShapes.set(k, (gwShapes.get(k) || 0) + 1); }
}
P('');
P('==== בדיקת נפילות: שער, מאז ההשקה ====');
P([...gwTag.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join('  '));
P('');
P('שורות שנראות כשגיאה/ניסיון חוזר/דילוג בשער:');
if (!gwShapes.size) P('   אין');
for (const [k, v] of [...gwShapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) P('   x' + String(v).padStart(3) + '  ' + k);
const blocking = GW.filter((l) => l.length > 31 && T(l) >= LAUNCH && /CLIENT_SKIPPED|GATEWAY_INBOX_RETRY|CLEAR_PENDING_FAILED|META_GATEWAY_AMBIGUOUS|refusing unsafe|PENDING_CHECK_FAILED/.test(l));
P('');
P('אירועים שחוסמים או מעכבים הודעות בשער: ' + blocking.length);
const ign = {}; for (const l of GW) { let m; if (l.length > 31 && T(l) >= LAUNCH && (m = /\[META_GATEWAY_IGNORED\] reason=(\S+)/.exec(l))) ign[m[1]] = (ign[m[1]] || 0) + 1; }
P('הודעות שהשער התעלם מהן (לפי סיבה): ' + JSON.stringify(ign));
const routeMs = GW.filter((l) => l.length > 31 && T(l) >= LAUNCH && /route_ms=/.test(l)).map((l) => Number((/route_ms=(\d+)/.exec(l) || [0, 0])[1]));
P('route_ms בשער: n=' + routeMs.length + ' p50=' + q(routeMs, 0.5) + ' p90=' + q(routeMs, 0.9) + ' p99=' + q(routeMs, 0.99) + ' max=' + (routeMs.length ? Math.max(...routeMs) : 0));

// ---------------------------------------------------------------- invalid answers (timer race)
const lastTo = new Map(); let inv = 0; const invPeople = new Set(); const within = { le10: 0, le60: 0, none: 0, other: 0 };
for (const l of CL) {
  if (l.length < 31) continue; let m; const t = T(l);
  if ((m = /Decision reply timeout - cleared pending state for whatsapp:(\d+)/.exec(l))) lastTo.set(m[1], t);
  if ((m = /\[INVALID_ANSWER\].*phone=(\d+)/.exec(l)) && t >= LAUNCH && !TESTERS.has(m[1])) {
    inv++; invPeople.add(m[1]); const to = lastTo.get(m[1]);
    if (!to) within.none++; else if (t - to <= 10e3) within.le10++; else if (t - to <= 60e3) within.le60++; else within.other++;
  }
}
P('');
P('==== תשובות לא תקינות (מרוץ הטיימר) ====');
P('סה"כ ' + inv + ' מ-' + invPeople.size + ' משתתפות (' + Math.round(invPeople.size / Math.max(1, rows.length) * 100) + '% מהנכנסות). בתוך 10 שנ\' מפקיעת טיימר: ' + within.le10 + ' | 10-60 שנ\': ' + within.le60 + ' | מעל 60 שנ\': ' + within.other + ' | בלי טיימר קודם: ' + within.none);

fs.writeFileSync(CLIENT_LOG.replace(/\.txt$/, '') + '.analysis.txt', out.join(NL));
