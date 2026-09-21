/**
 * Preloaded into every process of the C6 system load harness (`node --require scripts/lib/load-preload.js dist/index.js`):
 *  - a fake Meta Graph API: every POST to graph.facebook.com answers 200 with a wamid after a modelled latency (text ~150ms,
 *    media ~900ms) and prints one `@@SEND {t,to,type}` line, so the driver can measure trigger -> first response;
 *  - event-loop lag sampling: one `@@LAG {t,p99,max}` line every 2s (histogram reset each time).
 * Nothing leaves the machine. Real code paths otherwise: the real gateway, the real clients, PostgreSQL.
 */
const { monitorEventLoopDelay } = require('node:perf_hooks');

const TEXT_MS = Number(process.env.FAKE_META_TEXT_MS || 150);
const MEDIA_MS = Number(process.env.FAKE_META_MEDIA_MS || 900);
const realFetch = globalThis.fetch;
let seq = 0;
globalThis.fetch = async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!/graph\.facebook\.com/.test(url)) return realFetch(input, init);
  let body = {};
  try { body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch { /* multipart upload etc. */ }
  const isMedia = /\/media$/.test(url) || body?.type === 'image' || body?.type === 'video' || body?.type === 'document';
  await new Promise((r) => setTimeout(r, isMedia ? MEDIA_MS : TEXT_MS));
  if (/\/media$/.test(url)) return new Response(JSON.stringify({ id: 'media.FAKE' + (++seq) }), { status: 200, headers: { 'content-type': 'application/json' } });
  const id = `wamid.FAKE${process.pid}.${++seq}`;
  console.log('@@SEND ' + JSON.stringify({ t: Date.now(), to: String(body?.to || ''), type: body?.type || 'unknown', id }));
  return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const hist = monitorEventLoopDelay({ resolution: 5 });
hist.enable();
const timer = setInterval(() => {
  console.log('@@LAG ' + JSON.stringify({ t: Date.now(), p99: +(hist.percentile(99) / 1e6).toFixed(1), max: +(hist.max / 1e6).toFixed(1) }));
  hist.reset();
}, 2000);
timer.unref();

// graceful stop on platforms without POSIX signals (Windows): the harness sends 'SIGTERM' over IPC; the app's own handler runs.
process.on('message', (m) => { if (m === 'SIGTERM') process.emit('SIGTERM', 'SIGTERM'); });

// measurement-only shutdown stage timestamps (no product code is changed): when server.close() is called and when it calls back,
// and when a pg pool is ended (inbox stop() ends its pools after waiting for in-flight work).
{
  const http = require('node:http');
  const live = new Map();   // in-flight HTTP requests (measurement only)
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function patchedEmit(ev, req, res) {
    if (ev === 'request' && req && res) { const id = Symbol(); live.set(id, { url: String(req.url).slice(0, 80), method: req.method, at: Date.now() }); res.on('close', () => live.delete(id)); }
    return origEmit.apply(this, arguments);
  };
  const origClose = http.Server.prototype.close;
  http.Server.prototype.close = function patchedClose(cb) {
    const t = Date.now(); console.log('@@STAGE server.close called ' + t);
    const snap = () => JSON.stringify({ requestsInFlight: [...live.values()].map((r) => `${r.method} ${r.url} age=${Date.now() - r.at}ms`).slice(0, 10), n: live.size });
    console.log('@@STAGE at close: ' + snap());
    const srv = this;
    const socks = () => process._getActiveHandles().filter((h) => h && h.constructor && h.constructor.name === 'Socket' && h.server === srv).map((h) => `remote=${h.remoteAddress}:${h.remotePort} local=${h.localPort} bytesRead=${h.bytesRead} idleSinceLastReadOrWrite=?`);
    console.log('@@STAGE sockets at close: ' + JSON.stringify(socks()).slice(0, 700));
    const tm = setTimeout(() => console.log('@@STAGE close still pending after 2s: ' + snap() + ' sockets=' + JSON.stringify(socks()).slice(0, 900)), 2000); tm.unref();
    return origClose.call(this, function () { console.log('@@STAGE server.close done +' + (Date.now() - t) + 'ms'); if (cb) return cb.apply(this, arguments); });
  };
  try {
    const pg = require(require.resolve('pg', { paths: [process.cwd(), __dirname + '/../..'] }));
    const origEnd = pg.Pool.prototype.end;
    pg.Pool.prototype.end = function patchedEnd() { console.log('@@STAGE pg pool.end called ' + Date.now()); return origEnd.apply(this, arguments); };
  } catch { /* pg not resolvable from here */ }
}
