/**
 * test-health-live.js
 * Covers step 4 (A.2) of docs/safety-speed-deploy-plan-2026-09-02.md:
 * a cheap /health/live probe that never touches storage.
 *
 *  1. /health/live -> 200 {ok:true,live:true}
 *  2. /health/live -> 200 even when the storage layer is broken (stand-in for
 *     "not ready / mid-migration"), while the heavy /health -> 500
 *  3. under a burst of heavy /health calls, every /health/live still returns 200
 *     quickly — it is not queued behind storage work
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = String(42000 + Math.floor(Math.random() * 5000));
process.env.CLIENT_ACCESS_TOKEN = 'health-live-test-token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { startAdminServer } = require('../dist/adminServer');

const base = () => `http://127.0.0.1:${process.env.PORT}`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-live-'));
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    startAdminServer(storage);
    await new Promise((r) => setTimeout(r, 150));

    // 1 — basic
    const r1 = await fetch(`${base()}/health/live`);
    assert.equal(r1.status, 200, '/health/live -> 200');
    assert.deepEqual(await r1.json(), { ok: true, live: true }, '/health/live body');
    console.log('  1. /health/live -> 200 {ok:true,live:true}');

    // 2 — storage broken: liveness still green, heavy health red
    const broke = () => { throw new Error('storage not ready (simulated migration)'); };
    storage.getCampaigns = broke;
    storage.getContactQueueStats = broke;
    storage.getFailedDeliveries = broke;
    storage.getOutboxHealth = broke;
    storage.getStorageHealth = broke;

    const live2 = await fetch(`${base()}/health/live`);
    assert.equal(live2.status, 200, '/health/live still 200 while storage is broken');
    assert.deepEqual(await live2.json(), { ok: true, live: true });

    const heavy2 = await fetch(`${base()}/health`).catch(() => ({ status: 0 }));
    assert.ok(heavy2.status === 500 || heavy2.status === 0, `heavy /health fails when storage is broken (got ${heavy2.status})`);
    console.log('  2. storage broken -> /health/live 200, /health ' + heavy2.status);

    // 3 — /health/live is not queued behind heavy /health work
    // restore storage so /health works again and actually does its scans
    const fresh = new Storage(path.join(dir, 'storage2.json'));
    for (const k of ['getCampaigns', 'getContactQueueStats', 'getFailedDeliveries', 'getOutboxHealth', 'getStorageHealth']) {
      storage[k] = fresh[k].bind(fresh);
    }
    // seed some rows so /health has real work to do
    const c = storage.addCampaign({ name: 'load', triggerType: 1, triggerPhrase: 't', suffix: '', active: true });
    for (let i = 0; i < 300; i++) storage.recordCampaignTrigger(c.id, '97250000' + String(1000 + i), 'p' + i);

    const heavyBurst = Array.from({ length: 30 }, () => fetch(`${base()}/health`).then((r) => r.status).catch(() => 0));
    const liveTimings = [];
    for (let i = 0; i < 40; i++) {
      const t0 = Date.now();
      const r = await fetch(`${base()}/health/live`);
      liveTimings.push(Date.now() - t0);
      assert.equal(r.status, 200, `/health/live #${i} under load -> 200`);
    }
    await Promise.all(heavyBurst);
    liveTimings.sort((a, b) => a - b);
    const p95 = liveTimings[Math.floor(liveTimings.length * 0.95)];
    const max = liveTimings[liveTimings.length - 1];
    assert.ok(p95 < 100, `/health/live p95 stays low under a /health burst (p95=${p95}ms, max=${max}ms)`);
    console.log(`  3. under a 30x /health burst: 40x /health/live all 200, p95=${p95}ms max=${max}ms`);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Health liveness probe tests passed.');
    await new Promise((r) => setTimeout(r, 200));
    process.exit(0);
  } catch (err) {
    console.error(err);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
})();
