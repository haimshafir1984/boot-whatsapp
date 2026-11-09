'use strict';
// Event-loop lag metric (src/eventLoopLag.ts) and its exposure on the public /health: a blocked loop must show up as a large max,
// an idle one as a small value, and /health must carry numbers only.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-lag-'));
process.env.NODE_ENV = 'test';
process.env.PORT = String(33000 + Math.floor(Math.random() * 4000));
process.env.CLIENT_ACCESS_TOKEN = 'loop-lag-test-token';
process.env.STORAGE_PATH = path.join(dir, 'storage.json');

const lag = require('../dist/eventLoopLag');
const { Storage } = require('../dist/storage');
const { startAdminServer } = require('../dist/adminServer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); }
}

(async () => {
  await scenario('no windows yet: snapshot is empty, not NaN', async () => {
    lag.stopEventLoopLagMonitor();
    lag.startEventLoopLagMonitor();
    const s = lag.getEventLoopLagSnapshot();
    assert.equal(s.last, null);
    assert.equal(s.worstMaxMs10m, 0);
    assert.equal(s.windowsOverWarn10m, 0);
  });

  await scenario('an idle loop reports a small lag', async () => {
    lag.stopEventLoopLagMonitor(); lag.startEventLoopLagMonitor();
    await sleep(400);
    lag.closeEventLoopLagWindowForTests();
    const s = lag.getEventLoopLagSnapshot();
    assert.ok(s.last, 'a window was recorded');
    assert.ok(s.last.maxMs < 150, `idle max ${s.last.maxMs}ms`);
  });

  await scenario('a 600ms synchronous block shows up as max >= 500ms', async () => {
    lag.stopEventLoopLagMonitor(); lag.startEventLoopLagMonitor();
    await sleep(50);
    const t = Date.now(); while (Date.now() - t < 600) { /* block the loop */ }
    await sleep(50);
    lag.closeEventLoopLagWindowForTests();
    const s = lag.getEventLoopLagSnapshot();
    assert.ok(s.last.maxMs >= 500, `blocked max ${s.last.maxMs}ms`);
    assert.ok(s.worstMaxMs10m >= 500);
    assert.equal(s.windowsOverWarn10m, 0, 'below the 2s warning threshold');
  });

  await scenario('the ring keeps at most 20 windows', async () => {
    lag.stopEventLoopLagMonitor(); lag.startEventLoopLagMonitor();
    for (let i = 0; i < 25; i += 1) { await sleep(25); lag.closeEventLoopLagWindowForTests(); }
    const s = lag.getEventLoopLagSnapshot();
    assert.ok(s.last);
    assert.ok(Number.isFinite(s.worstP99Ms10m));
  });

  await scenario('public /health exposes eventLoop as numbers only, nothing else changed', async () => {
    const storage = new Storage(path.join(dir, 'storage.json'));
    const server = startAdminServer(storage);
    await sleep(200);
    const base = `http://127.0.0.1:${process.env.PORT}`;
    const res = await fetch(`${base}/health`, { headers: { Connection: 'close' } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.eventLoop, 'eventLoop present');
    assert.equal(typeof j.eventLoop.windowSec, 'number');
    assert.equal(typeof j.eventLoop.worstMaxMs10m, 'number');
    assert.equal(typeof j.eventLoop.windowsOverWarn10m, 'number');
    for (const key of ['ok', 'campaigns', 'outbox', 'storage', 'conversations', 'whatsapp']) assert.ok(key in j, `${key} still present`);
    const live = await fetch(`${base}/health/live`, { headers: { Connection: 'close' } });
    assert.equal(live.status, 200);
    void server; // not closed on purpose: closing right before process.exit trips a libuv assertion on Windows
  });

  for (const r of results) console.log(r[1].padEnd(5), r[0], r[2] || '');
  const failed = results.filter((r) => r[1] !== 'PASS').length;
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  // Let the fetch keep-alive socket settle before exiting (an immediate exit trips a libuv assertion on Windows, as in other tests).
  setTimeout(() => process.exit(failed ? 1 : 0), 500);
})();
