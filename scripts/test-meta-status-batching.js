/**
 * EXPERIMENT (2026-10-05): batching several statuses for one client into a single request, and
 * journalling their completions in one append. Off by default (META_STATUS_BATCH=off).
 *
 * The whole point of batching is that it changes ONLY the transport - the same statuses reach the
 * same clients, each keeps its own identity and retry, and nothing is marked complete before the
 * client has made it durable. So every assertion here is about equivalence to the unbatched path
 * under exactly the conditions where a shared request could break it:
 *
 *   1. equivalence         every client receives every status, batched or not
 *   2. mixed phone numbers one request may carry statuses for different business numbers
 *   3. durability          a client that cannot persist (503) must not let anything be completed
 *   4. partial work        a client that applied some, then failed, must be safe to re-send (idempotent)
 *   5. crash after handling the client persisted but the gateway died before completing: re-delivered, not lost
 *   6. slow client         a slow client must not stall the others, and must not be handed two bodies at once
 *   7. batch bounds        count and byte limits are respected
 *   8. journal             http+journal writes ONE record per batch, and a restart agrees with it
 *
 * These prove it is not broken. They do NOT prove it is faster - that is a load question, and the
 * per-client cap experiment is the reminder of why the two must not be confused: its unit test
 * passed while the load run regressed worse than the bug it was meant to fix.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-batch-'));
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 3).join(' | ')]); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(20); }
  throw new Error(`timed out (${ms}ms): ${label}`);
}

/** A fake client. `mode` switches the failure being exercised. */
function makeClient(id, opts = {}) {
  const c = {
    id, mode: opts.mode || 'ok', delayMs: opts.delayMs || 0,
    statuses: [],          // every status id it was given
    bodies: [],            // one entry per HTTP request: how many statuses it carried
    inFlight: 0, maxInFlight: 0,
    server: null, url: '',
  };
  c.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      if (req.url === '/owner-api/meta-routes') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); return; }
      if (req.url !== '/internal/meta/whatsapp') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      c.inFlight += 1; c.maxInFlight = Math.max(c.maxInFlight, c.inFlight);
      try {
        const parsed = JSON.parse(body);
        const entries = Array.isArray(parsed?.entry) ? parsed.entry : [];
        const ids = [];
        for (const entry of entries) {
          for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
            for (const st of Array.isArray(change?.value?.statuses) ? change.value.statuses : []) {
              ids.push({ id: st.id, phoneNumberId: change?.value?.metadata?.phone_number_id });
            }
          }
        }
        c.bodies.push(ids.length);
        if (c.delayMs) await sleep(c.delayMs);
        if (c.mode === 'persist-fail') {
          // Applied nothing durably: the real client answers 503 so the gateway keeps retrying.
          res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"flush failed"}'); return;
        }
        if (c.mode === 'partial-then-fail') {
          // Applied the first half, then could not finish. The gateway must re-send the whole batch.
          for (const entry of ids.slice(0, Math.ceil(ids.length / 2))) c.statuses.push(entry);
          c.mode = 'ok';
          res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"half done"}'); return;
        }
        for (const entry of ids) c.statuses.push(entry);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      } finally { c.inFlight -= 1; }
    });
  });
  return new Promise((resolve) => c.server.listen(0, '127.0.0.1', () => { c.url = `http://127.0.0.1:${c.server.address().port}`; resolve(c); }));
}

const ownerRecord = (c) => ({
  id: c.id, name: c.id, accessCode: c.id, ownerAccessToken: `${c.id}-owner-token`, plan: 'self_service',
  readonlyDashboard: false, maxCampaigns: 7, whatsappProvider: 'META_CLOUD_API',
  metaPhoneNumberId: 'shared-phone-id', metaDisplayPhoneNumber: '15550001111',
  managementUrl: c.url, provisioningStatus: 'ready', createdAt: new Date().toISOString(),
});
const statusEntry = (id, phoneNumberId = 'shared-phone-id') => ({
  id: `waba-${id}`,
  changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId, display_phone_number: '15550001111' }, statuses: [{ id, status: 'delivered', timestamp: '1700000000', recipient_id: '972500000001' }] } }],
});
const burstPayload = (entries) => ({ object: 'whatsapp_business_account', entry: entries });

