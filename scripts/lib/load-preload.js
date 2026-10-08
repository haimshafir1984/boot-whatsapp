/**
 * Preloaded into every process of the C6 system load harness (`node --require scripts/lib/load-preload.js dist/index.js`):
 *  - a fake Meta Graph API: every POST to graph.facebook.com answers 200 with a wamid after a modelled latency (text ~150ms,
 *    media ~900ms) and prints one `@@SEND {t,to,type}` line, so the driver can measure trigger -> first response;
 *  - event-loop lag sampling: one `@@LAG {t,p99,max}` line every 2s (histogram reset each time).
 * Nothing leaves the machine. Real code paths otherwise: the real gateway, the real clients, PostgreSQL.
 */
const { monitorEventLoopDelay } = require('node:perf_hooks');
// measurement-only: Storage.flush() calls (all callers, and the ones made while serving /internal/meta/whatsapp - the gateway's status endpoint),
// cumulative, printed every 5s as @@FL. `ms` is how long callers WAITED for the flush (an async wait), not event-loop blocking.
const { AsyncLocalStorage } = require('node:async_hooks');
const flowCtx = new AsyncLocalStorage();
const fl = { calls: 0, ms: 0, max: 0, epCalls: 0, epMs: 0, epRequests: 0, outboxLookups: 0 };

const TEXT_MS = Number(process.env.FAKE_META_TEXT_MS || 150);
const MEDIA_MS = Number(process.env.FAKE_META_MEDIA_MS || 900);
const realFetch = globalThis.fetch;
let seq = 0;
globalThis.fetch = async function fakeFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!/graph\.facebook\.com/.test(url)) return realFetch(input, init);
  // Shared fake Meta (scripts/lib/fake-meta-server.js): one process for every client, so the number-wide throughput limit, faults and
  // delivery-status webhooks are modelled once. Without it each process fakes Meta on its own (legacy mode, unchanged).
  if (process.env.FAKE_META_URL) return realFetch(url.replace(/^https:\/\/graph\.facebook\.com/, process.env.FAKE_META_URL), init);
  let body = {};
  try { body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch { /* multipart upload etc. */ }
  const isMedia = /\/media$/.test(url) || body?.type === 'image' || body?.type === 'video' || body?.type === 'document';
  await new Promise((r) => setTimeout(r, isMedia ? MEDIA_MS : TEXT_MS));
  if (/\/media$/.test(url)) return new Response(JSON.stringify({ id: 'media.FAKE' + (++seq) }), { status: 200, headers: { 'content-type': 'application/json' } });
  const id = `wamid.FAKE${process.pid}.${++seq}`;
  console.log('@@SEND ' + JSON.stringify({ t: Date.now(), to: String(body?.to || ''), type: body?.type || 'unknown', id }));
  return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

let cpuPrev = process.cpuUsage(); let tPrev = Date.now();
const hist = monitorEventLoopDelay({ resolution: 5 });
hist.enable();
const timer = setInterval(() => {
  const nowT = Date.now(); const elapsedMs = nowT - tPrev; tPrev = nowT;
  const cpu = process.cpuUsage(cpuPrev); cpuPrev = process.cpuUsage();
  console.log('@@LAG ' + JSON.stringify({ t: Date.now(), p99: +(hist.percentile(99) / 1e6).toFixed(1), max: +(hist.max / 1e6).toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1048576), elapsedMs, cpuPct: Math.round((cpu.user + cpu.system) / 10 / Math.max(elapsedMs, 1)) }));   // CPU time / REAL wall time between samples (the timer itself fires late when the loop is blocked)
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
    if (ev === 'request' && req && res && String(req.url).startsWith('/internal/meta/whatsapp')) { fl.epRequests += 1; const args = arguments; return flowCtx.run({ ep: true }, () => origEmit.apply(this, args)); }
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

// measurement-only: cost of every conversationState.set()/remove() call (the synchronous part the bot pays per message), windowed per
// 60s, plus the number of conversations held. Nothing about the behaviour changes.
{
  const Module = require('node:module');
  const origLoad = Module._load;
  let win = []; let size = () => null; let wrapped = false; let flWrapped = false;
  Module._load = function patchedLoad(request) {
    const m = origLoad.apply(this, arguments);
    if (!flWrapped && m && m.Storage && m.Storage.prototype && typeof m.Storage.prototype.flush === 'function') {
      flWrapped = true; const proto = m.Storage.prototype; const origFlush = proto.flush;
      if (typeof proto.getOutboxMessage === 'function') { const origGet = proto.getOutboxMessage; proto.getOutboxMessage = function countedGet() { fl.outboxLookups += 1; return origGet.apply(this, arguments); }; }   // waitForOutboxFileDelivery polls this
      proto.flush = async function timedFlush() {
        const t = process.hrtime.bigint(); const ep = Boolean(flowCtx.getStore() && flowCtx.getStore().ep); fl.calls += 1; if (ep) fl.epCalls += 1;
        try { return await origFlush.apply(this, arguments); } finally { const ms = Number(process.hrtime.bigint() - t) / 1e6; fl.ms += ms; if (ms > fl.max) fl.max = ms; if (ep) fl.epMs += ms; }
      };
    }
    if (!wrapped && m && m.conversationState && typeof m.conversationState.set === 'function') {
      wrapped = true;
      const cs = m.conversationState;
      size = () => { try { return cs.size(); } catch { return null; } };
      for (const name of ['set', 'remove']) {
        const orig = cs[name].bind(cs);
        cs[name] = function timed() { const t = process.hrtime.bigint(); try { return orig.apply(null, arguments); } finally { win.push(Number(process.hrtime.bigint() - t) / 1e6); } };
      }
    }
    return m;
  };
  const csTimer = setInterval(() => {
    if (!wrapped) return;
    const a = win; win = []; a.sort((x, y) => x - y);
    const q = (p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))].toFixed(3) : null);
    console.log('@@CS ' + JSON.stringify({ t: Date.now(), ops: a.length, p50: q(50), p99: q(99), max: a.length ? +a[a.length - 1].toFixed(3) : null, size: size() }));
  }, 60000);
  csTimer.unref();
}

