/**
 * test-message-usage-endpoint.js
 * GET /owner-api/message-usage on the real admin server with a real Storage: needs the owner token, validates the date range,
 * counts delivered messages per campaign (through the flow unit), and does not change the outbox it reads.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = String(47000 + Math.floor(Math.random() * 2000));
process.env.CLIENT_ACCESS_TOKEN = 'usage-endpoint-test-client-token';
process.env.OWNER_ACCESS_TOKEN = 'usage-endpoint-test-owner-token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { startAdminServer } = require('../dist/adminServer');

const base = () => `http://127.0.0.1:${process.env.PORT}`;
const headers = { 'x-owner-token': process.env.OWNER_ACCESS_TOKEN };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-endpoint-'));
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    const campaign = storage.addCampaign({ name: 'אבחון DNA', triggerType: 1, triggerPhrase: 'שלום DNA', suffix: '', active: true });
    const deliver = (extra, wamid) => {
      const message = storage.enqueueOutboxMessage({ kind: 'text', to: '972501234567', text: 'x', ...extra });
      assert.ok(storage.claimOutboxMessage(message.id));
      storage.markOutboxSent(message.id, wamid);
      storage.applyMetaStatus({ wamid, status: 'delivered' });
    };
    const descriptor = { kind: 'reply_chain', campaignId: campaign.id, senderJid: '972501234567@s.whatsapp.net' };
    deliver({ flowRef: { unitId: 'u1', index: 0 }, continuation: { descriptor, state: 'done' } }, 'wamid.1');
    deliver({ flowRef: { unitId: 'u1', index: 1 } }, 'wamid.2');
    deliver({ to: '972509999999' }, 'wamid.3');
    const rowsBefore = JSON.stringify(storage.getOutboxRowsForUsage());

    startAdminServer(storage);
    await new Promise((r) => setTimeout(r, 200));

    // 1 - no token / wrong token
    assert.equal((await fetch(`${base()}/owner-api/message-usage`)).status, 401);
    assert.equal((await fetch(`${base()}/owner-api/message-usage`, { headers: { 'x-owner-token': 'nope' } })).status, 401);
    console.log('  1. refused without the owner token');

    // 2 - counts per campaign
    const ok = await fetch(`${base()}/owner-api/message-usage`, { headers });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.provider);
    assert.equal(body.usage.totals.delivered, 3);
    const mine = body.usage.campaigns.find((c) => c.campaignId === campaign.id);
    assert.equal(mine.delivered, 2);
    assert.equal(mine.name, 'אבחון DNA');
    assert.equal(mine.triggerPhrase, 'שלום DNA');
    assert.equal(body.usage.campaigns.find((c) => c.campaignId === null).delivered, 1);
    console.log('  2. per-campaign counts: 2 on the campaign, 1 without one');

    // 3 - date range
    const future = await (await fetch(`${base()}/owner-api/message-usage?from=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}`, { headers })).json();
    assert.equal(future.usage.totals.delivered, 0);
    const past = await (await fetch(`${base()}/owner-api/message-usage?from=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}`, { headers })).json();
    assert.equal(past.usage.totals.delivered, 3);
    console.log('  3. from/to filter the messages');

    // 4 - bad input
    for (const q of ['from=garbage', 'to=garbage', `from=${encodeURIComponent('2026-11-08T00:00:00Z')}&to=${encodeURIComponent('2026-11-07T00:00:00Z')}`, `from=${encodeURIComponent('2020-01-01T00:00:00Z')}&to=${encodeURIComponent('2026-01-01T00:00:00Z')}`]) {
      const bad = await fetch(`${base()}/owner-api/message-usage?${q}`, { headers });
      assert.equal(bad.status, 400, q);
    }
    console.log('  4. bad dates are refused with 400');

    // 5 - read-only
    assert.equal(JSON.stringify(storage.getOutboxRowsForUsage()), rowsBefore, 'the report must not change the outbox');
    console.log('  5. the outbox is unchanged');

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Message usage endpoint tests passed.');
    await new Promise((r) => setTimeout(r, 200));   // let the keep-alive sockets settle: exiting at once trips a libuv assertion on Windows
    process.exit(0);
  } catch (err) {
    console.error(err);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
})();