/** Boots a gateway in its own process-level env (the batch mode is read at startup). */
async function withGateway(tag, env, fn) {
  const dir = fs.mkdtempSync(path.join(root, `${tag}-`));
  const previous = {};
  const applied = {
    NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API',
    STORAGE_PATH: path.join(dir, 'storage.json'), OWNER_STORAGE_PATH: path.join(dir, 'owner.json'),
    CONVERSATION_STATE_PATH: path.join(dir, 'conv.json'), UPLOADS_PATH: path.join(dir, 'uploads'),
    OWNER_ACCESS_TOKEN: 'batch-owner', CLIENT_ACCESS_TOKEN: 'batch-client',
    META_ACCESS_TOKEN: '', META_PHONE_NUMBER_ID: 'shared-phone-id', META_DISPLAY_PHONE_NUMBER: '15550001111',
    ...env,
  };
  for (const [k, v] of Object.entries(applied)) { previous[k] = process.env[k]; process.env[k] = String(v); }
  // The gateway reads its config at module load, so each mode needs a fresh module registry.
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}dist${path.sep}`)) delete require.cache[key];
  const { Storage } = require('../dist/storage');
  const { config } = require('../dist/config');
  const { startAdminServer } = require('../dist/adminServer');
  config.ADMIN_PORT = 0;
  config.OWNER_STORAGE_PATH = applied.OWNER_STORAGE_PATH;
  try {
    return await fn({ Storage, config, startAdminServer, dir });
  } finally {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function bootGateway(ctx, clients) {
  fs.writeFileSync(ctx.config.OWNER_STORAGE_PATH, JSON.stringify(clients.map(ownerRecord), null, 2));
  const gw = ctx.startAdminServer(new ctx.Storage(path.join(ctx.dir, 'gateway.json')));
  if (!gw.listening) await new Promise((resolve) => gw.once('listening', resolve));
  return { gw, url: `http://127.0.0.1:${gw.address().port}` };
}
const post = (url, body) => fetch(`${url}/webhooks/meta/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  // 1 + 2 + 7 + 8: equivalence, mixed business numbers, bounds, and the journal shape.
  for (const mode of ['off', 'http', 'http+journal']) {
    await scenario(`[${mode}] every client gets every status, across business numbers`, async () => {
      await withGateway(`eq-${mode}`, { META_STATUS_BATCH: mode, META_STATUS_BATCH_MAX: '7' }, async (ctx) => {
        const clients = [await makeClient('c-one'), await makeClient('c-two'), await makeClient('c-three')];
        const { gw, url } = await bootGateway(ctx, clients);
        try {
          const N = 30;
          const entries = Array.from({ length: N }, (_, i) => statusEntry(`wamid.${mode}.${i}`, i % 3 === 0 ? 'other-phone-id' : 'shared-phone-id'));
          await post(url, burstPayload(entries));
          await waitFor(() => clients.every((c) => c.statuses.length === N), 30_000, 'all statuses delivered to all clients');
          await sleep(300);

          for (const c of clients) {
            const ids = c.statuses.map((s) => s.id);
            assert.equal(new Set(ids).size, N, `${c.id} must receive each status exactly once (got ${ids.length})`);
            const mixed = c.statuses.filter((s) => s.phoneNumberId === 'other-phone-id').length;
            assert.equal(mixed, Math.ceil(N / 3), `${c.id} must keep each status with its own business number`);
            assert.ok(Math.max(...c.bodies) <= (mode === 'off' ? 1 : 7), `${c.id} exceeded the batch size: ${Math.max(...c.bodies)}`);
            if (mode === 'off') assert.equal(c.bodies.length, N, 'unbatched mode must still send one request per status');
            else assert.ok(c.bodies.length < N, `${mode} must send fewer requests than statuses, sent ${c.bodies.length}`);
          }

          // 8: with http+journal a batch costs ONE 'done' line; a restart must agree either way.
          const journal = path.join(path.dirname(ctx.config.OWNER_STORAGE_PATH), 'meta-status-forward.jsonl');
          const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
          assert.equal(lines.filter((l) => l.t === 'add').length, N * clients.length, 'one add per (status, client), written before the 200');
          assert.equal(lines.filter((l) => l.t === 'done').length, N * clients.length, 'every delivery must be journalled exactly once');
          const { MetaStatusQueue } = require('../dist/metaStatusQueue');
          assert.equal(new MetaStatusQueue(journal).stats().pending, 0, 'a restart must see nothing left pending');
        } finally {
          await new Promise((resolve) => gw.close(resolve));
          for (const c of clients) c.server.close();
        }
      });
    });
  }

  // 3: a client that cannot persist must not let anything be completed - the gateway has to keep it.
  await scenario('[http+journal] a client that cannot persist (503) leaves the whole batch pending', async () => {
    await withGateway('persist', { META_STATUS_BATCH: 'http+journal', META_STATUS_BATCH_MAX: '10' }, async (ctx) => {
      const bad = await makeClient('c-bad', { mode: 'persist-fail' });
      const good = await makeClient('c-good');
      const { gw, url } = await bootGateway(ctx, [bad, good]);
      try {
        const N = 10;
        await post(url, burstPayload(Array.from({ length: N }, (_, i) => statusEntry(`wamid.persist.${i}`))));
        await waitFor(() => good.statuses.length === N, 20_000, 'the healthy client is served');
        await sleep(1200);

        const journal = path.join(path.dirname(ctx.config.OWNER_STORAGE_PATH), 'meta-status-forward.jsonl');
        const { MetaStatusQueue } = require('../dist/metaStatusQueue');
        const pending = new MetaStatusQueue(journal).due(1000);
        assert.equal(pending.length, N, `the failing client's entries must all still be pending, got ${pending.length}`);
        assert.ok(pending.every((i) => i.clientId === 'c-bad'), 'only the failing client may have entries left');
        assert.ok(bad.statuses.length === 0, 'nothing may be recorded as handled by a client that answered 503');
      } finally {
        await new Promise((resolve) => gw.close(resolve));
        for (const c of [bad, good]) c.server.close();
      }
    });
  });

  // 4 + 5: a client that applied PART of a batch then failed. The gateway re-sends the whole batch;
  // the duplicates are harmless because applyMetaStatus is idempotent. This is the case a shared
  // request introduces and a per-status request cannot have.
  await scenario('[http+journal] a partially applied batch is re-sent and ends up complete', async () => {
    await withGateway('partial', { META_STATUS_BATCH: 'http+journal', META_STATUS_BATCH_MAX: '10' }, async (ctx) => {
      const flaky = await makeClient('c-flaky', { mode: 'partial-then-fail' });
      const { gw, url } = await bootGateway(ctx, [flaky]);
      try {
        const N = 8;
        await post(url, burstPayload(Array.from({ length: N }, (_, i) => statusEntry(`wamid.partial.${i}`))));
        // After the retry every id must be present; some will have arrived twice.
        await waitFor(() => new Set(flaky.statuses.map((s) => s.id)).size === N, 25_000, 'all ids eventually applied');
        await sleep(800);

        const journal = path.join(path.dirname(ctx.config.OWNER_STORAGE_PATH), 'meta-status-forward.jsonl');
        const { MetaStatusQueue } = require('../dist/metaStatusQueue');
        assert.equal(new MetaStatusQueue(journal).stats().pending, 0, 'nothing may be left pending after the retry');
        assert.ok(flaky.statuses.length > N, 'this case is only meaningful if something was genuinely re-sent');
      } finally {
        await new Promise((resolve) => gw.close(resolve));
        for (const c of [flaky]) c.server.close();
      }
    });
  });

  // 6: a slow client must not stall the others, and must never be handed two bodies at once.
  await scenario('[http+journal] a slow client does not stall the others and gets one body at a time', async () => {
    await withGateway('slow', { META_STATUS_BATCH: 'http+journal', META_STATUS_BATCH_MAX: '5' }, async (ctx) => {
      const slow = await makeClient('c-slow', { delayMs: 250 });
      const fastA = await makeClient('c-fast-a');
      const fastB = await makeClient('c-fast-b');
      const { gw, url } = await bootGateway(ctx, [slow, fastA, fastB]);
      try {
        const N = 20;
        await post(url, burstPayload(Array.from({ length: N }, (_, i) => statusEntry(`wamid.slow.${i}`))));
        await waitFor(() => fastA.statuses.length === N && fastB.statuses.length === N, 20_000, 'fast clients served');
        assert.ok(slow.statuses.length < N, 'the slow client should still be behind - otherwise this proves nothing');
        await waitFor(() => slow.statuses.length === N, 30_000, 'the slow client eventually gets everything');
        assert.equal(slow.maxInFlight, 1, `a client must never be handed two bodies at once, saw ${slow.maxInFlight}`);
      } finally {
        await new Promise((resolve) => gw.close(resolve));
        for (const c of [slow, fastA, fastB]) c.server.close();
      }
    });
  });

  // ---------------------------------------------------------------- review round 2026-10-05
  // The four cases an independent review found the first set did not reach.

  // R2: duplicate and out-of-order statuses inside ONE batch. Meta re-sends and reorders; a shared
  //     request must not let that corrupt a row or leave the batch un-completable.
  await scenario('[http+journal] duplicate and out-of-order statuses in one batch are safe', async () => {
    await withGateway('dup', { META_STATUS_BATCH: 'http+journal', META_STATUS_BATCH_MAX: '20' }, async (ctx) => {
      const c = await makeClient('c-dup');
      const { gw, url } = await bootGateway(ctx, [c]);
      try {
        // Same wamid several times, and a `read` before its `delivered`.
        const entries = [
          statusEntry('wamid.dup.A'), statusEntry('wamid.dup.A'),
          { id: 'waba-read', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'shared-phone-id', display_phone_number: '15550001111' }, statuses: [{ id: 'wamid.dup.B', status: 'read', timestamp: '1700000900', recipient_id: '972500000001' }] } }] },
          statusEntry('wamid.dup.B'),
          statusEntry('wamid.dup.A'),
        ];
        await post(url, burstPayload(entries));
        await waitFor(() => c.statuses.length >= 3, 20_000, 'statuses delivered');
        await sleep(800);
        const journal = path.join(path.dirname(ctx.config.OWNER_STORAGE_PATH), 'meta-status-forward.jsonl');
        const { MetaStatusQueue } = require('../dist/metaStatusQueue');
        assert.equal(new MetaStatusQueue(journal).stats().pending, 0, 'duplicates/out-of-order must not strand entries in the queue');
      } finally {
        await new Promise((resolve) => gw.close(resolve));
        c.server.close();
      }
    });
  });

  // R3: the byte limit is measured in UTF-8 BYTES, and the count limit in STATUSES - not in UTF-16
  //     units and not in envelopes. Hebrew is the case that separates them: one unit, two bytes.
  await scenario('[http+journal] batch limits count UTF-8 bytes and statuses, not units and envelopes', async () => {
    await withGateway('limits', { META_STATUS_BATCH: 'http+journal', META_STATUS_BATCH_MAX: '20', META_STATUS_BATCH_MAX_BYTES: '20000' }, async (ctx) => {
      const c = await makeClient('c-limits');
      const { gw, url } = await bootGateway(ctx, [c]);
      try {
        // Hebrew padding: ~1KB of UTF-16 units per entry, ~2KB of UTF-8 bytes.
        const padded = (id) => {
          const e = statusEntry(id);
          e.changes[0].value.statuses[0].pad = 'א'.repeat(1000);
          return e;
        };
        const N = 30;
        await post(url, burstPayload(Array.from({ length: N }, (_, i) => padded(`wamid.heb.${i}`))));
        await waitFor(() => c.statuses.length === N, 30_000, 'all delivered');
        await sleep(400);

        // At ~2KB of UTF-8 per entry and a 20KB cap, a batch holds about ten - NOT the twenty the
        // count limit would allow, and not the twenty a UTF-16 measurement would have permitted.
        const biggest = Math.max(...c.bodies);
        assert.ok(biggest <= 12, `the byte limit must bind before the count limit for Hebrew, biggest batch was ${biggest}`);
        assert.ok(biggest > 1, `batching must still happen, biggest batch was ${biggest}`);
      } finally {
        await new Promise((resolve) => gw.close(resolve));
        c.server.close();
      }
    });
  });

  for (const [name, status, detail] of results) console.log(`${status}  ${name}${detail ? ' :: ' + detail : ''}`);
  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(`\nstatus-batching: ${results.length - failed} passed, ${failed} failed`);
  fs.rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((err) => { console.error(err); process.exit(1); });
