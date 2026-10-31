#!/usr/bin/env node
'use strict';
/**
 * Live campaign report: pulls the FULL log of one client and of the gateway (from the start of their current container), and prints a
 * quick-view summary of what matters while a big campaign is running. Read-only: it only reads docker logs over SSH and the public /health.
 *
 *   node scripts/campaign-live-report.js [options]
 *
 *   --client-id c02484f2          client id prefix (default: Oshrit)
 *   --window MIN                  only analyse the last MIN minutes (default: everything since the container started)
 *   --out DIR                     where the log files go (default: ~/Downloads/campaign-live-<date>) - they contain phone numbers, NEVER commit
 *   --since ISO                   pass docker --since (default: none; the newest container's own log is selected instead)
 *   --all-tasks                   keep the logs of OLDER containers too (default: only the newest container of each service)
 *   --no-pull DIR                 analyse DIR/client.txt and DIR/gateway.txt that you already have (no SSH)
 *   --test-phones a,b             phones to leave out of the counts (default: the owner's test phone)
 *   --full                        also run compare-gateway-client.js and analyze-focus-failures.js on the pulled logs
 *   --host 169.58.236.130 --key ~/.ssh/flowsbiz_hetzner_ed25519 --gateway-service flowsbiz-admin-akr2zu
 *   --client-health URL --gateway-health URL     (defaults: derived from the client service / admin.flowsbiz.com)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const CLIENT_ID = val('client-id', 'c02484f2');
const HOST = val('host', '169.58.236.130');
const KEY = val('key', path.join(os.homedir(), '.ssh', 'flowsbiz_hetzner_ed25519'));
const GATEWAY_SERVICE = val('gateway-service', 'flowsbiz-admin-akr2zu');
const WINDOW_MIN = Number(val('window', 0)) || 0;
const TESTERS = new Set(val('test-phones', '972504213243').split(',').map((s) => s.trim()).filter(Boolean));
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const OUT = val('out', path.join(os.homedir(), 'Downloads', `campaign-live-${stamp}`));
const NOPULL = val('no-pull', '');

const out = [];
const P = (s = '') => { out.push(s); console.log(s); };
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const fmtMs = (v) => (v === null || v === undefined ? '-' : v >= 10000 ? (v / 1000).toFixed(1) + 's' : v + 'ms');
const il = (t) => new Date(t).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false });
const T = (l) => Date.parse(l.slice(0, 30));
const lat = (label, a) => P('  ' + label.padEnd(34) + String(a.length).padStart(6) + '  p50 ' + fmtMs(q(a, 0.5)).padStart(7) + '  p95 ' + fmtMs(q(a, 0.95)).padStart(7) + '  p99 ' + fmtMs(q(a, 0.99)).padStart(7) + '  max ' + fmtMs(a.length ? Math.max(...a) : null).padStart(7));
const warnings = [];
const warn = (s) => { warnings.push(s); P('  [!] ' + s); };

// ------------------------------------------------------------------ pulling
function ssh(command, fd) {
  const r = spawnSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', `root@${HOST}`, command], { stdio: ['ignore', fd ?? 'pipe', 'pipe'], encoding: fd === undefined ? 'utf8' : undefined, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ssh failed (${r.status}): ${String(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
}

/** Raw docker lines look like "<ts> <service>.<slot>.<taskid>@<node>    | text". Keep only the newest task (container) and drop the prefix. */
function cleanLog(rawFile, outFile, allTasks, keepTask) {
  const lines = fs.readFileSync(rawFile, 'utf8').split('\n');
  const re = /^(\S+) (\S+?)\.(\d+)\.([a-z0-9]+)@\S+\s+\| ?(.*)$/;
  const tasks = new Map();
  const parsed = [];
  for (const raw of lines) {
    const m = re.exec(raw.replace(/\r$/, ''));
    if (!m) { continue; }
    parsed.push({ ts: m[1], task: m[4], text: m[5] });
    if (!tasks.has(m[4]) || m[1] < tasks.get(m[4])) tasks.set(m[4], m[1]);
  }
  // The RUNNING container, not the one whose first line is latest: a container that is shutting down can log after the new one started.
  const newest = keepTask && tasks.has(keepTask) ? keepTask : [...tasks.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1))[0]?.[0];
  const kept = parsed.filter((p) => allTasks || p.task === newest);
  fs.writeFileSync(outFile, kept.map((p) => `${p.ts} ${p.text}`).join('\n') + '\n');
  return { tasks: tasks.size, kept: kept.length, dropped: parsed.length - kept.length };
}

