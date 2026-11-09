'use strict';
/**
 * New outbox rows must never share an id (9.11.2026). An outbox row is written with `insert ... on conflict (id) do update`, so two messages
 * with one id stay two rows in memory but become ONE row in PostgreSQL: the earlier message is silently overwritten. The old generator
 * (millisecond + 4 random characters) did that about once per 1.7 million same-millisecond pairs (scripts/repro-outbox-id-collision.js
 * forces it). New ids are random UUIDs, checked against the ids already in the outbox.
 *
 * Old rows keep their short ids; nothing may depend on the id's shape.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { createPostgresBackend, loadStorageSnapshot } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-id-'));
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}
const mem = (n) => new Storage(path.join(dir, `s-${n}.json`), { initialData: emptyStorageData() });
const frozen = (fn) => {
  const realNow = Date.now; const realRandom = Math.random;
  Date.now = () => 1_800_000_000_000; Math.random = () => 0.123456789;
  try { return fn(); } finally { Date.now = realNow; Math.random = realRandom; }
};
const legacyRow = (i) => ({ id: `mw${i.toString(36)}abcd`, kind: 'text', to: `whatsapp:9725000${i}`, status: 'sent', attempts: 1, createdAt: new Date(1700000000000 + i).toISOString(), updatedAt: new Date(1700000000000 + i).toISOString() });

(async () => {
  await scenario('two messages created in the same millisecond with the same random draw get different ids', async () => {
    const s = mem('a');
    const [a, b] = frozen(() => [s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000001', text: 'A' }), s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000002', text: 'B' })]);
    assert.notEqual(a.id, b.id);
    assert.equal(new Set(s.data.outboxMessages.map((m) => m.id)).size, 2);
  });

  await scenario('new ids are UUIDs, and old short ids are untouched next to them', async () => {
    const s = mem('b');
    s.data.outboxMessages.push(legacyRow(1), legacyRow(2));
    const m = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000003', text: 'C' });
    assert.match(m.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(s.data.outboxMessages.slice(0, 2).map((r) => r.id), [legacyRow(1).id, legacyRow(2).id]);
  });

  await scenario('a generated id that already exists is never used: the clash is skipped, reported and nothing is overwritten', async () => {
    const s = mem('c');
    const first = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000004', text: 'first' });
    const real = crypto.randomUUID;
    const sequence = [first.id, first.id, '11111111-1111-4111-8111-111111111111'];
    crypto.randomUUID = () => sequence.shift();
    let second;
    try { second = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000005', text: 'second' }); } finally { crypto.randomUUID = real; }
    assert.equal(second.id, '11111111-1111-4111-8111-111111111111');
    assert.equal(s.data.outboxMessages.length, 2);
    assert.equal(s.data.outboxMessages.find((m) => m.id === first.id).text, 'first', 'the first message is intact');
  });

  await scenario('if a unique id cannot be found after 5 tries it throws instead of overwriting', async () => {
    const s = mem('d');
    const first = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000006', text: 'first' });
    const real = crypto.randomUUID;
    crypto.randomUUID = () => first.id;
    try { assert.throws(() => s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000007', text: 'second' }), /unique outbox id/); } finally { crypto.randomUUID = real; }
    assert.equal(s.data.outboxMessages.length, 1);
  });

  await scenario('an existing idempotency key still returns the existing message (unchanged)', async () => {
    const s = mem('e');
    const a = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000008', text: 'once', idempotencyKey: 'k1' });
    const b = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000008', text: 'once', idempotencyKey: 'k1' });
    assert.equal(a.id, b.id);
    assert.equal(s.data.outboxMessages.length, 1);
  });

  await scenario('the id index follows the array when rows are added elsewhere or the array is replaced', async () => {
    const s = mem('f');
    s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000009', text: 'x' });
    const viaOtherPath = '22222222-2222-4222-8222-222222222222';
    s.data.outboxMessages.push({ ...legacyRow(5), id: viaOtherPath });             // added without going through enqueue
    const real = crypto.randomUUID;
    const seq = [viaOtherPath, '33333333-3333-4333-8333-333333333333'];
    crypto.randomUUID = () => seq.shift();
    let m; try { m = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000010', text: 'y' }); } finally { crypto.randomUUID = real; }
    assert.equal(m.id, '33333333-3333-4333-8333-333333333333', 'the id added behind its back was noticed');
    s.data.outboxMessages = [legacyRow(9)];                                        // array replaced (e.g. a reload)
    const n = s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000011', text: 'z' });
    assert.equal(s.data.outboxMessages.length, 2);
    assert.notEqual(n.id, legacyRow(9).id);
  });

  await scenario('the clash check stays cheap on a 28,000-row outbox (no O(n) scan per message)', async () => {
    const s = mem('g');
    for (let i = 0; i < 28_000; i += 1) s.data.outboxMessages.push(legacyRow(i));
    const t0 = Date.now();
    for (let i = 0; i < 20_000; i += 1) { const id = s.newOutboxId(); s.data.outboxMessages.push({ ...legacyRow(i), id }); s.outboxIdSet.add(id); s.outboxIdSetLength = s.data.outboxMessages.length; }
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `20,000 ids on a 28,000-row outbox took ${ms}ms`);
  });

  await scenario('end to end on PostgreSQL: two same-millisecond messages both survive a flush and a reload', async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL || 'postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test';
    const parsed = new URL(databaseUrl);
    if (!(['localhost', '127.0.0.1'].includes(parsed.hostname)) || !parsed.pathname.toLowerCase().includes('test')) throw new Error('refusing a non-test database');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query('truncate table outbox_messages restart identity');
      const backend = await createPostgresBackend(databaseUrl);
      const s = new Storage('unused-outbox-id.json', { initialData: emptyStorageData(), backend });
      await s.flush();
      const [a, b] = frozen(() => [s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000001', text: 'message A' }), s.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972500000002', text: 'message B' })]);
      await s.flush();
      const reloaded = await loadStorageSnapshot(databaseUrl);
      assert.equal(reloaded.outboxMessages.length, 2, 'both rows are in PostgreSQL');
      assert.deepEqual(reloaded.outboxMessages.map((m) => m.text).sort(), ['message A', 'message B']);
      assert.notEqual(a.id, b.id);
      await backend.close();
    } finally { await pool.end(); }
  });

  for (const r of results) console.log(r[1].padEnd(5), r[0], r[2] || '');
  const failed = results.filter((r) => r[1] !== 'PASS').length;
  console.log(failed ? `${failed} FAILED` : 'ALL OK');
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
