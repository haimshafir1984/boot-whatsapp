/**
 * Stage E - mandatory test: a crash AFTER a campaign action and BEFORE the inbox item is marked completed.
 * A lease/token fences DATABASE writes of an old worker; it does not stop a worker from performing an action, so the
 * protection has to be "never run it a second time without proof".
 *
 *   BASE  (--base <dist>): characterises today's production class (MetaGatewayInbox): the stale `processing` item is claimed
 *                          AGAIN and the action runs twice  -> asserts the defect EXISTS (2 effects).
 *   NEW   (default)      : the PostgreSQL repository, client role: the expired item becomes `review` and the action runs ONCE.
 *                          Also: the gateway role re-runs (its forward is idempotent at the client by identity).
 * Exit 3 = BLOCKED when PostgreSQL is not available (never a skip).
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseIdx = process.argv.indexOf('--base');

(async () => {
  if (baseIdx >= 0) {
    const { MetaGatewayInbox } = require(path.join(path.resolve(process.argv[baseIdx + 1]), 'metaGatewayInbox'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-effect-'));
    try {
      let effects = 0;
      const file = path.join(dir, 'inbox.json');
      const t0 = new Date('2026-01-01T00:00:00Z');
      const workerA = new MetaGatewayInbox(file, 120_000);
      workerA.enqueue('wamid.X', { entry: [{ changes: [{ value: { metadata: { phone_number_id: '1' }, messages: [{ from: '972501', id: 'wamid.X' }] } }] }] }, t0);
      const a = workerA.claimBatch(1, () => 'k', t0)[0];
      effects += 1;                                         // the campaign action (a send, a contact, a step advance) HAPPENS ...
      /* ... and the process dies before markCompleted */
      const workerB = new MetaGatewayInbox(file, 120_000);  // restart
      const b = workerB.claimBatch(1, () => 'k', new Date(t0.getTime() + 121_000))[0];
      if (b) effects += 1;                                  // the stale item is offered again and the action runs again
      assert.equal(b?.id, a.id); assert.equal(b.attempts, 2);
      assert.equal(effects, 2, 'BASE defect: the action ran twice');
      console.log('PASS  BASE characterisation: crash after the action => the item is re-run => 2 effects (the live duplicate-execution path)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    return;
  }

  const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');
  const { createInboxPool, migrateInboxSchema } = require('../dist/inbox/schema');
  const { PostgresInboxRepository } = require('../dist/inbox/postgresRepository');
  await ensureInboxTestDb();
  const pool = createInboxPool(inboxTestUrl());
  await assertInboxTestDb(pool); await migrateInboxSchema(pool);
  const msg = (id) => ({ messageId: id, phoneNumberId: '1', senderKey: '1:972501', senderPhone: '972501', payload: { id } });
  try {
    // CLIENT
    let effects = 0;
    const client = new PostgresInboxRepository(pool, { namespace: `crash-c-${process.pid}`, role: 'client' });
    await client.enqueueMany([msg('wamid.C')]);
    const a = (await client.claim(1, { workerId: 'A', leaseMs: 120_000 })).claimed[0];
    effects += 1;                                            // the action happens, then the worker dies (no complete)
    const restarted = new PostgresInboxRepository(pool, { namespace: client.opts.namespace, role: 'client' });
    restarted.clockOffsetMs = 121_000;                        // the lease expires
    const r = await restarted.claim(1, { workerId: 'B' });
    effects += r.claimed.length;                              // must stay 0
    assert.equal(r.claimed.length, 0, 'the client item must not be offered again');
    assert.equal(r.reviewed.length, 1); assert.equal(r.reviewed[0].resolution, 'ambiguous_processing');
    assert.equal(effects, 1, 'the action ran exactly once');
    assert.equal((await restarted.getByMessage('1', 'wamid.C')).status, 'review');
    assert.equal((await restarted.complete(a.item.id, '00000000-0000-0000-0000-000000000000')).ok, false, 'a stranger token cannot close it');
    assert.equal((await restarted.checkInvariants()).length, 0);
    console.log('PASS  NEW (client): crash after the action => review(ambiguous_processing), the action ran ONCE, nothing re-run automatically');
    // GATEWAY
    const gw = new PostgresInboxRepository(pool, { namespace: `crash-g-${process.pid}`, role: 'gateway' });
    await gw.enqueueMany([msg('wamid.G')]);
    await gw.claim(1, { workerId: 'A', leaseMs: 120_000 });
    const gw2 = new PostgresInboxRepository(pool, { namespace: gw.opts.namespace, role: 'gateway' }); gw2.clockOffsetMs = 121_000;
    const g = await gw2.claim(1, { workerId: 'B' });
    assert.equal(g.claimed.length, 1); assert.equal(g.claimed[0].item.attempts, 2);
    console.log('PASS  NEW (gateway): the item is re-run after a crash (safe only because the forward is idempotent by identity at the client - verified by reading in the C1/C2 report, end-to-end in C6)');
  } finally {
    await pool.query("delete from inbox_items where namespace like 'crash-%'"); await pool.query("delete from inbox_senders where namespace like 'crash-%'");
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
