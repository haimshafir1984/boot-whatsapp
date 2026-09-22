/**
 * Stage E / C2 - the PostgreSQL inbox repository against REAL PostgreSQL (dedicated database flowsbiz_inbox_test on 5433).
 * Exit 3 = BLOCKED (never a skip). Scenarios cover identity/dedupe, per-sender order, the scheduler pointer invariants,
 * lease/token fencing, gateway-vs-client reclaim, held/failed/review non-blocking, requeue behind active work, cancel,
 * cleanup + dedupe window, concurrency (two workers, 100/150 concurrent receipts, repeated ids), restart, and a
 * model-based property test that checks I1-I8 after every random step.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { inboxTestUrl, assertInboxTestDb, ensureInboxTestDb } = require('./inbox-test-db');
const { createInboxPool, migrateInboxSchema } = require('../dist/inbox/schema');
const { PostgresInboxRepository } = require('../dist/inbox/postgresRepository');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); } catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 4).join(' | ')]); }
}

let pool; let nsCounter = 0;
const PN = '1207335449126872';
const msg = (id, from = '972501000001', pn = PN) => ({ messageId: id, phoneNumberId: pn, senderKey: `${pn}:${from}`, senderPhone: from, payload: { id, from } });
const newRepo = (role = 'client', ns) => new PostgresInboxRepository(pool, { namespace: ns || `t${++nsCounter}-${process.pid}`, role });
const ok = async (repo) => assert.deepEqual(await repo.checkInvariants(), [], 'scheduler invariants');
const claimAll = (repo, limit = 100, leaseMs = 60_000) => repo.claim(limit, { workerId: 'w1', leaseMs });
const statusOf = async (repo, id, pn = PN) => (await repo.getByMessage(pn, id))?.status;
const completeOk = async (repo, ...args) => (await repo.complete(...args)).ok;

(async () => {
  await ensureInboxTestDb();
  pool = createInboxPool(inboxTestUrl(), { max: 30 });
  const identity = await assertInboxTestDb(pool);
  console.log('database:', JSON.stringify(identity));
  await migrateInboxSchema(pool);

  await scenario('schema: migration is idempotent and concurrent-safe; only inbox_* tables were created', async () => {
    assert.deepEqual(await migrateInboxSchema(pool), []);
    const p2 = createInboxPool(inboxTestUrl(), { max: 4 });
    try { await Promise.all([migrateInboxSchema(p2), migrateInboxSchema(p2), migrateInboxSchema(pool)]); } finally { await p2.end(); }
    const tables = (await pool.query("select table_name from information_schema.tables where table_schema = 'public'")).rows.map((r) => r.table_name);
    assert.ok(tables.length > 0 && tables.every((t) => t.startsWith('inbox_')), 'non-inbox table found: ' + tables.join(','));
  });

  await scenario('identity: same (phoneNumberId, messageId) is a duplicate; same messageId on another destination is a different message', async () => {
    const repo = newRepo();
    const a = await repo.enqueueMany([msg('w1')]);
    assert.deepEqual(a, { inserted: ['w1'], duplicates: [] });
    assert.deepEqual(await repo.enqueueMany([msg('w1')]), { inserted: [], duplicates: ['w1'] });
    assert.deepEqual((await repo.enqueueMany([msg('w1', '972501000001', '999')])).inserted, ['w1']);
    assert.deepEqual(await repo.enqueueMany([{ ...msg('w1'), payload: { other: true } }]), { inserted: [], duplicates: ['w1'] });
    assert.equal((await repo.getByMessage(PN, 'w1')).payload.id, 'w1', 'the original payload is kept');
    await ok(repo);
  });

  await scenario('a webhook batch is atomic: a failure in the middle commits NOTHING', async () => {
    const repo = newRepo();
    await assert.rejects(() => repo.enqueueMany([msg('b1', '972501000010'), msg('b2', '972501000011'), { ...msg('b3'), senderKey: null }]));
    assert.equal(await repo.getByMessage(PN, 'b1'), null); assert.equal(await repo.getByMessage(PN, 'b2'), null);
    assert.equal((await repo.counts()).queued, 0);
    await ok(repo);
  });

  await scenario('order: one item per sender in flight; the next is offered only after the head leaves; a retry boundary blocks later messages', async () => {
    const repo = newRepo();
    await repo.enqueueMany([msg('a1', '972501000021'), msg('a2', '972501000021'), msg('a3', '972501000021'), msg('b1', '972501000022')]);
    let c = await claimAll(repo);
    assert.deepEqual(c.claimed.map((x) => x.item.messageId).sort(), ['a1', 'b1']);
    assert.equal((await claimAll(repo)).claimed.length, 0, 'a1 is processing: a2 must not be offered');
    await ok(repo);
    const a1 = c.claimed.find((x) => x.item.messageId === 'a1');
    assert.equal(await repo.retry(a1.item.id, a1.leaseToken, new Error('routing incomplete'), new Date(Date.now() + 60_000)), true);
    assert.equal((await claimAll(repo)).claimed.length, 0, 'a1 waits for its retry boundary: a2 stays behind it');
    repo.clockOffsetMs = 120_000;                       // time passes
    c = await claimAll(repo);
    assert.deepEqual(c.claimed.map((x) => [x.item.messageId, x.item.attempts]), [['a1', 2]]);
    await repo.complete(c.claimed[0].item.id, c.claimed[0].leaseToken);
    c = await claimAll(repo); assert.deepEqual(c.claimed.map((x) => x.item.messageId), ['a2']);
    await ok(repo);
  });

  await scenario('claim honours the limit and offers the oldest-due senders first', async () => {
    const repo = newRepo();
    for (let i = 0; i < 30; i++) await repo.enqueueMany([msg(`l${i}`, '97250200' + String(i).padStart(4, '0'))]);
    const c = await claimAll(repo, 7);
    assert.equal(c.claimed.length, 7);
    assert.deepEqual(c.claimed.map((x) => x.item.messageId), ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
    await ok(repo);
  });

  await scenario('token fencing: a stale/wrong token changes NOTHING; terminal items cannot be transitioned again', async () => {
    const repo = newRepo();
    await repo.enqueueMany([msg('t1')]);
    const [{ item, leaseToken }] = (await claimAll(repo)).claimed;
    const wrong = '00000000-0000-0000-0000-000000000000';
    for (const fn of [() => completeOk(repo, item.id, wrong), () => repo.retry(item.id, wrong, 'e', new Date()), () => repo.hold(item.id, wrong, 'h'), () => repo.fail(item.id, wrong, 'f'), () => repo.review(item.id, wrong, 'stale_trigger'), () => repo.renew(item.id, wrong)]) assert.equal(await fn(), false);
    assert.equal(await statusOf(repo, 't1'), 'processing');
    assert.equal(await completeOk(repo, item.id, leaseToken), true);
    assert.equal(await completeOk(repo, item.id, leaseToken), false, 'completed items never transition again');
    assert.equal(await repo.retry(item.id, leaseToken, 'e', new Date()), false);
    const done = await repo.getByMessage(PN, 't1'); assert.equal(done.status, 'completed'); assert.equal(done.resolution, 'processed'); assert.equal(done.leaseToken, null);
    await ok(repo);
  });

  await scenario('held / failed / review do not block the sender: the next message is offered (as today), and each keeps its evidence', async () => {
    const repo = newRepo();
    await repo.enqueueMany([msg('h1', '972501000031'), msg('h2', '972501000031'), msg('h3', '972501000031'), msg('h4', '972501000031')]);
    let [x] = (await claimAll(repo)).claimed; assert.equal(x.item.messageId, 'h1'); await repo.hold(x.item.id, x.leaseToken, new Error('sender held'));
    [x] = (await claimAll(repo)).claimed; assert.equal(x.item.messageId, 'h2'); await repo.review(x.item.id, x.leaseToken, 'stale_trigger', { ageMs: 700000 });
    [x] = (await claimAll(repo)).claimed; assert.equal(x.item.messageId, 'h3'); await repo.fail(x.item.id, x.leaseToken, new Error('exhausted'));
    [x] = (await claimAll(repo)).claimed; assert.equal(x.item.messageId, 'h4');
    const held = await repo.getByMessage(PN, 'h1'), rev = await repo.getByMessage(PN, 'h2'), failed = await repo.getByMessage(PN, 'h3');
    assert.deepEqual([held.status, rev.status, failed.status], ['held', 'review', 'failed']);
    assert.equal(held.payload.id, 'h1'); assert.equal(rev.resolution, 'stale_trigger'); assert.deepEqual(rev.resolutionDetail, { ageMs: 700000 }); assert.equal(failed.resolution, 'exhausted');
    const parked = await repo.listReview({}); assert.deepEqual(parked.map((p) => p.messageId).sort(), ['h1', 'h2', 'h3']);
    const c = await repo.counts(); assert.deepEqual([c.held, c.review, c.failed, c.processing], [1, 1, 1, 1]);
    await ok(repo);
  });

  await scenario('requeue/discard: requeue goes BEHIND active work (new sequence), attempts reset; discard is failed+audited; ambiguous needs an acknowledgement', async () => {
    const repo = newRepo();
    await repo.enqueueMany([msg('r1', '972501000041')]);
    let [x] = (await claimAll(repo)).claimed; await repo.hold(x.item.id, x.leaseToken, 'held');
    await repo.enqueueMany([msg('r2', '972501000041'), msg('r3', '972501000041')]);         // active work that arrived AFTER the held one
    assert.equal(await repo.resolveForPhone('972501000041', 'requeue', 'admin'), 1);
    const requeued = await repo.getByMessage(PN, 'r1');
    assert.equal(requeued.status, 'queued'); assert.equal(requeued.attempts, 0); assert.equal(requeued.resolution, null);
    const order = [];
    for (let i = 0; i < 3; i++) { const [c] = (await claimAll(repo)).claimed; order.push(c.item.messageId); await repo.complete(c.item.id, c.leaseToken); }
    assert.deepEqual(order, ['r2', 'r3', 'r1'], 'the requeued message must not overtake active work');
    await ok(repo);
    // discard
    await repo.enqueueMany([msg('d1', '972501000042')]);
    [x] = (await claimAll(repo)).claimed; await repo.hold(x.item.id, x.leaseToken, 'held');
    assert.equal(await repo.resolveForPhone('972501000042', 'discard', 'admin'), 1);
    const d = await repo.getByMessage(PN, 'd1'); assert.equal(d.status, 'failed'); assert.equal(d.resolution, 'admin_discarded'); assert.match(d.lastError, /ADMIN_DISCARDED/);
    const audit = await pool.query("select action, from_status, to_status from inbox_admin_audit where item_id = $1", [d.id]);
    assert.deepEqual(audit.rows[0], { action: 'discard', from_status: 'held', to_status: 'failed' });
    await ok(repo);
  });

  await scenario('GATEWAY reclaim: an expired lease is re-run (attempts+1, new token); the OLD worker can no longer write', async () => {
    const repo = newRepo('gateway');
    await repo.enqueueMany([msg('g1')]);
    const [first] = (await claimAll(repo, 10, 1_000)).claimed;
    assert.equal((await claimAll(repo)).claimed.length, 0, 'lease still valid');
    repo.clockOffsetMs = 5_000;
    const second = (await claimAll(repo)).claimed[0];
    assert.equal(second.item.messageId, 'g1'); assert.equal(second.item.attempts, 2); assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(await completeOk(repo, first.item.id, first.leaseToken), false, 'old worker is fenced');
    assert.equal(await repo.retry(first.item.id, first.leaseToken, 'x', new Date()), false);
    assert.equal(await completeOk(repo, second.item.id, second.leaseToken, 'forwarded'), true);
    await ok(repo);
  });

  await scenario('CLIENT reclaim: an expired lease is NEVER re-run: it becomes review(ambiguous_processing); a late completion by the original worker closes it truthfully', async () => {
    const repo = newRepo('client');
    await repo.enqueueMany([msg('c1'), msg('c2')]);
    const [first] = (await claimAll(repo, 10, 1_000)).claimed;
    assert.equal(first.item.effectsState, 'possible');
    repo.clockOffsetMs = 5_000;
    const r = await claimAll(repo);
    assert.equal(r.claimed.length, 0, 'not re-run'); assert.deepEqual(r.reviewed.map((i) => i.messageId), ['c1']);
    const rev = await repo.getByMessage(PN, 'c1');
    assert.equal(rev.status, 'review'); assert.equal(rev.resolution, 'ambiguous_processing'); assert.equal(rev.resolutionDetail.attempts, 1);
    await ok(repo);
    // Fixed 2026-09-22 (finding #2): the sender is parked at the DB layer while c1 is an unresolved ambiguous review - the
    // next message of the same sender is NOT offered until an admin resolves c1 (or a fresh trigger supersedes it). This is
    // what makes the hold atomic with the review transition instead of racing it.
    const nxt = await claimAll(repo); assert.deepEqual(nxt.claimed.map((x) => x.item.messageId), []);
    // a stranger token cannot close it; the original worker (merely slow) can
    assert.equal(await completeOk(repo, first.item.id, '00000000-0000-0000-0000-000000000000'), false);
    assert.equal(await completeOk(repo, first.item.id, first.leaseToken), true);
    const late = await repo.getByMessage(PN, 'c1'); assert.equal(late.status, 'completed'); assert.equal(late.resolution, 'processed_late');
    await ok(repo);
    // c1 is no longer blocking (it completed): c2 is now claimable.
    const after = await claimAll(repo); assert.deepEqual(after.claimed.map((x) => x.item.messageId), ['c2']);
  });

  await scenario('CLIENT ambiguous item: requeue needs an explicit duplicate-risk acknowledgement; discard is always possible', async () => {
    const repo = newRepo('client');
    await repo.enqueueMany([msg('k1', '972501000051'), msg('k2', '972501000052')]);
    await claimAll(repo, 10, 1_000); repo.clockOffsetMs = 5_000; await claimAll(repo);
    assert.equal(await repo.resolveForPhone('972501000051', 'requeue', 'admin', { statuses: ['review'] }), 0, 'no ack: not replayed');
    assert.equal(await statusOf(repo, 'k1'), 'review');
    assert.equal(await repo.resolveForPhone('972501000051', 'requeue', 'admin', { statuses: ['review'], acknowledgeDuplicateRisk: true }), 1);
    assert.equal(await statusOf(repo, 'k1'), 'queued');
    assert.equal(await repo.resolveForPhone('972501000052', 'discard', 'admin', { statuses: ['review'] }), 1);
    assert.equal(await statusOf(repo, 'k2'), 'failed');
    await ok(repo);
  });

  await scenario('renew extends the lease (the item is not reclaimed); renew on a stale token is refused', async () => {
    const repo = newRepo('gateway');
    await repo.enqueueMany([msg('n1')]);
    const [c] = (await claimAll(repo, 10, 1_000)).claimed;
    assert.equal(await repo.renew(c.item.id, c.leaseToken, 60_000), true);
    repo.clockOffsetMs = 5_000; assert.equal((await claimAll(repo)).claimed.length, 0, 'renewed: still owned');
    repo.clockOffsetMs = 120_000; const re = (await claimAll(repo)).claimed[0]; assert.equal(re.item.attempts, 2);
    assert.equal(await repo.renew(c.item.id, c.leaseToken), false);
    await ok(repo);
  });

  await scenario('cancelForPhone: outstanding (queued/retry/processing) become failed(superseded); a worker that keeps running is fenced; later messages work', async () => {
    const repo = newRepo();
    await repo.enqueueMany([msg('x1', '972501000061'), msg('x2', '972501000061'), msg('y1', '972501000062', '999')]);
    const [c] = (await repo.claim(1, { workerId: 'w' })).claimed;
    assert.equal(await repo.cancelForPhone('972501000061'), 2);
    assert.equal(await statusOf(repo, 'x1'), 'failed'); assert.equal((await repo.getByMessage(PN, 'x2')).resolution, 'superseded');
    assert.equal(await completeOk(repo, c.item.id, c.leaseToken), false, 'the running worker cannot complete a cancelled item');
    assert.equal(await statusOf(repo, 'y1', '999'), 'queued', 'other phones untouched');
    await repo.enqueueMany([msg('x3', '972501000061')]);
    assert.deepEqual((await claimAll(repo)).claimed.map((x) => x.item.messageId).sort(), ['x3', 'y1']);
    await ok(repo);
  });

  await scenario('cleanup: dedupe window keeps identity, expires it after 30 days; payload purged after 7; held/failed/review are NEVER deleted; sender rows only go when empty', async () => {
    const repo = newRepo();
    await repo.enqueueMany([msg('z1', '972501000071'), msg('z2', '972501000072'), msg('z3', '972501000073')]);
    const cs = (await claimAll(repo)).claimed;
    await repo.complete(cs[0].item.id, cs[0].leaseToken); await repo.hold(cs[1].item.id, cs[1].leaseToken, 'held'); await repo.fail(cs[2].item.id, cs[2].leaseToken, 'x');
    repo.clockOffsetMs = 3 * 86_400_000;
    assert.deepEqual(await repo.cleanup(), { deleted: 0, payloadsPurged: 0, sendersRemoved: 0 });
    repo.clockOffsetMs = 8 * 86_400_000;
    assert.deepEqual(await repo.cleanup(), { deleted: 0, payloadsPurged: 1, sendersRemoved: 0 });
    assert.equal((await repo.getByMessage(PN, 'z1')).payload, null); assert.equal((await repo.getByMessage(PN, 'z2')).payload.id, 'z2');
    assert.deepEqual((await repo.enqueueMany([msg('z1', '972501000071')])).duplicates, ['z1'], 'still deduped inside the window');
    repo.clockOffsetMs = 31 * 86_400_000;
    const r = await repo.cleanup(); assert.equal(r.deleted, 1);
    assert.equal(await repo.getByMessage(PN, 'z1'), null); assert.equal(await statusOf(repo, 'z2'), 'held'); assert.equal(await statusOf(repo, 'z3'), 'failed');
    assert.equal(r.sendersRemoved, 1, 'only the sender that has no item left');
    assert.deepEqual((await repo.enqueueMany([msg('z1', '972501000071')])).inserted, ['z1'], 'identity expired after the window');
    await ok(repo);
  });

  await scenario('metrics/counts: oldest due age reflects waiting work; counts by status; completedLastHour', async () => {
    const repo = newRepo();
    assert.equal((await repo.metrics()).oldestDueAgeMs, null);
    await repo.enqueueMany([msg('m1', '972501000081'), msg('m2', '972501000082')]);
    repo.clockOffsetMs = 40_000;
    const m = await repo.metrics(); assert.ok(m.oldestDueAgeMs >= 39_000, String(m.oldestDueAgeMs)); assert.deepEqual(m.senders, { withOutstanding: 2, due: 2 });
    const [c] = (await repo.claim(1, { workerId: 'w' })).claimed; await repo.complete(c.item.id, c.leaseToken);
    const counts = await repo.counts(); assert.deepEqual([counts.queued, counts.completedLastHour], [1, 1]);
  });

  await scenario('CONCURRENCY: 150 concurrent receipts (distinct + repeated ids, one sender vs many) - no acknowledged item missing, no duplicate, invariants hold', async () => {
    const repo = newRepo();
    const calls = [];
    for (let i = 0; i < 100; i++) calls.push(repo.enqueueMany([msg(`cc${i}`, '97250300' + String(i % 40).padStart(4, '0'))]));          // 40 senders, some with several messages
    for (let i = 0; i < 30; i++) calls.push(repo.enqueueMany([msg(`same`, '972503009999')]));                                          // the SAME id 30 times
    for (let i = 0; i < 20; i++) calls.push(repo.enqueueMany([msg(`one${i}`, '972503008888')]));                                       // one sender, 20 messages
    const res = await Promise.all(calls);
    const inserted = res.flatMap((r) => r.inserted);
    assert.equal(new Set(inserted).size, inserted.length, 'no id inserted twice');
    assert.equal(inserted.filter((x) => x === 'same').length, 1, 'the repeated id was accepted exactly once');
    assert.equal(inserted.length, 100 + 1 + 20);
    const total = (await pool.query("select count(*)::int n from inbox_items where namespace = $1", [repo.opts.namespace])).rows[0].n;
    assert.equal(total, 121);
    const seqs = (await pool.query("select sender_key, count(*)::int n, count(distinct sender_seq)::int d from inbox_items where namespace = $1 group by sender_key", [repo.opts.namespace])).rows;
    assert.ok(seqs.every((r) => r.n === r.d), 'sender_seq is unique per sender');
    await ok(repo);
  });

  await scenario('CONCURRENCY: two workers claiming at once never receive the same sender/item; every item is eventually processed exactly once', async () => {
    const repo = newRepo('gateway');
    const N = 120;
    for (let i = 0; i < N; i += 20) await repo.enqueueMany(Array.from({ length: 20 }, (_, k) => msg(`w${i + k}`, '97250400' + String((i + k) % 60).padStart(4, '0'))));
    const done = new Map(); const held = new Set();
    const worker = async (name) => {
      let idle = 0;
      while (idle < 5) {
        const c = await repo.claim(10, { workerId: name });
        if (!c.claimed.length) { idle++; await sleep(10); continue; }
        idle = 0;
        for (const x of c.claimed) {
          assert.ok(!held.has(x.item.senderKey), 'a sender was handed to two workers at once'); held.add(x.item.senderKey);
          await sleep(2);
          done.set(x.item.messageId, (done.get(x.item.messageId) || 0) + 1);
          held.delete(x.item.senderKey);
          assert.equal(await completeOk(repo, x.item.id, x.leaseToken), true);
        }
      }
    };
    await Promise.all([worker('A'), worker('B'), worker('C')]);
    assert.equal(done.size, N); assert.ok([...done.values()].every((n) => n === 1), 'processed exactly once');
    const bySender = (await pool.query("select sender_key, array_agg(message_id order by completed_at) as ids, array_agg(sender_seq order by completed_at) as seqs from inbox_items where namespace = $1 group by sender_key", [repo.opts.namespace])).rows;
    for (const s of bySender) assert.deepEqual(s.seqs.map(Number), [...s.seqs.map(Number)].sort((a, b) => a - b), 'per-sender order preserved');
    await ok(repo);
  });

  await scenario('RESTART: a new repository instance over the same database sees the same state; an old lease is honoured', async () => {
    const a = newRepo('client'); const ns = a.opts.namespace;
    await a.enqueueMany([msg('s1'), msg('s2', '972501000091')]);
    const [c] = (await a.claim(1, { workerId: 'w', leaseMs: 60_000 })).claimed;
    const b = new PostgresInboxRepository(pool, { namespace: ns, role: 'client' });          // "restart": no in-memory state at all
    assert.equal((await b.counts()).processing, 1);
    assert.equal((await b.claim(10, { workerId: 'w2' })).claimed.length, 1, 'only the other sender is offered');
    assert.equal(await completeOk(b, c.item.id, c.leaseToken), true, 'the lease survives the restart');
    await ok(b);
  });

  await scenario('namespaces and roles are isolated from each other in one database', async () => {
    const g = newRepo('gateway', 'shared'); const cl = newRepo('client', 'shared'); const other = newRepo('client', 'shared2');
    await Promise.all([g.enqueueMany([msg('iso1')]), cl.enqueueMany([msg('iso1')]), other.enqueueMany([msg('iso1')])]);
    for (const r of [g, cl, other]) assert.equal((await r.counts()).queued, 1);
    assert.equal((await g.claim(10, { workerId: 'w' })).claimed.length, 1); assert.equal((await cl.counts()).queued, 1);
    await pool.query("delete from inbox_items where namespace in ('shared','shared2'); delete from inbox_senders where namespace in ('shared','shared2')");
  });

  // ---------------------------------------------------------------- model-based property test
  for (const role of ['gateway', 'client']) {
    await scenario(`PROPERTY (${role}): random enqueue/claim/complete/retry/hold/fail/review/renew/cancel/requeue/time-travel vs a reference model; I1-I8 after EVERY step`, async () => {
      let seed = 1234567;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const repo = newRepo(role); const LEASE = 30_000; const STEP = 10_000;
      const model = { senders: new Map(), t: 0 };
      const st = new Map();            // messageId -> {sender, seq, status, attempts, next, lease, token}
      const senderList = Array.from({ length: 6 }, (_, i) => '97250500' + String(i).padStart(4, '0'));
      let idN = 0; const tokens = new Map();
      // Fixed 2026-09-22 (finding #2): a sender with an unresolved review/ambiguous_processing item is parked - no head at
      // all - until that item resolves (late completion here; an admin action or a fresh-trigger supersede in production).
      const isBlocked = (s) => [...st.values()].some((m) => m.sender === s && m.status === 'review' && m.res === 'ambiguous_processing');
      const headOf = (s) => isBlocked(s) ? undefined : [...st.values()].filter((m) => m.sender === s && ['queued', 'retry', 'processing'].includes(m.status)).sort((a, b) => a.seq - b.seq)[0];
      const nextSeq = new Map();
      const now = () => model.t;
      const modelClaim = () => {
        const claimed = [], reviewed = [];
        for (const s of senderList) {
          const h = headOf(s); if (!h) continue;
          if (h.status === 'queued' || (h.status === 'retry' && h.next <= now())) { h.status = 'processing'; h.attempts++; h.lease = now() + LEASE; claimed.push(h.id); }
          else if (h.status === 'processing' && h.lease <= now()) {
            if (role === 'gateway') { h.attempts++; h.lease = now() + LEASE; claimed.push(h.id); } else { h.status = 'review'; h.res = 'ambiguous_processing'; reviewed.push(h.id); }
          }
        }
        return { claimed: claimed.sort(), reviewed: reviewed.sort() };
      };
      const STEPS = 350;
      for (let step = 0; step < STEPS; step++) {
        const op = pick(['enq', 'enq', 'enq', 'claim', 'claim', 'complete', 'retry', 'hold', 'fail', 'review', 'renew', 'time', 'cancel', 'requeue', 'stale']);
        const label = `step ${step} ${op}`;
        if (op === 'enq') {
          const s = pick(senderList); const id = `p${++idN}`;
          await repo.enqueueMany([msg(id, s)]);
          const seq = (nextSeq.get(s) || 0) + 1; nextSeq.set(s, seq);
          st.set(id, { id, sender: s, seq, status: 'queued', attempts: 0 });
        } else if (op === 'claim') {
          const r = await repo.claim(100, { workerId: 'w', leaseMs: LEASE });
          const expected = modelClaim();
          assert.deepEqual(r.claimed.map((x) => x.item.messageId).sort(), expected.claimed, label + ' claimed');
          assert.deepEqual(r.reviewed.map((x) => x.messageId).sort(), expected.reviewed, label + ' reviewed');
          for (const x of r.claimed) tokens.set(x.item.messageId, { token: x.leaseToken, itemId: x.item.id });
        } else if (op === 'time') {
          model.t += pick([0, STEP, 3 * STEP, 12 * STEP]); repo.clockOffsetMs = model.t;
        } else if (op === 'cancel') {
          const s = pick(senderList); const n = await repo.cancelForPhone(s);
          let exp = 0; for (const m of st.values()) if (m.sender === s && ['queued', 'retry', 'processing'].includes(m.status)) { m.status = 'failed'; exp++; }
          assert.equal(n, exp, label);
        } else if (op === 'requeue') {
          const s = pick(senderList); const n = await repo.resolveForPhone(s, 'requeue', 'admin', { statuses: ['held', 'failed'] });
          const list = [...st.values()].filter((m) => m.sender === s && ['held', 'failed'].includes(m.status)).sort((a, b) => a.seq - b.seq);
          for (const m of list) { const seq = (nextSeq.get(s) || 0) + 1; nextSeq.set(s, seq); m.seq = seq; m.status = 'queued'; m.attempts = 0; }
          assert.equal(n, list.length, label);
        } else {
          // worker-side transitions on a random processing item (with the CORRECT token, or occasionally a stale one)
          const procs = [...st.values()].filter((m) => m.status === 'processing' && tokens.has(m.id));
          if (!procs.length) continue;
          const m = pick(procs); const tk = tokens.get(m.id);
          const stale = rnd() < 0.15; const token = stale ? '00000000-0000-0000-0000-000000000000' : tk.token;
          let res;
          if (op === 'complete') { res = (await repo.complete(tk.itemId, token)).ok; if (!stale) m.status = 'completed'; }
          else if (op === 'retry') { const delta = pick([5_000, 50_000]); const nextAt = new Date(Date.now() + model.t + delta); res = await repo.retry(tk.itemId, token, 'e', nextAt); if (!stale) { m.status = 'retry'; m.next = model.t + delta; } }
          else if (op === 'hold') { res = await repo.hold(tk.itemId, token, 'h'); if (!stale) m.status = 'held'; }
          else if (op === 'fail') { res = await repo.fail(tk.itemId, token, 'f'); if (!stale) m.status = 'failed'; }
          else if (op === 'review' || op === 'stale') { res = await repo.review(tk.itemId, token, 'stale_trigger'); if (!stale) m.status = 'review'; }
          else if (op === 'renew') { res = await repo.renew(tk.itemId, token, LEASE); if (!stale) m.lease = now() + LEASE; }
          assert.equal(res, !stale, label + ' result');
        }
        // observable state == model, and the scheduler invariants hold
        if (step % 5 === 0 || op !== 'time') {
          const rows = (await pool.query('select message_id, status, attempts from inbox_items where namespace = $1', [repo.opts.namespace])).rows;
          for (const r of rows) { const m = st.get(r.message_id); assert.equal(r.status, m.status, `${label}: status of ${r.message_id}`); assert.equal(r.attempts, m.attempts, `${label}: attempts of ${r.message_id}`); }
          assert.equal(rows.length, st.size, label + ' row count');
        }
        assert.deepEqual(await repo.checkInvariants(), [], label + ' invariants');
      }
      assert.ok(idN > 50, 'the run actually produced work');
    });
  }

  await pool.end();
  let failed = 0;
  for (const r of results) { if (r[1] === 'FAIL') failed++; console.log(r[1] + '  ' + r[0]); if (r[2]) console.log('      ' + r[2]); }
  console.log(`inbox-repository-postgres: ${results.length - failed} passed, ${failed} failed (${identity.db}:${identity.port}, PostgreSQL ${identity.version})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
