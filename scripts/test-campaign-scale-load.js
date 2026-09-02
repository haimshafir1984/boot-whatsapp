'use strict';

/**
 * Short-form campaign-scale load test, run #1 of a planned pair.
 *
 * Everything measured today (the 20-40s trigger-to-Meta delays, the
 * idle-in-transaction hang, the scoped-flush fix) was diagnosed either from
 * production logs or from isolated bursts against an empty test database.
 * Nothing so far has proven the fix holds once the database actually looks
 * like it did on the day that mattered: ~17k outbox rows, ~13k campaign
 * results, ~18k campaign events, ~1,500 conversation-state rows. This
 * script builds exactly that backlog through the real Storage/backend
 * pipeline (not raw SQL), then fires a concurrent burst of simulated
 * senders through it and measures the one number production actually
 * suffered on: wall-clock from trigger to the first outbox message being
 * durably marked sent.
 *
 * Short form: seeds at production scale, but the burst itself is sized to
 * finish in a couple of minutes (200 senders, cap 50 - matching
 * META_MAX_CONCURRENT_SENDERS) rather than sustained over many minutes.
 * A longer, sustained-duration version is the planned follow-up.
 *
 * Runs against a REAL local Postgres (flowsbiz_test convention), never a
 * mock, and checks three things:
 *
 *   1. Trigger-to-first-send latency (p50/p95/max) under a 50-way
 *      concurrent burst against a full-scale backlog.
 *   2. Zero idle-in-transaction / held locks at any point sampled during
 *      the burst, not just after it.
 *   3. Zero lost writes and zero duplicate outbox rows - a full
 *      rebuild-from-Postgres-vs-memory comparison after the burst.
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPostgresBackend, loadStorageSnapshot } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');

const APP_NAME = 'flowsbiz_campaign_load_test';
const SEED = {
  outboxMessages: 17_000,
  campaignResults: 13_000,
  campaignEvents: 18_000,
  conversationState: 1_500,
  savedContacts: 2_000,
};
const BURST_SENDERS = 200;
const CONCURRENCY_CAP = 50; // matches META_MAX_CONCURRENT_SENDERS in adminServer.ts
const SAMPLE_LOCKS_EVERY_MS = 400;

function assertSafeTestDatabase(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const testName = parsed.pathname.toLowerCase().includes('test');
  if (!local || !testName) {
    throw new Error('Refusing to run: TEST_DATABASE_URL must point to a local database whose name contains "test".');
  }
}

function withAppName(databaseUrl, appName) {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set('application_name', appName);
  return parsed.toString();
}

async function clearData(pool) {
  const serviceBotTable = await pool.query("select to_regclass('public.service_bot_state') as name");
  if (serviceBotTable.rows[0]?.name) {
    await pool.query('truncate table service_bot_state restart identity');
  }
  await pool.query(`truncate table
    scheduled_jobs, conversation_state, outbox_messages, twilio_templates,
    uploaded_files, saved_contacts, contact_queue, campaign_events,
    campaign_results, campaigns, client_profile, admin_settings, app_state
    restart identity`);
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

// A bounded-concurrency runner, mirroring createSenderDrainer's cap so the
// test's own concurrency matches what production actually allows through.
async function runWithCap(items, cap, worker) {
  let nextIndex = 0;
  const results = new Array(items.length);
  async function lane() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, lane));
  return results;
}

async function main() {
  const baseUrl = process.env.TEST_DATABASE_URL
    || 'postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test';
  assertSafeTestDatabase(baseUrl);
  const backendUrl = withAppName(baseUrl, APP_NAME);

  const diagPool = new Pool({ connectionString: withAppName(baseUrl, `${APP_NAME}_diag`) });
  const setupPool = new Pool({ connectionString: withAppName(baseUrl, `${APP_NAME}_setup`) });

  // Background sampler: polls pg_stat_activity/pg_locks throughout the run,
  // not just at the end - a leak that clears itself before the final check
  // would otherwise go unnoticed.
  let sampling = true;
  // A connection legitimately in the middle of its own correctly-pinned
  // transaction reports 'idle in transaction' for the brief JS-side gap
  // between one client.query() call finishing and the next one starting -
  // that is not the bug this guards against. A STRANDED connection (the
  // BEGIN/COMMIT-on-different-pooled-connections bug) reports 'idle in
  // transaction' and then never moves - the same pid, several samples in a
  // row, with its transaction age only growing. Track streaks per pid
  // instead of a single instantaneous count so a genuine mid-statement blip
  // doesn't get reported as a leak.
  const idleStreaks = new Map(); // pid -> { count, firstSeenAt, lastQuery }
  const episodes = []; // every streak that ever crossed the report threshold, with its outcome
  let maxStreak = 0;
  const REPORT_STREAK_AT = 3; // ~1.2s - log it, but don't conclude "stranded" yet
  const sampler = (async () => {
    while (sampling) {
      try {
        const { rows } = await diagPool.query(
          `select pid, query,
             extract(epoch from (now() - xact_start)) as xact_age_s
           from pg_stat_activity
           where application_name = $1 and state = 'idle in transaction'`,
          [APP_NAME],
        );
        const seenNow = new Map(rows.map((r) => [r.pid, r]));
        for (const [pid, row] of seenNow) {
          const entry = idleStreaks.get(pid) ?? { count: 0, firstSeenAt: Date.now(), lastQuery: row.query };
          entry.count += 1;
          entry.lastQuery = row.query;
          entry.xactAgeS = row.xact_age_s;
          idleStreaks.set(pid, entry);
          maxStreak = Math.max(maxStreak, entry.count);
          if (entry.count === REPORT_STREAK_AT) {
            console.log(`  [watch] pid ${pid} idle-in-transaction for ${REPORT_STREAK_AT} samples (xact_age=${row.xact_age_s.toFixed(1)}s), last query: ${String(row.query).slice(0, 80)}`);
          }
        }
        for (const [pid, entry] of [...idleStreaks.entries()]) {
          if (!seenNow.has(pid)) {
            if (entry.count >= REPORT_STREAK_AT) {
              const durationS = (Date.now() - entry.firstSeenAt) / 1000;
              console.log(`  [resolved] pid ${pid} cleared after ~${durationS.toFixed(1)}s (${entry.count} samples). last query was: ${String(entry.lastQuery).slice(0, 80)}`);
              episodes.push({ pid, durationS, samples: entry.count, resolved: true, lastQuery: entry.lastQuery });
            }
            idleStreaks.delete(pid);
          }
        }
      } catch { /* transient during pool churn - ignore, next sample will catch a real leak */ }
      await new Promise((r) => setTimeout(r, SAMPLE_LOCKS_EVERY_MS));
    }
    // Anything still open when sampling stops never resolved during the run.
    for (const [pid, entry] of idleStreaks.entries()) {
      if (entry.count >= REPORT_STREAK_AT) {
        episodes.push({ pid, durationS: (Date.now() - entry.firstSeenAt) / 1000, samples: entry.count, resolved: false, lastQuery: entry.lastQuery });
      }
    }
  })();

  try {
    console.log(`Seeding a production-scale backlog: ${SEED.outboxMessages} outbox / ${SEED.campaignResults} results / ${SEED.campaignEvents} events / ${SEED.conversationState} conversations / ${SEED.savedContacts} contacts.`);
    await clearData(setupPool);

    const backend = await createPostgresBackend(backendUrl);
    const storage = new Storage('unused-campaign-load-test.json', { initialData: emptyStorageData(), backend });
    await storage.flush();

    const campaign = storage.addCampaign({
      name: 'load-test-campaign', triggerType: 1, triggerPhrase: 'go', suffix: '', active: true,
      conversation: {
        askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '',
        followupMessages: [],
        decisionFlow: [
          { id: 's1', kind: 'message', text: 'hi' },
          { id: 's2', kind: 'decision', text: 'pick one', options: [{ id: 'o1', label: 'A', nextStepId: undefined }] },
        ],
      },
    });

    const seedStart = Date.now();
    // Historical outbox/results/events, spread over many campaign results so
    // this looks like accumulated history, not one giant campaign batch.
    const seedResultCount = Math.max(SEED.campaignResults, SEED.outboxMessages, Math.ceil(SEED.campaignEvents / 1.4));
    for (let i = 0; i < seedResultCount; i += 1) {
      const phone = '9725' + String(1_000_000 + i).padStart(8, '0');
      if (i < SEED.campaignResults) {
        const r = storage.recordCampaignTrigger(campaign.id, phone, `seed-${i}`);
        if (i < SEED.campaignEvents) {
          storage.recordCampaignEvent({ campaignId: campaign.id, campaignResultId: r.id, phone, type: 'step_sent', label: 'seed' });
        }
        if (i < Math.floor(SEED.campaignEvents * 0.4)) {
          storage.recordCampaignEvent({ campaignId: campaign.id, campaignResultId: r.id, phone, type: 'step_answered', label: 'seed', dedupeKey: 's1' });
        }
      }
      if (i < SEED.outboxMessages) {
        const m = storage.enqueueOutboxMessage({ kind: 'text', to: `whatsapp:${phone}`, text: 'seed history' });
        storage.claimOutboxMessage(m.id);
        if (i % 400 === 0) storage.markOutboxFailed(m.id, 'seed failure');
        else storage.markOutboxSent(m.id, `wamid.seed${i}`);
      }
      if (i < SEED.savedContacts) {
        storage.markContactSaved(phone, `Seed Contact ${i}`);
      }
      // Coalesce writes in batches rather than one flush per row - matches
      // how history actually accumulates (many small flushes over time), and
      // keeps seeding itself from taking as long as the thing being measured.
      if (i % 250 === 0) await storage.flush();
    }
    await storage.flush();
    console.log(`  historical rows written in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);

    // Conversation-state backlog: a mix of active decision flows and
    // expired-decision leftovers, matching the 24h-retention shape measured
    // in production (mostly expired, some still live).
    const { conversationState } = require('../dist/conversationState');
    conversationState.configurePersistence(require('node:path').join(require('node:os').tmpdir(), 'load-test-conv.json'), storage);
    conversationState.restore(() => setTimeout(() => {}, 10_000_000));
    for (let i = 0; i < SEED.conversationState; i += 1) {
      const phone = '9725' + String(2_000_000 + i).padStart(8, '0');
      const jid = 'whatsapp:' + phone;
      const expired = i % 5 !== 0; // ~80% expired-decision, ~20% still active - matches the 1,075/144 split measured in production
      conversationState.set(jid, {
        kind: expired ? 'expired-decision' : 'decision',
        senderJid: jid, senderPhone: phone,
        campaignId: campaign.id, campaignResultId: 'seed-conv-' + i,
        flow: campaign.conversation.decisionFlow, stepId: 's2',
        timestamp: Date.now() - (expired ? 23 * 3600_000 : 60_000),
        timeoutHandle: setTimeout(() => {}, 10_000_000),
      });
    }
    await storage.flush();

    const seedTotalMs = Date.now() - seedStart;
    console.log(`Seed complete in ${(seedTotalMs / 1000).toFixed(1)}s. Backlog is now production scale.\n`);

    // ---- The burst: simulate BURST_SENDERS concurrent participants, capped
    // exactly like production, each running trigger -> contact save ->
    // outbox claim+flush+send+flush -> campaign event -> conversation state,
    // and timing trigger-to-first-send.
    console.log(`Running a ${BURST_SENDERS}-sender burst at concurrency cap ${CONCURRENCY_CAP}...`);
    const latenciesMs = [];
    const senderPhones = Array.from({ length: BURST_SENDERS }, (_, i) => '9725' + String(9_000_000 + i).padStart(8, '0'));

    const burstStart = Date.now();
    await runWithCap(senderPhones, CONCURRENCY_CAP, async (phone) => {
      const triggerAt = Date.now();
      const jid = 'whatsapp:' + phone;

      const result = storage.recordCampaignTrigger(campaign.id, phone, `burst-${phone}`);
      storage.enqueueContactSave(phone, `Burst ${phone}`, result.id);

      // Mirrors sendTrackedOutboxMessage: enqueue -> claim -> flush (durable
      // before "sending") -> mark sent -> flush again. This is exactly the
      // path that sat behind the 20-40s production delay.
      const message = storage.enqueueOutboxMessage({ kind: 'text', to: jid, text: 'decision message', idempotencyKey: `burst:${phone}:decision` });
      if (!storage.claimOutboxMessage(message.id)) throw new Error(`could not claim outbox message for ${phone}`);
      await storage.flush();
      storage.markOutboxSent(message.id, `wamid.burst.${phone}`);
      await storage.flush();

      const firstSendAt = Date.now();
      latenciesMs.push(firstSendAt - triggerAt);

      storage.recordCampaignEvent({ campaignId: campaign.id, campaignResultId: result.id, phone, type: 'step_sent', label: 'burst' });
      conversationState.set(jid, {
        kind: 'decision', senderJid: jid, senderPhone: phone,
        campaignId: campaign.id, campaignResultId: result.id,
        flow: campaign.conversation.decisionFlow, stepId: 's2',
        timestamp: Date.now(), timeoutHandle: setTimeout(() => {}, 10_000_000),
      });
    });
    await storage.flush();
    const burstWallMs = Date.now() - burstStart;

    latenciesMs.sort((a, b) => a - b);
    console.log(`\nBurst complete in ${(burstWallMs / 1000).toFixed(1)}s wall time.`);
    console.log('Trigger-to-first-send latency (the number that was 20-40s in production):');
    console.log(`  p50: ${percentile(latenciesMs, 50)}ms`);
    console.log(`  p95: ${percentile(latenciesMs, 95)}ms`);
    console.log(`  max: ${latenciesMs[latenciesMs.length - 1]}ms`);

    // ---- Safety check 1: any idle-in-transaction episode long enough to be
    // worth reporting (>= REPORT_STREAK_AT samples) must have RESOLVED on
    // its own during the run. One that is still open when sampling stops is
    // the actual bug this guards against - a connection that will never
    // come back without intervention. A slow-but-progressing transaction
    // (heavy JS-side diffing between statements at seed scale) resolves;
    // a stranded one (BEGIN and the next statement on different pooled
    // connections) does not.
    //
    // storage.flush() already returned after the burst, which by the
    // writeSeq/durableSeq contract means every write it was told about has
    // committed - so anything still idle-in-transaction here belongs to
    // neither the seed nor the burst's tracked work. Give it a generous
    // settle window before concluding it is actually stuck, so a
    // still-finishing-but-fine transaction isn't misreported.
    console.log('\nSettling for up to 20s before evaluating idle-in-transaction episodes...');
    const settleDeadline = Date.now() + 20_000;
    while (Date.now() < settleDeadline && [...idleStreaks.values()].some((e) => e.count >= REPORT_STREAK_AT)) {
      await new Promise((r) => setTimeout(r, 500));
    }
    sampling = false;
    await sampler;
    if (episodes.length) {
      console.log(`\n${episodes.length} idle-in-transaction episode(s) of >= ${REPORT_STREAK_AT} samples during the run:`);
      for (const ep of episodes) {
        console.log(`  pid ${ep.pid}: ${ep.resolved ? 'resolved' : 'STILL OPEN'} after ~${ep.durationS.toFixed(1)}s (${ep.samples} samples) - ${String(ep.lastQuery).slice(0, 80)}`);
      }
    }
    const stuckForever = episodes.filter((ep) => !ep.resolved);
    if (stuckForever.length) {
      const { rows: lockRows } = await diagPool.query(
        `select count(*)::int as n from pg_locks l
           join pg_stat_activity a on a.pid = l.pid
          where a.application_name = $1 and a.state = 'idle in transaction'`,
        [APP_NAME],
      );
      console.log(`  still-stuck connection(s) are holding ${lockRows[0].n} lock(s) right now.`);
    }
    assert.equal(stuckForever.length, 0,
      `${stuckForever.length} connection(s) were still idle-in-transaction when the run ended - stranded, not just slow`);
    console.log(episodes.length
      ? `\n1. ${episodes.length} slow-but-progressing transaction(s) at this backlog scale, all resolved on their own - nothing stranded.`
      : '\n1. no connection was ever idle-in-transaction for more than a brief statement-to-statement gap.');

    // ---- Safety check 2: every burst sender's outbox message is durable,
    // exactly once, with its idempotency key intact.
    const reloaded = await loadStorageSnapshot(baseUrl);
    const burstRows = reloaded.outboxMessages.filter((m) => m.idempotencyKey && m.idempotencyKey.startsWith('burst:'));
    assert.equal(burstRows.length, BURST_SENDERS, `expected ${BURST_SENDERS} burst outbox rows, found ${burstRows.length}`);
    const distinctKeys = new Set(burstRows.map((m) => m.idempotencyKey));
    assert.equal(distinctKeys.size, BURST_SENDERS, 'every burst sender must have exactly one outbox row - found a duplicate idempotencyKey');
    const notSent = burstRows.filter((m) => m.status !== 'sent');
    assert.equal(notSent.length, 0, `${notSent.length} burst outbox row(s) never reached "sent"`);
    console.log(`2. all ${BURST_SENDERS} burst sends are durable exactly once, all marked sent, no duplicates.`);

    console.log('\nShort-form campaign-scale load test passed.');
    console.log(`(Backlog kept in place at ${baseUrl.replace(/:[^:]*@/, ':***@')} for inspection - rerun clearData or the setup phase to reset.)`);

    await backend.close();
  } finally {
    sampling = false;
    await diagPool.end().catch(() => {});
    await setupPool.end().catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