function pull() {
  fs.mkdirSync(OUT, { recursive: true });
  const list = ssh("docker service ls --format '{{.Name}}'").split('\n').map((s) => s.trim());
  const clientService = list.find((n) => n.includes(CLIENT_ID) && n.includes('-app-'));
  if (!clientService) throw new Error(`no client service matching ${CLIENT_ID}`);
  const info = {};
  for (const [name, service, file] of [['client', clientService, 'client.txt'], ['gateway', GATEWAY_SERVICE, 'gateway.txt']]) {
    // Without --since docker would replay every old container of the service (days of gateway log). Start at the newest container's creation.
    let since = val('since', '') ? ` --since ${val('since')}` : '';
    let keepTask = '';
    if (!has('all-tasks')) {
      const result = ssh(`t=$(docker service ps ${service} --filter desired-state=running --format '{{.ID}}' | head -1); echo $t; docker inspect $t --format '{{.CreatedAt}}'`).trim().split('\n');
      keepTask = (result[0] || '').trim();
      const created = result[1] || '';
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(created);
      if (m && !since) since = ` --since ${m[1]}T${m[2]}Z`;
    }
    const raw = path.join(OUT, `${name}.raw`);
    const fd = fs.openSync(raw, 'w');
    ssh(`docker service logs --timestamps${since} ${service} 2>&1`, fd);
    fs.closeSync(fd);
    info[name] = { service, ...cleanLog(raw, path.join(OUT, file), has('all-tasks'), keepTask) };
    fs.rmSync(raw, { force: true });
  }
  return { dir: OUT, info };
}

// ------------------------------------------------------------------ analysis
const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 31);
const countBy = (lines, rules) => rules.map(([label, re]) => [label, lines.reduce((n, l) => n + (re.test(l) ? 1 : 0), 0), lines.find((l) => re.test(l))]);
const tagTable = (rows) => { for (const [label, n, ex] of rows) if (n) P('  ' + label.padEnd(44) + String(n).padStart(7) + (ex ? '   e.g. ' + ex.slice(31, 140).replace(/wamid=\S+/g, 'wamid=…') : '')); };

