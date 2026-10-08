#!/usr/bin/env node
/**
 * Gateway -> client proxy for the peak harness. The gateway's managementUrl for every client points here, which gives the harness
 * (1) exact fan-out accounting - how many internal calls of each kind (status / inbound / pending-route / clear-pending / routes) each
 * client really receives, and how long each took as the GATEWAY sees it; (2) the true delivery-status lag (Meta posted it ->
 * it reached the client that owns the recipient); and (3) a way to degrade ONE client without touching product code: slow, hang,
 * flaky, or refuse connections - the failure shapes the gateway's fail-closed routing has to survive.
 *
 * Config: env PX_CONFIG {listeners:[{id,port,target}], prefixOwner:{"97251":"c0",...}}. IPC: {cmd:'mode', id, mode, ms, rate} | {cmd:'dump'}.
 *   mode: ok | delay (ms) | hang | flaky (rate -> 503) | refuse (listener closed: real ECONNREFUSED)
 */
const http = require('node:http');
const cfg = JSON.parse(process.env.PX_CONFIG);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CATS = ['status', 'inbound', 'pending', 'clear', 'routes', 'other'];
const maxOf = (a) => { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; };   // maxOf(a) throws RangeError above ~120k elements
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const summarize = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: a.length ? maxOf(a) : null });

const L = new Map();   // id -> state
const batchSizes = []; let statusItemsTotal = 0;   // statuses per HTTP request (1 without batching)
const statusesOf = (obj) => { const out = []; for (const e of Array.isArray(obj && obj.entry) ? obj.entry : []) for (const c of Array.isArray(e && e.changes) ? e.changes : []) for (const x of Array.isArray(c && c.value && c.value.statuses) ? c.value.statuses : []) out.push(x); return out; };
const lagAll = { sent: [], delivered: [], read: [], failed: [] }; let lagWin = [];
const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function classify(req, body) {
  const u = req.url || '';
  if (u.startsWith('/internal/meta/whatsapp')) return /"statuses"\s*:\s*\[/.test(body) && !/"messages"\s*:\s*\[/.test(body) ? 'status' : 'inbound';
  if (u.startsWith('/owner-api/meta-pending-route')) return 'pending';
  if (u.startsWith('/owner-api/meta-clear-pending')) return 'clear';
  if (u.startsWith('/owner-api/meta-routes')) return 'routes';
  return 'other';
}

function makeListener(spec) {
  const st = { id: spec.id, port: spec.port, target: spec.target, mode: 'ok', ms: 0, rate: 0, server: null, held: new Set(),
    counts: Object.fromEntries(CATS.map((c) => [c, 0])), errors: Object.fromEntries(CATS.map((c) => [c, 0])), lat: Object.fromEntries(CATS.map((c) => [c, []])), statusLagOwner: { sent: [], delivered: [], read: [], failed: [] } };
  st.build = () => http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const buf = Buffer.concat(chunks); const body = buf.toString('utf8'); const cat = classify(req, body); const t0 = Date.now();
      st.counts[cat] += 1;
      let parsedStatuses = null;
      if (cat === 'status') { try { parsedStatuses = statusesOf(JSON.parse(body)); } catch { parsedStatuses = []; } statusItemsTotal += parsedStatuses.length; st.statusItems = (st.statusItems || 0) + parsedStatuses.length; batchSizes.push(parsedStatuses.length); }
      if (st.mode === 'hang') { st.held.add(res); res.on('close', () => st.held.delete(res)); st.errors[cat] += 1; return; }
      if (st.mode === 'delay') await sleep(st.ms);
      if (st.mode === 'flaky' && Math.random() < st.rate) { st.errors[cat] += 1; res.writeHead(503); res.end('{"error":"flaky"}'); return; }
      const up = http.request({ host: '127.0.0.1', port: st.target, path: req.url, method: req.method, agent, headers: { ...req.headers, 'content-length': buf.length } }, (ur) => {
        res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res);
        ur.on('end', () => {
          const ms = Date.now() - t0; st.lat[cat].push(ms); if ((ur.statusCode || 500) >= 500) st.errors[cat] += 1;
          if (cat === 'status' && (ur.statusCode || 0) < 300) {
            try {
              for (const s of parsedStatuses || []) {
                const owner = cfg.prefixOwner[String(s.recipient_id || '').slice(0, 5)];
                if (owner === st.id && s.x_posted_ms && lagAll[s.status]) { const lag = Date.now() - s.x_posted_ms; st.statusLagOwner[s.status].push(lag); lagAll[s.status].push(lag); lagWin.push(lag); }
              }
            } catch { /* not JSON */ }
          }
        });
      });
      up.on('error', () => { st.errors[cat] += 1; req.socket.destroy(); });   // a dead client: the gateway sees a refused/reset connection, not a tidy 502
      up.end(buf);
    });
  });
  const build = st.build; st.build = () => { const srv = build(); srv.keepAliveTimeout = 30000; return srv; };
  st.server = st.build();
  return st;
}
const listen = (st) => new Promise((resolve) => st.server.listen(st.port, '127.0.0.1', resolve));
(async () => {
  for (const spec of cfg.listeners) { const st = makeListener(spec); L.set(spec.id, st); await listen(st); }
  console.log('@@READY ' + cfg.listeners.length);
})();

