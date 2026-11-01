'use strict';
/**
 * The lookup accelerators behind the returning-button paths (per-phone results, per-result event keys, wamid -> outbox row) must give
 * exactly the answer of the full scan they replace, in every state the arrays can be in: appended to, reset (array replaced), mutated
 * in place by a path that does not feed the index. Also: repeatableWindowCampaignId and the "latest result" pick equal a reference
 * implementation of their previous (scanning) behaviour.
 */
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-indexes-'));
process.env.STORAGE_PATH = path.join(dir, 'storage.json');
process.env.SESSION_PATH = path.join(dir, 'session');
const { Storage } = require('../dist/storage');
const { repeatableWindowCampaignId } = require('../dist/messageFlow');

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

const flowWith = (repeatable) => [
  { id: 'q1', kind: 'question', presentation: 'buttons', text: 'Q1', options: [{ id: 'yes', text: 'yes', nextStepId: 'm1', ...(repeatable ? { repeatable: true } : {}) }] },
  { id: 'm1', kind: 'message', text: 'M' },
];
const campaignInput = (name, phrase, repeatable) => ({ name, triggerType: 1, triggerPhrase: phrase, suffix: '', active: true,
  conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: flowWith(repeatable) } });

let pgSkipped = false;
(async () => {
  if (process.argv.includes('--pg-child')) {
    const { createStorage } = require('../dist/storageFactory');
    const pgStorage = await createStorage();
    const c = pgStorage.addCampaign(campaignInput('pg-live', `pg-trigger-${Date.now()}`, true));
    const r = pgStorage.recordCampaignTrigger(c.id, '972506660001', 'PG');
    pgStorage.recordCampaignEvent({ campaignId: c.id, campaignResultId: r.id, phone: r.phone, type: 'step_answered', dedupeKey: 'pg:1' });
    const m = pgStorage.enqueueOutboxMessage({ kind: 'text', to: 'whatsapp:972506660001', text: 't', campaignId: c.id, campaignResultId: r.id, stepId: 'q1' });
    pgStorage.claimOutboxMessage(m.id); pgStorage.markOutboxSent(m.id, 'wamid.pg1');
    await pgStorage.flush();
    const reloaded = await createStorage();
    assert.equal(reloaded.getResultsForPhoneKey('972506660001').some((x) => x.id === r.id), true, 'results index after PostgreSQL reload');
    assert.equal(reloaded.hasCampaignEventKey(r.id, 'pg:1'), true, 'event key index after PostgreSQL reload');
    assert.equal(reloaded.outboxMessageBelongsToStep('wamid.pg1', { campaignResultId: r.id, stepId: 'q1' }), true, 'wamid index after PostgreSQL reload');
    assert.equal(reloaded.outboxMessageBelongsToStep('wamid.pg1', { campaignResultId: r.id, stepId: 'q2' }), false);
    const digitsOf = (x) => String(x).replace(/\D/g, '');
    for (const phone of [...new Set(reloaded.data.campaignResults.map((x) => digitsOf(x.phone)))].slice(0, 200)) {
      assert.deepEqual(reloaded.getResultsForPhoneKey(phone).map((x) => x.id).sort(), reloaded.data.campaignResults.filter((x) => digitsOf(x.phone) === phone).map((x) => x.id).sort());
    }
    console.log('PG_CHILD_OK');
    setTimeout(() => process.exit(0), 300);
    return;
  }
  const storage = new Storage(process.env.STORAGE_PATH);
  const live = storage.addCampaign(campaignInput('live', 'live-trigger', true));
  const plain = storage.addCampaign(campaignInput('plain', 'plain-trigger', false));
  const digits = (p) => String(p).replace(/\D/g, '');
  const naiveResults = (phone) => storage.getCampaignResults().filter((r) => digits(r.phone) === digits(phone)).map((r) => r.id).sort();
  const indexed = (phone) => storage.getResultsForPhoneKey(digits(phone)).map((r) => r.id).sort();

  await scenario('per-phone results: equals the scan after appends, with phones written in different formats', async () => {
    const phones = ['972501110001', '+972 50-111-0002', '972501110003'];
    for (let i = 0; i < 30; i += 1) storage.recordCampaignTrigger(i % 2 ? live.id : plain.id, phones[i % 3], `P${i}`);
    for (const phone of [...phones, '972509999999']) assert.deepEqual(indexed(phone), naiveResults(phone), phone);
    storage.recordCampaignTrigger(live.id, phones[0], 'again');          // append AFTER the index was built
    assert.deepEqual(indexed(phones[0]), naiveResults(phones[0]));
    assert.equal(indexed('972509999999').length, 0, 'unknown sender: empty, no error');
  });

  await scenario('per-phone results: rebuilt when the array is replaced (campaign reset) - no stale entries', async () => {
    const before = indexed('972501110001');
    assert.ok(before.length > 0);
    storage.resetCampaignData(live.id);
    for (const phone of ['972501110001', '972501110002', '972501110003']) assert.deepEqual(indexed(phone), naiveResults(phone), phone);
    storage.recordCampaignTrigger(live.id, '972501110001', 'after reset');
    assert.deepEqual(indexed('972501110001'), naiveResults('972501110001'));
  });

  await scenario('event keys: equals the scan, including keys added after the index was built and after a reset', async () => {
    const r1 = storage.recordCampaignTrigger(live.id, '972501110010', 'K');
    const naive = (resultId, key) => storage.getCampaignEvents().some((e) => e.campaignResultId === resultId && e.dedupeKey === key);
    assert.equal(storage.hasCampaignEventKey(r1.id, 'k:1'), naive(r1.id, 'k:1'));
    storage.recordCampaignEvent({ campaignId: live.id, campaignResultId: r1.id, phone: r1.phone, type: 'step_answered', dedupeKey: 'k:1' });
    assert.equal(storage.hasCampaignEventKey(r1.id, 'k:1'), true);
    assert.equal(storage.hasCampaignEventKey(r1.id, 'k:2'), false);
    storage.recordCampaignEvent({ campaignId: live.id, campaignResultId: r1.id, phone: r1.phone, type: 'step_answered', dedupeKey: 'k:2' });
    assert.equal(storage.hasCampaignEventKey(r1.id, 'k:2'), true);
    assert.equal(storage.hasCampaignEventKey('nope', 'k:1'), false);
    storage.resetCampaignData(live.id);
    assert.equal(storage.hasCampaignEventKey(r1.id, 'k:1'), naive(r1.id, 'k:1'), 'after the reset the keys of the removed results are gone');
    assert.equal(storage.hasCampaignEventKey(r1.id, 'k:1'), false);
  });

  await scenario('wamid index: equals the scan; a row whose id was set by an unhooked path is still found; wrong owner is refused', async () => {
    const mk = (resultId, stepId, to) => storage.enqueueOutboxMessage({ kind: 'text', to, text: 't', campaignId: live.id, campaignResultId: resultId, stepId });
    const a = mk('resA', 'q1', 'whatsapp:972501110020');
    storage.claimOutboxMessage(a.id); storage.markOutboxSent(a.id, 'wamid.A');
    assert.equal(storage.outboxMessageBelongsToStep('wamid.A', { campaignResultId: 'resA', stepId: 'q1' }), true);
    assert.equal(storage.outboxMessageBelongsToStep('wamid.A', { campaignResultId: 'resB', stepId: 'q1' }), false, 'another result');
    assert.equal(storage.outboxMessageBelongsToStep('wamid.A', { campaignResultId: 'resA', stepId: 'q2' }), false, 'another step');
    assert.equal(storage.outboxMessageBelongsToStep('wamid.NOPE', { campaignResultId: 'resA', stepId: 'q1' }), false);
    assert.equal(storage.outboxMessageBelongsToStep('', { campaignResultId: 'resA', stepId: 'q1' }), false);
    // the index now exists; a row whose providerMessageId is set directly (a path that does not feed the index) must still be found
    const b = mk('resB', 'q1', 'whatsapp:972501110021');
    const rowB = storage.data.outboxMessages.find((m) => m.id === b.id);
    rowB.providerMessageId = 'wamid.B-direct';
    assert.equal(storage.outboxMessageBelongsToStep('wamid.B-direct', { campaignResultId: 'resB', stepId: 'q1' }), true, 'fallback scan finds it');
    assert.equal(storage.outboxMessageBelongsToStep('wamid.B-direct', { campaignResultId: 'resB', stepId: 'q1' }), true, 'and now from the index');
    // an id carried only by an attempt record
    const c = mk('resC', 'q1', 'whatsapp:972501110022');
    const rowC = storage.data.outboxMessages.find((m) => m.id === c.id);
    rowC.attemptLog = [{ attemptId: 'x', startedAt: new Date().toISOString(), status: 'accepted', providerMessageId: 'wamid.C-first', providerMessageIds: ['wamid.C-second'] }];
    assert.equal(storage.outboxMessageBelongsToStep('wamid.C-second', { campaignResultId: 'resC', stepId: 'q1' }), true);
    assert.equal(storage.outboxMessageBelongsToStep('wamid.C-second', { campaignResultId: 'resA', stepId: 'q1' }), false);
  });

  // ---- reference implementation of the previous (scanning) behaviour
  const REF_WINDOW_MS = 10 * 60_000;
  const referenceWindow = (phone) => {
    const key = digits(phone); if (!key) return undefined;
    const active = new Map(storage.getActiveCampaigns().map((c) => [c.id, c]));
    const latest = storage.getCampaignResults()
      .filter((r) => digits(r.phone) === key && active.has(r.campaignId))
      .sort((l, r) => (Date.parse(r.lastEventAt || r.updatedAt || r.triggeredAt) || 0) - (Date.parse(l.lastEventAt || l.updatedAt || l.triggeredAt) || 0))[0];
    if (!latest) return undefined;
    const at = Date.parse(latest.lastEventAt || latest.updatedAt || latest.triggeredAt) || 0;
    if (!at || Date.now() - at > REF_WINDOW_MS) return undefined;
    const campaign = active.get(latest.campaignId); if (!campaign) return undefined;
    const spent = new Set(storage.getCampaignEvents(campaign.id).filter((e) => e.campaignResultId === latest.id).map((e) => e.dedupeKey));
    for (const step of storage.getCampaignConversationSettings(campaign).decisionFlow) {
      if (step.kind !== 'question' && step.kind !== 'score_question') continue;
      if ((step.options ?? []).some((o) => o.repeatable === true && !o.action && !spent.has(`share_repeated:${step.id}:${o.id}`))) return campaign.id;
    }
    return undefined;
  };

  await scenario('repeatableWindowCampaignId equals the reference over many states (sender unseen, plain campaign, live, spent, out of window, two campaigns, tie)', async () => {
    const phones = [];
    for (let i = 0; i < 12; i += 1) phones.push(`97250222${String(1000 + i)}`);
    const check = (label) => { for (const p of [...phones, '972509998877']) assert.equal(repeatableWindowCampaignId(storage, p), referenceWindow(p), `${label} ${p}`); };
    check('empty');
    const made = phones.map((p, i) => storage.recordCampaignTrigger(i % 3 === 0 ? plain.id : live.id, p, `N${i}`));
    check('fresh results');
    // spend the repeat for some of them
    made.forEach((r, i) => { if (i % 4 === 1) storage.recordCampaignEvent({ campaignId: r.campaignId, campaignResultId: r.id, phone: r.phone, type: 'share_repeated', dedupeKey: 'share_repeated:q1:yes' }); });
    check('some spent');
    // push some out of the window
    made.forEach((r, i) => { if (i % 5 === 2) { const row = storage.data.campaignResults.find((x) => x.id === r.id); row.lastEventAt = new Date(Date.now() - 11 * 60_000).toISOString(); row.updatedAt = row.lastEventAt; } });
    check('some out of window');
    // a second, later result for a phone in the other campaign, and an exact tie on activity
    const stamp = new Date(Date.now() - 60_000).toISOString();
    const tiePhone = '972503330001'; phones.push(tiePhone);
    const r1 = storage.recordCampaignTrigger(plain.id, tiePhone, 'two'); const r2 = storage.recordCampaignTrigger(live.id, tiePhone, 'three');
    for (const r of [r1, r2]) { const row = storage.data.campaignResults.find((x) => x.id === r.id); row.lastEventAt = stamp; row.updatedAt = stamp; }
    check('tie on last activity');
    storage.resetCampaignData(plain.id);
    check('after resetting a campaign');
  });

  const everyIndexMatchesItsScan = (st, label) => {
    const digitsOf = (p) => String(p).replace(/\D/g, '');
    const phones = [...new Set(st.data.campaignResults.map((r) => digitsOf(r.phone)))];
    for (const phone of phones.slice(0, 200)) {
      const scan = st.data.campaignResults.filter((r) => digitsOf(r.phone) === phone).map((r) => r.id).sort();
      assert.deepEqual(st.getResultsForPhoneKey(phone).map((r) => r.id).sort(), scan, `${label}: results of ${phone}`);
    }
    for (const e of st.data.campaignEvents.filter((x) => x.campaignResultId && x.dedupeKey).slice(0, 300)) {
      assert.equal(st.hasCampaignEventKey(e.campaignResultId, e.dedupeKey), true, `${label}: event key ${e.dedupeKey}`);
      assert.equal(st.hasCampaignEventKey(e.campaignResultId, e.dedupeKey + '-x'), false, `${label}: absent key`);
    }
    for (const m of st.data.outboxMessages.filter((x) => x.providerMessageId).slice(0, 300)) {
      assert.equal(st.outboxMessageBelongsToStep(m.providerMessageId, { campaignResultId: m.campaignResultId, stepId: m.stepId }), true, `${label}: wamid ${m.providerMessageId}`);
      assert.equal(st.outboxMessageBelongsToStep(m.providerMessageId, { campaignResultId: m.campaignResultId + '-x', stepId: m.stepId }), false, `${label}: wrong owner`);
    }
  };

  await scenario('mixed load: interleaved writes (triggers, events, sends, resets) and lookups stay equal to the scans', async () => {
    let seed = 20261101;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const ph = (i) => `97250444${String(1000 + (i % 40))}`;
    const owned = [];
    for (let i = 0; i < 4000; i += 1) {
      const roll = rnd();
      if (roll < 0.25) { const r = storage.recordCampaignTrigger(rnd() < 0.5 ? live.id : plain.id, ph(i), `M${i}`); owned.push(r); }
      else if (roll < 0.5 && owned.length) { const r = owned[Math.floor(rnd() * owned.length)]; storage.recordCampaignEvent({ campaignId: r.campaignId, campaignResultId: r.id, phone: r.phone, type: 'step_answered', dedupeKey: `mix:${i % 17}` }); }
      else if (roll < 0.62 && owned.length) {
        const r = owned[Math.floor(rnd() * owned.length)];
        const m = storage.enqueueOutboxMessage({ kind: 'text', to: `whatsapp:${r.phone}`, text: 't', campaignId: r.campaignId, campaignResultId: r.id, stepId: `q${i % 3}` });
        storage.claimOutboxMessage(m.id); storage.markOutboxSent(m.id, `wamid.mix${i}`);
      } else if (roll < 0.625) { storage.resetCampaignData(rnd() < 0.5 ? live.id : plain.id); owned.length = 0; }
      else if (owned.length) {
        const r = owned[Math.floor(rnd() * owned.length)];
        assert.deepEqual(storage.getResultsForPhoneKey(digits(r.phone)).map((x) => x.id).sort(), storage.getCampaignResults().filter((x) => digits(x.phone) === digits(r.phone)).map((x) => x.id).sort());
        const naive = storage.data.campaignEvents.some((e) => e.campaignResultId === r.id && e.dedupeKey === `mix:${i % 17}`);
        assert.equal(storage.hasCampaignEventKey(r.id, `mix:${i % 17}`), naive);
      }
    }
    everyIndexMatchesItsScan(storage, 'after the mixed load');
  });

  await scenario('failing lookups (wamid never seen, wrong owner) never poison the index and keep answering correctly between hits', async () => {
    const real = storage.data.outboxMessages.filter((m) => m.providerMessageId).slice(-20);
    assert.ok(real.length > 5);
    for (let i = 0; i < 500; i += 1) {
      assert.equal(storage.outboxMessageBelongsToStep(`wamid.never${i}`, { campaignResultId: 'x', stepId: 'q0' }), false);
      const m = real[i % real.length];
      assert.equal(storage.outboxMessageBelongsToStep(m.providerMessageId, { campaignResultId: m.campaignResultId, stepId: m.stepId }), true);
      assert.equal(storage.outboxMessageBelongsToStep(m.providerMessageId, { campaignResultId: m.campaignResultId, stepId: m.stepId + '-other' }), false);
    }
  });

  await scenario('first build after a restart: a new Storage loaded from the saved file answers exactly like the scans', async () => {
    await storage.flush();
    const reopened = new Storage(process.env.STORAGE_PATH);
    assert.equal(reopened.data.campaignResults.length, storage.data.campaignResults.length);
    everyIndexMatchesItsScan(reopened, 'after reload');
    const before = reopened.data.campaignResults.length;
    reopened.recordCampaignTrigger(live.id, '972505550001', 'new after reload');
    assert.equal(reopened.data.campaignResults.length, before + 1);
    assert.equal(reopened.getResultsForPhoneKey('972505550001').length, 1);
    reopened.resetCampaignData(live.id);
    everyIndexMatchesItsScan(reopened, 'after reload then reset');
  });

  await scenario('PostgreSQL: a Storage loaded from the database rebuilds the same indexes (child process against the local test database only)', async () => {
    const url = process.env.TEST_DATABASE_URL || '';
    if (!url || !/flowsbiz_test/.test(url)) {
      if (process.env.REQUIRE_POSTGRES === '1') throw new Error('REQUIRE_POSTGRES=1 but TEST_DATABASE_URL (local flowsbiz_test database) is not set');
      pgSkipped = true; return;
    }
    const { spawnSync } = require('node:child_process');
    const child = spawnSync(process.execPath, [__filename, '--pg-child'], { env: { ...process.env, DATABASE_URL: url, STORAGE_PATH: path.join(dir, 'pg-unused.json') }, encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, `child failed: ${String(child.stdout).slice(-400)} ${String(child.stderr).slice(-400)}`);
    assert.match(child.stdout, /PG_CHILD_OK/);
    assert.match(child.stdout, /Storage mode: PostgreSQL/, 'the child really used PostgreSQL');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (pgSkipped) { const e = results.find((r) => /^PostgreSQL/.test(r[0])); if (e) { e[1] = 'SKIP'; e[2] = 'NOT RUN: TEST_DATABASE_URL (local flowsbiz_test database) is not set; PostgreSQL durability is NOT verified'; } }
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS' && status !== 'SKIP') failed += 1; }
  if (failed) console.log(`\n${failed} scenario(s) FAILED`);
  else if (pgSkipped) console.log('\nPostgreSQL part SKIPPED: durability is NOT verified (all other scenarios passed). Exit 3 = BLOCKED.');
  else console.log(`\nReturning-button index tests passed (${results.length} scenarios).`);
  const code = failed ? 1 : (pgSkipped ? 3 : 0);
  process.exitCode = code;
  setTimeout(() => process.exit(code), 300);
})().catch((e) => { console.error(e); process.exit(1); });