function clientView(CL, windowStart) {
  P('=============== הלקוחה ===============');
  const all = CL;
  const lines = all.filter((l) => T(l) >= windowStart);
  if (!lines.length) { warn('אין שורות בחלון הזה בלוג הלקוחה'); return { sendsOk: false }; }
  P(`  מ-${il(T(lines[0]))} עד ${il(T(lines[lines.length - 1]))} (שעון ישראל), ${lines.length} שורות`);
  const restarts = all.filter((l) => /WhatsApp Status Bot – starting up|starting up…/.test(l)).length;
  P(`  עליות שירות בלוג: ${restarts}` + (all.some((l) => /META_MAX_CONCURRENT_SENDERS=/.test(l)) ? '   (META_MAX_CONCURRENT_SENDERS מוגדר: ' + (/META_MAX_CONCURRENT_SENDERS=(\d+)/.exec(all.find((l) => /META_MAX_CONCURRENT_SENDERS=/.test(l)))[1]) + ')' : '   [אין META_MAX_CONCURRENT_SENDERS בלוג]'));
  if (restarts > 1) warn(`הלקוחה עלתה ${restarts} פעמים בלוג`);

  // inbound & first sends per phone
  const inbound = []; const sends = new Map(); const seen = new Set();
  for (const l of all) {
    let m;
    if ((m = /\[META_INBOUND\] (\S+) (\d+) (.*?) type=(\w+)/.exec(l))) inbound.push({ t: T(l), w: m[1], phone: m[2], type: m[4] });
    if ((m = /\[META_DELIVERY\] to=whatsapp:(\d+) wamid=(\S+) status=sent/.exec(l)) && !seen.has(m[2])) { seen.add(m[2]); if (!sends.has(m[1])) sends.set(m[1], []); sends.get(m[1]).push(T(l)); }
  }
  for (const a of sends.values()) a.sort((x, y) => x - y);
  const real = inbound.filter((x) => !TESTERS.has(x.phone) && x.t >= windowStart);
  const triggers = real.filter((x) => x.type === 'text');
  const answers = real.filter((x) => x.type !== 'text');
  const phones = new Set(real.map((x) => x.phone));
  P(`  הודעות נכנסות (בלי מספרי בדיקה): ${real.length}   טקסט/טריגרים: ${triggers.length}   לחיצות ותשובות: ${answers.length}   משתתפות ייחודיות: ${phones.size}`);
  if (triggers.length) {
    const ts = triggers.map((x) => x.t).sort((a, b) => a - b);
    let best10 = 0, best60 = 0;
    for (let i = 0, j = 0; i < ts.length; i += 1) { while (ts[i] - ts[j] > 10000) j += 1; best10 = Math.max(best10, i - j + 1); }
    for (let i = 0, j = 0; i < ts.length; i += 1) { while (ts[i] - ts[j] > 60000) j += 1; best60 = Math.max(best60, i - j + 1); }
    P(`  שיא הודעות טקסט נכנסות: ${best10} ב-10 שניות, ${best60} בדקה`);
  }
  const resp = (set) => set.map((x) => { const s = (sends.get(x.phone) || []).find((t) => t >= x.t); return s ? s - x.t : null; }).filter((v) => v !== null);
  P('  זמן תגובה: מהגעת ההודעה ללקוחה עד שהודעה ראשונה אליה נרשמה ב-Meta כ-sent');
  lat('טריגרים', resp(triggers));
  lat('לחיצות ותשובות', resp(answers));
  const trigResp = resp(triggers);
  if (trigResp.length >= 10 && q(trigResp, 0.95) > 8000) warn(`תגובה לטריגר p95 = ${fmtMs(q(trigResp, 0.95))} (מעל 8 שניות)`);
  const ansResp = resp(answers);
  if (ansResp.length >= 10 && q(ansResp, 0.95) > 8000) warn(`תגובה ללחיצה p95 = ${fmtMs(q(ansResp, 0.95))} (מעל 8 שניות)`);

  // per 5-minute buckets (Israel time) - degradation over time
  const buckets = new Map();
  for (const x of triggers) {
    const s = (sends.get(x.phone) || []).find((t) => t >= x.t); if (!s) continue;
    const b = Math.floor(x.t / 300000) * 300000;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(s - x.t);
  }
  if (buckets.size > 1) {
    P('  טריגרים לפי 5 דקות (שעון ישראל): n / p50 / p95');
    for (const [b, a] of [...buckets.entries()].sort((x, y) => x[0] - y[0]).slice(-12)) P('    ' + new Date(b).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false, hour: '2-digit', minute: '2-digit' }) + '  ' + String(a.length).padStart(4) + '  ' + fmtMs(q(a, 0.5)).padStart(7) + '  ' + fmtMs(q(a, 0.95)).padStart(7));
  }

  const w = lines;
  P('  --- כשלים ואזהרות (בחלון) ---');
  const rows = countBy(w, [
    ['שליחה נכשלה [SEND_FAIL]', /\[SEND_FAIL\]|SEND_FAILED/],
    ['מסירה נכשלה (status=failed)', /\[META_DELIVERY\].*status=failed/],
    ['META_DELIVERY_FAILED', /META_DELIVERY_FAILED/],
    ['שגיאות קצב Meta (130429/131056/429)', /130429|131056|rate.?limit|\b429\b/i],
    ['תשובה לא תקינה [INVALID_ANSWER]', /INVALID_ANSWER/],
    ['מצב שיחה פגום [STATE_INVALID]', /STATE_INVALID/],
    ['משתתפת נחסמה לבדיקה (needs_review / blocked)', /sender blocked pending admin review|needs_review/],
    ['תוצאה לא ודאית / התאוששות', /uncertain|DELIVERY_RECOVERY|RECOVERY_/i],
    ['המתנה לאישור קובץ פגה [FILE_DELIVERY_WAIT_TIMEOUT]', /FILE_DELIVERY_WAIT_TIMEOUT/],
    ['כתיבה איטית ל-Postgres [POSTGRES_BATCH_SLOW]', /POSTGRES_BATCH_SLOW/],
    ['שגיאות Postgres / חיבורים', /ECONNREFUSED|too many clients|remaining connection slots|pool.*(timeout|exhaust)/i],
    ['inbox של הלקוחה נכשל [META_CLIENT_INBOX…FAILED]', /META_CLIENT_INBOX.*FAIL|META_CLIENT_INBOX_PERSIST/],
    ['לחיצות כפולות שהתעלמנו מהן', /DUPLICATE_REPLY_IGNORED/],
    ['טריגר ישן מדי (STALE)', /trigger.*(stale|too old)|age=\d{3,}s/i],
    ['שורות שגיאה כלליות (Error: / ERROR / [..FAIL..])', /Error:|\bERROR\b|\[[A-Z_]*FAIL[A-Z_]*\]/],
  ]);
  tagTable(rows);
  const failed = rows[1][1] + rows[2][1]; if (failed) warn(`${failed} מסירות נכשלו`);
  if (rows[3][1]) warn(`${rows[3][1]} שורות שגיאות קצב של Meta`);
  if (rows[6][1]) warn(`${rows[6][1]} משתתפות/אירועים בבדיקה ידנית (needs_review)`);
  if (rows[10][1]) warn('שגיאות חיבור/פול של Postgres');
  P('  --- כפתור חוזר ---');
  P(`  הצליח: ${w.filter((l) => /\[REPEATABLE_BUTTON\] /.test(l)).length}   אחרי סיום: ${w.filter((l) => /\[REPEATABLE_BUTTON\].*after-end/.test(l)).length}   נדחה: ${w.filter((l) => /REPEATABLE_BUTTON_REJECTED/.test(l)).length}`);
  return { inbound, sends, windowStart };
}