// measurement-only: every synchronous write to the gateway's status journal (meta-status-forward.jsonl) - how many, how many bytes, how long
// the event loop was blocked inside them - and every compaction rewrite (writeFileSync of the .tmp + rename). Cumulative, printed every 5s;
// nothing is printed in processes that never touch that file.
{
  const fsm = require('node:fs');
  const jw = { appends: 0, appendedLines: 0, appendedBytes: 0, appendMs: 0, rewrites: 0, rewriteMs: 0, rewrittenBytes: 0 };
  const isJournal = (p) => typeof p === 'string' && /meta-status-forward\.jsonl(\.tmp)?$/.test(p);
  const origAppend = fsm.appendFileSync;
  fsm.appendFileSync = function patchedAppend(p, data) {
    if (!isJournal(p)) return origAppend.apply(this, arguments);
    const t = process.hrtime.bigint();
    try { return origAppend.apply(this, arguments); } finally {
      jw.appendMs += Number(process.hrtime.bigint() - t) / 1e6; jw.appends += 1;
      const str = typeof data === 'string' ? data : String(data); jw.appendedBytes += Buffer.byteLength(str); jw.appendedLines += (str.match(/\n/g) || []).length;
    }
  };
  const origWrite = fsm.writeFileSync;
  fsm.writeFileSync = function patchedWrite(p, data, opts) {
    // appendFileSync() calls writeFileSync(..., {flag:'a'}) internally: that is an append, already counted above, not a compaction rewrite
    if (!isJournal(p) || (opts && typeof opts === 'object' && opts.flag === 'a')) return origWrite.apply(this, arguments);
    const t = process.hrtime.bigint();
    try { return origWrite.apply(this, arguments); } finally { jw.rewriteMs += Number(process.hrtime.bigint() - t) / 1e6; jw.rewrites += 1; jw.rewrittenBytes += typeof data === 'string' ? Buffer.byteLength(data) : (data && data.length) || 0; }
  };
  const jwTimer = setInterval(() => { if (jw.appends || jw.rewrites) console.log('@@JW ' + JSON.stringify({ t: Date.now(), ...jw, appendMs: Math.round(jw.appendMs), rewriteMs: Math.round(jw.rewriteMs) })); }, 5000);
  jwTimer.unref();
}

{ const flTimer = setInterval(() => { if (fl.calls) console.log('@@FL ' + JSON.stringify({ t: Date.now(), ...fl, ms: Math.round(fl.ms), epMs: Math.round(fl.epMs), max: Math.round(fl.max) })); }, 5000); flTimer.unref(); }