const snapshot = (full) => {
  const per = {}; const tot = Object.fromEntries(CATS.map((c) => [c, 0])); const errTot = Object.fromEntries(CATS.map((c) => [c, 0]));
  for (const [id, st] of L) {
    per[id] = { mode: st.mode, counts: { ...st.counts }, errors: { ...st.errors } };
    if (full) { per[id].latencyMs = Object.fromEntries(CATS.map((c) => [c, summarize(st.lat[c])])); per[id].statusLagOwnerMs = Object.fromEntries(Object.entries(st.statusLagOwner).map(([k, v]) => [k, summarize(v)])); }
    for (const c of CATS) { tot[c] += st.counts[c]; errTot[c] += st.errors[c]; }
  }
  const out = { t: Date.now(), statusItemsTotal, statusRequestsTotal: tot.status, totals: tot, errorTotals: errTot, statusLagWindowMs: summarize(lagWin), per };
  if (full) { out.statusBatchSize = summarize(batchSizes); out.statusBatchSizeOver1 = batchSizes.filter((x) => x > 1).length; out.statusLagMs = Object.fromEntries(Object.entries(lagAll).map(([k, v]) => [k, summarize(v)])); out.latencyAllClientsMs = Object.fromEntries(CATS.map((c) => { const a = []; for (const st of L.values()) for (const x of st.lat[c]) a.push(x); return [c, summarize(a)]; })); }
  return out;
};
setInterval(() => { console.log('@@PX ' + JSON.stringify(snapshot(false))); lagWin = []; }, 10000).unref();

process.on('message', async (m) => {
  if (m?.cmd === 'dump') { console.log('@@PXDUMP ' + JSON.stringify(snapshot(true))); if (process.send) process.send({ dumped: true }); return; }
  if (m?.cmd !== 'mode') return;
  const targets = m.id === 'all' ? [...L.values()] : [L.get(m.id)].filter(Boolean);
  for (const st of targets) {
    const was = st.mode; st.mode = m.mode; st.ms = m.ms || 0; st.rate = m.rate || 0;
    if (was === 'refuse' && m.mode !== 'refuse') { st.server = st.build(); await listen(st); }
    if (m.mode === 'refuse' && was !== 'refuse') { st.server.close(); st.server.closeAllConnections?.(); }
    if (was === 'hang' && m.mode !== 'hang') for (const r of st.held) { try { r.socket.destroy(); } catch { /* gone */ } }
    console.log('@@PX_MODE ' + JSON.stringify({ id: st.id, mode: m.mode, ms: st.ms, rate: st.rate, t: Date.now() }));
  }
});