function gatewayView(GW, CL, windowStart) {
  P('');
  P('=============== השער ===============');
  const lines = GW.filter((l) => T(l) >= windowStart);
  if (!lines.length) { warn('אין שורות בחלון הזה בלוג השער'); return; }
  P(`  מ-${il(T(lines[0]))} עד ${il(T(lines[lines.length - 1]))}, ${lines.length} שורות (כל הלקוחות על המספר)`);
  const restarts = GW.filter((l) => /starting up…/.test(l)).length;
  P(`  עליות שירות בלוג: ${restarts}`);
  const inGw = new Map(); const routed = new Map(); const routeMs = [];
  for (const l of GW) {
    let m;
    if ((m = /\[META_GATEWAY_INBOUND\] (\S+) (\d+) type=(\w+)/.exec(l))) inGw.set(m[1], { t: T(l), phone: m[2], type: m[3] });
    if ((m = /\[META_GATEWAY_ROUTED\] (\S+) (\S+)/.exec(l)) && m[2].startsWith(CLIENT_ID)) {
      routed.set(m[1], T(l));
      const r = /route_ms=(\d+)/.exec(l); if (r && T(l) >= windowStart) routeMs.push(Number(r[1]));
    }
  }
  const inWin = [...inGw.entries()].filter(([, v]) => v.t >= windowStart && !TESTERS.has(v.phone));
  P(`  הודעות שהגיעו לשער בחלון: ${inWin.length}   מתוכן נותבו ללקוחה הזו: ${inWin.filter(([w]) => routed.has(w)).length}`);
  lat('זמן ניתוב בשער (route_ms)', routeMs);
  if (routeMs.length >= 20 && q(routeMs, 0.95) > 2000) warn(`ניתוב בשער p95 = ${fmtMs(q(routeMs, 0.95))}`);
  P('  --- כשלים ואזהרות בשער (בחלון) ---');
  const rows = countBy(lines, [
    ['META_GATEWAY_FAILED (העברה ללקוחה נכשלה)', /META_GATEWAY_FAILED/],
    ['META_GATEWAY_RETRY', /META_GATEWAY_RETRY/],
    ['META_GATEWAY_AMBIGUOUS (דו-משמעות)', /META_GATEWAY_AMBIGUOUS/],
    ['META_GATEWAY_PENDING_CHECK_FAILED', /PENDING_CHECK_FAILED|PENDING_LOOKUP_FAILED/],
    ['META_ROUTES_CACHE_REFRESH_FAILED', /META_ROUTES_CACHE_REFRESH_FAILED/],
    ['META_GATEWAY_CLEAR_PENDING_FAILED', /CLEAR_PENDING_FAILED/],
    ['לקוחה חוסמת עמיתות (התראה)', /could not confirm|blocking peers/i],
    ['הודעות שהשער התעלם מהן', /META_GATEWAY_IGNORED/],
    ['ניתוב כפתור חוזר אחרי סיום', /REPEAT_WINDOW_ROUTED/],
    ['inbox של השער נכשל', /META_GATEWAY_INBOX.*(FAIL|GAVE)|inbox could not/i],
    ['שורות שגיאה כלליות (Error: / ERROR / [..FAIL..])', /Error:|\bERROR\b|\[[A-Z_]*FAIL[A-Z_]*\]/],
  ]);
  tagTable(rows);
  if (rows[0][1]) warn(`${rows[0][1]} כשלי העברה ללקוחה בשער`);
  if (rows[2][1]) warn(`${rows[2][1]} מקרי דו-משמעות בשער`);
  const lastT = T(lines[lines.length - 1]);
  const recentRefresh = lines.filter((l) => T(l) >= lastT - 15 * 60000 && /META_ROUTES_CACHE_REFRESH_FAILED/.test(l)).length;
  if (recentRefresh) warn(`${recentRefresh} כשלי רענון ניתוב ב-15 הדקות האחרונות של הלוג (לקוחה לא זמינה?)`);
  if (rows[6][1]) warn('השער דיווח על לקוחה שחוסמת אחרות');

  // reconciliation gateway -> client
  const clientIn = new Set(CL.map((l) => /\[META_INBOUND\] (\S+)/.exec(l)).filter(Boolean).map((m) => m[1]));
  // Only messages the client's own log could contain: a client log that starts at its newest container knows nothing about earlier ones.
  const clientFrom = CL.length ? T(CL[0]) - 5000 : Infinity;
  const missing = inWin.filter(([w]) => routed.has(w) && routed.get(w) >= clientFrom && !clientIn.has(w));
  const lastClient = CL.length ? T(CL[CL.length - 1]) : 0;
  const stale = missing.filter(([w]) => routed.get(w) < lastClient - 30000);
  P(`  התאמה שער ← לקוחה: נותבו ${inWin.filter(([w]) => routed.has(w)).length}, לא נרשמו אצל הלקוחה: ${missing.length} (מהן ישנות מ-30 שניות: ${stale.length})`);
  if (stale.length) warn(`${stale.length} הודעות נותבו ללקוחה ולא נרשמו אצלה`);
}

