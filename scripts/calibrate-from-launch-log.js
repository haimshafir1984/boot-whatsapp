'use strict';
// Real-world parameters for the peak simulator, measured from a FULL client log (docker logs) of a real launch.
//   node scripts/calibrate-from-launch-log.js <client-log> [launchIsoUtc] [excludePhones=comma list]
// Prints: think time (our last message `sent` -> their next inbound), delivered/read lag after `sent`, arrival profile
// (first-trigger bursts), per-step drop-off. Pure read of the log; every number is a percentile of what happened.
const fs = require('node:fs');
const LOG = process.argv[2]; if (!LOG) { console.error('usage: node scripts/calibrate-from-launch-log.js <client-log> [launchIsoUtc] [excludePhones]'); process.exit(2); }
const LAUNCH = Date.parse(process.argv[3] || '2026-10-17T16:35:00Z');
const EXCL = new Set((process.argv[4] || '972504213243,972583226413,972586100142').split(','));
const NL = String.fromCharCode(10), CR = String.fromCharCode(13);
const lines = fs.readFileSync(LOG, 'utf8').split(NL).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));
const T = (l) => Date.parse(l.slice(0, 30));
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const summ = (a) => `n=${a.length} p10=${q(a, .1)} p50=${q(a, .5)} p90=${q(a, .9)} p99=${q(a, .99)} max=${a.length ? Math.max(...a) : null}`;
const sentAt = new Map();           // phone -> sorted [{t, wamid}] of bot messages (status=sent)
const statusT = new Map();          // wamid -> {sent, delivered, read}
const inbound = new Map();          // phone -> [{t, kind}]
const firstTrigger = new Map();
for (const l of lines) {
  if (l.length < 31) continue; const t = T(l); if (!(t >= LAUNCH)) continue; let m;
  if ((m = /\[META_DELIVERY\] to=whatsapp:(\d+) wamid=(\S+) status=(sent|delivered|read) result=applied/.exec(l))) {
    if (EXCL.has(m[1])) continue;
    const r = statusT.get(m[2]) || { phone: m[1] }; if (!r[m[3]]) r[m[3]] = t; statusT.set(m[2], r);
    if (m[3] === 'sent') { if (!sentAt.has(m[1])) sentAt.set(m[1], []); sentAt.get(m[1]).push(t); }
  } else if ((m = /\[META_INBOUND\] (\S+) (\d+) (.*) type=(\w+)/.exec(l))) {
    if (EXCL.has(m[2])) continue;
    if (!inbound.has(m[2])) inbound.set(m[2], []); inbound.get(m[2]).push({ t, type: m[4], what: m[3] });
    if (m[4] === 'text' && !firstTrigger.has(m[2])) firstTrigger.set(m[2], t);
  }
}
for (const a of sentAt.values()) a.sort((x, y) => x - y);
// think time: only for interactive answers (button/list), measured from the LAST bot `sent` before the answer
const think = [];
for (const [phone, ins] of inbound) for (const i of ins) {
  if (i.type !== 'interactive') continue;
  const prev = (sentAt.get(phone) || []).filter((t) => t < i.t); if (!prev.length) continue;
  const d = i.t - prev[prev.length - 1]; if (d >= 0 && d < 300000) think.push(d);
}
const logs = think.filter((d) => d > 0).map(Math.log); const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
const sigma = Math.sqrt(logs.reduce((a, b) => a + (b - mu) ** 2, 0) / logs.length);
console.log('THINK (last bot message sent -> button answer), ms: ' + summ(think));
console.log(`   lognormal fit: median=${Math.round(Math.exp(mu))}ms sigma=${sigma.toFixed(2)}   (simulator: --think-ms <median>, sigma fixed 0.6, clamp 800..60000)`);
const dl = [], rd = [];
for (const r of statusT.values()) { if (r.sent && r.delivered) dl.push(r.delivered - r.sent); if (r.sent && r.read) rd.push(r.read - r.sent); }
console.log('DELIVERED lag after `sent`, ms: ' + summ(dl.filter((x) => x >= 0)));
console.log('READ lag after `sent`, ms: ' + summ(rd.filter((x) => x >= 0)));
const withDelivered = [...statusT.values()].filter((r) => r.sent).length;
console.log(`STATUS mix: ${withDelivered} sent | ${[...statusT.values()].filter((r) => r.delivered).length} delivered | ${[...statusT.values()].filter((r) => r.read).length} read  (readFrac ~ ${([...statusT.values()].filter((r) => r.read).length / Math.max(1, withDelivered)).toFixed(2)})`);
// arrival profile
const trig = [...firstTrigger.values()].sort((a, b) => a - b);
const win = (ms) => { let best = 0, j = 0; for (let i = 0; i < trig.length; i++) { while (trig[i] - trig[j] > ms) j++; best = Math.max(best, i - j + 1); } return best; };
console.log(`ARRIVAL: ${trig.length} participants since launch | max in 1s=${win(1000)} 10s=${win(10000)} 60s=${win(60000)} 10min=${win(600000)} 1h=${win(3600000)}`);
// funnel by number of button answers
const answered = [...inbound.values()].map((v) => v.filter((x) => x.type === 'interactive').length);
const reach = (k) => answered.filter((n) => n >= k).length;
console.log('PARTICIPANTS ' + answered.length + ' | answered >=1: ' + reach(1) + ' >=3: ' + reach(3) + ' >=6: ' + reach(6) + ' >=8: ' + reach(8) + ' >=10: ' + reach(10) + ' >=12: ' + reach(12));
const perPerson = []; for (const [phone, a] of sentAt) perPerson.push(a.length);
console.log('BOT MESSAGES (status=sent) per participant: ' + summ(perPerson));
// gap between consecutive bot messages to the same participant (status=sent) when they belong to one burst (< 10s apart)
const gaps = []; for (const a of sentAt.values()) for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d < 10000) gaps.push(d); }
console.log('GAP between consecutive bot messages (<10s), ms: ' + summ(gaps));
// answer -> first bot message (interactive answer inbound -> next sent), ms
const resp = []; for (const [phone, ins] of inbound) for (const i of ins) { if (i.type !== 'interactive') continue; const nx = (sentAt.get(phone) || []).find((t) => t > i.t); if (nx !== undefined && nx - i.t < 60000) resp.push(nx - i.t); }
console.log('ANSWER -> first bot message sent, ms: ' + summ(resp));