async function health(label, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const d = await res.json();
    const o = d.outbox || {}; const cv = d.conversations || {}; const fh = cv.flowHealth || {};
    P(`  ${label}: ok=${d.ok} provider=${d.whatsappProvider} פעילים=${(d.campaigns || {}).active} שיחות פתוחות=${cv.pending}`);
    P(`      outbox: queued=${o.queued} processing=${o.processing} retry=${o.retry} uncertain=${o.uncertain} recoverable_failed=${o.recoverable_failed} failed=${o.failed} deliveryFailed=${o.deliveryFailed}`);
    P(`      flow: inboundQueued=${fh.inboundQueued} maxQueueDepth=${fh.maxQueueDepth} activeSenderQueues=${fh.activeSenderQueues} | storage pendingWrites=${(d.storage || {}).pendingWrites}`);
    if (o.uncertain || o.recoverable_failed) warn(`${label}: ${o.uncertain || 0} uncertain / ${o.recoverable_failed || 0} recoverable_failed ב-outbox`);
    if (!d.ok) warn(`${label}: /health לא ok`);
  } catch (e) { warn(`${label}: /health לא זמין (${e.message})`); }
}

(async () => {
  let dir = NOPULL;
  let pulled = null;
  if (!NOPULL) { pulled = pull(); dir = pulled.dir; }
  const clientFile = path.join(dir, 'client.txt'); const gatewayFile = path.join(dir, 'gateway.txt');
  if (!fs.existsSync(clientFile) || !fs.existsSync(gatewayFile)) { console.error(`missing ${clientFile} or ${gatewayFile}`); process.exit(2); }
  const CL = readLines(clientFile); const GW = readLines(gatewayFile);
  const end = Math.max(CL.length ? T(CL[CL.length - 1]) : 0, GW.length ? T(GW[GW.length - 1]) : 0);
  const windowStart = WINDOW_MIN ? Date.now() - WINDOW_MIN * 60000 : 0;
  P(`דוח קמפיין חי — ${il(Date.now())} (שעון ישראל)` + (WINDOW_MIN ? `   |   חלון: ${WINDOW_MIN} הדקות האחרונות` : '   |   מתחילת הקונטיינר'));
  if (pulled) for (const [k, v] of Object.entries(pulled.info)) P(`  ${k}: ${v.service}  (${v.tasks} קונטיינרים בלוג, נשארו ${v.kept} שורות מהחדש ביותר${v.dropped ? `, ${v.dropped} שורות ישנות הושמטו` : ''})`);
  P(`  קבצים: ${dir}  (מכילים מספרי טלפון — לא לקומט)`);
  P(`  השורה האחרונה בלוג: ${end ? il(end) : '-'} (איחור מהשעה עכשיו: ${end ? Math.round((Date.now() - end) / 1000) : '-'} שניות)`);
  P('');
  clientView(CL, windowStart);
  gatewayView(GW, CL, windowStart);
  P('');
  P('=============== מצב חי (/health) ===============');
  await health('לקוחה', val('client-health', ''.concat('https://client-avshryt-prhym-meta-', CLIENT_ID, '.flowsbiz.com/health')));
  await health('שער', val('gateway-health', 'https://admin.flowsbiz.com/health'));
  P('');
  P(warnings.length ? `=== ${warnings.length} אזהרות ===\n` + warnings.map((w) => ' - ' + w).join('\n') : '=== אין אזהרות ===');
  fs.writeFileSync(path.join(dir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), out.join('\n') + '\n');

  if (has('full')) {
    const env = { ...process.env, TEST_PHONES: [...TESTERS].join(','), LAUNCH_UTC: CL.length ? new Date(T(CL[0])).toISOString() : '' };
    const launch = CL.length ? new Date(T(CL[0])).toISOString() : '2026-10-31T00:00:00Z';
    for (const [name, args] of [['compare-gateway-client.js', [clientFile, gatewayFile, CLIENT_ID, launch]], ['analyze-focus-failures.js', [clientFile, gatewayFile]]]) {
      console.log(`\n########## ${name} ##########`);
      spawnSync('node', [path.join(__dirname, name), ...args], { stdio: 'inherit', env });
    }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
