'use strict';

/**
 * Sustained-duration campaign-scale load test, run #2 (the "fuller" follow-up
 * to test-campaign-scale-load.js's short burst).
 *
 * The short version proved the fix at production scale over ~11 seconds of
 * concurrent load. This version stretches that over real wall-clock time and
 * paces arrivals to match yesterday's actual campaign rather than firing
 * everything at once, because a sustained run can expose things a burst
 * can't: growing tables mid-run, the concurrency cap under continuous
 * pressure instead of one spike, and whether latency drifts as the backlog
 * keeps accumulating during the test itself (exactly how a real campaign
 * behaves - the backlog is not static, it grows as the campaign runs).
 *
 * Pacing is calibrated from yesterday's own /health measurements:
 * outbox.total grew 14,382 -> 16,987 over ~8.15 hours of active traffic,
 * i.e. ~320 sends/hour baseline (~1 every 11.25s). Real campaigns are not
 * smooth, though - production logs showed clusters (a link reshared, a
 * status re-viewed) landing many triggers within seconds. This models both:
 * a steady baseline trickle at the measured rate, plus periodic burst
 * events (20-50 concurrent arrivals within a few seconds, every ~2 minutes)
 * layered on top, all admitted through the same 50-concurrent cap
 * production actually enforces (META_MAX_CONCURRENT_SENDERS).
 *
 * Runs against a REAL local Postgres (flowsbiz_test convention). Checks:
 *
 *   1. Trigger-to-first-send latency (p50/p95/max), reported both overall
 *      and in rolling windows, to see whether it drifts as the run and the
 *      backlog it writes into both grow.
 *   2. No connection is ever left idle-in-transaction beyond a generous
 *      settle window - anything that resolves is a slow transaction at
 *      scale (a performance note), not the B2-1 stranding bug.
 *   3. Zero lost writes, zero duplicate outbox rows, at the end of a run
 *      that kept writing the whole time, not just in one clean burst.
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createPostgresBackend, loadStorageSnapshot } = require('../dist/database');
const { emptyStorageData, Storage } = require('../dist/storage');

const APP_NAME = 'flowsbiz_sustained_load_test';
const SEED = {
  outboxMessages: 17_000,
  campaignResults: 13_000,
  campaignEvents: 18_000,
  conversationState: 1_500,
  savedContacts: 2_000,
};
const CONCURRENCY_CAP = 50; // matches META_MAX_CONCURRENT_SENDERS in adminServer.ts
const DURATION_MINUTES = Number(process.env.LOAD_TEST_MINUTES) || 10;
const BASELINE_INTERVAL_MS = 11_250; // ~320 sends/hour, measured from yesterday's own /health growth
const BURST_EVERY_MS = 120_000; // a link-reshare moment roughly every 2 minutes
const BURST_SIZE_RANGE = [20, 50];
const SNAPSHOT_EVERY_MS = 30_000;
const SAMPLE_LOCKS_EVERY_MS = 400;
const REPORT_STREAK_AT = 3;
const SETTLE_GRACE_MS = 25_000;

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

function fmtMs(ms) { return `${ms}ms`; }

// A live-admission semaphore (not a fixed batch): callers arrive over time
// and each awaits a slot, exactly like production's createSenderDrainer caps
// concurrent flows rather than concurrent batches.
function makeSemaphore(max) {
  let inUse = 0;
  const waiters = [];
  return {
    async acquire() {
      if (inUse < max) { inUse += 1; return; }
      await new Promise((resolve) => waiters.push(resolve));
      inUse += 1;
    },
    release() {
      inUse -= 1;
      const next = waiters.shift();
      if (next) next();
    },
    inUse: () => inUse,
  };
}

async function main() {
  const baseUrl = process.env.TEST_DATABASE_URL
    || 'postgres://flowsbiz_test:flowsbiz_test@localhost:5432/flowsbiz_test';
  assertSafeTestDatabase(baseUrl);
  const backendUrl = withAppName(baseUrl, APP_NAME);

  const diagPool = new Pool({ connectionString: withAppName(baseUrl, `${APP_NAME}_diag`) });
  const setupPool = new Pool({ connectionString: withAppName(baseUrl, `${APP_NAME}_setup`) });

  let sampling = true;
  const idleStreaks = new Map();
  const episodes = [];
  const sampler = (async () => {
    while (sampling) {
      try {
        const { rows } = await diagPool.query(
          `select pid, query, extract(epoch from (now() - xact_start)) as xact_age_s
             from pg_stat_activity
            where application_name = $1 and state = 'idle in transaction'`,
          [APP_NAME],
        );
        const seenNow = new Map(rows.map((r) => [r.pid, r]));
        for (const [pid, row] of seenNow) {
          const entry = idleStreaks.get(pid) ?? { count: 0, firstSeenAt: Date.now(), lastQuery: row.query };
          entry.count += 1;
          entry.lastQuery = row.query;
          idleStreaks.set(pid, entry);
        }
        for (const [pid, entry] of [...idleStreaks.entries()]) {
          if (!seenNow.has(pid)) {
            if (entry.count >= REPORT_STREAK_AT) {
              episodes.push({ pid, durationS: (Date.now() - entry.firstSeenAt) / 1000, samples: entry.count, resolved: true, lastQuery: entry.lastQuery });
            }
            idleStreaks.delete(pid);
          }
        }
      } catch { /* transient during pool churn */ }
      await new Promise((r) => setTimeout(r, SAMPLE_LOCKS_EVERY_MS));
    }
    for (const [pid, entry] of idleStreaks.entries()) {
      if (entry.count >= REPORT_STREAK_AT) {
        episodes.push({ pid, durationS: (Date.now() - entry.firstSeenAt) / 1000, samples: entry.count, resolved: false, lastQuery: entry.lastQuery });
      }
    }
  })();

  const report = { seed: {}, run: {}, safety: {}, snapshots: [] };

  try {
    console.log(`Seeding a production-scale backlog: ${SEED.outboxMessages} outbox / ${SEED.campaignResults} results / ${SEED.campaignEvents} events / ${SEED.conversationState} conversations / ${SEED.savedContacts} contacts.`);
    await clearData(setupPool);

    const backend = await createPostgresBackend(backendUrl);
    const storage = new Storage('unused-sustained-load-test.json', { initialData: emptyStorageData(), backend });
    await storage.flush();

    const campaign = storage.addCampaign({
      name: 'sustained-load-test', triggerType: 1, triggerPhrase: 'go', suffix: '', active: true,
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
      if (i < SEED.savedContacts) storage.markContactSaved(phone, `Seed Contact ${i}`);
      if (i % 250 === 0) await storage.flush();
    }
    await storage.flush();

    const { conversationState } = require('../dist/conversationState');
    conversationState.configurePersistence(path.join(require('node:os').tmpdir(), 'sustained-load-test-conv.json'), storage);
    conversationState.restore(() => setTimeout(() => {}, 10_000_000));
    for (let i = 0; i < SEED.conversationState; i += 1) {
      const phone = '9725' + String(2_000_000 + i).padStart(8, '0');
      const jid = 'whatsapp:' + phone;
      const expired = i % 5 !== 0;
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
    report.seed = { ...SEED, seedSeconds: (Date.now() - seedStart) / 1000 };
    console.log(`Seed complete in ${report.seed.seedSeconds.toFixed(1)}s. Backlog is now production scale.\n`);

    // ---- Sustained phase --------------------------------------------------
    console.log(`Running a ${DURATION_MINUTES}-minute sustained load: baseline ~1 sender/${(BASELINE_INTERVAL_MS / 1000).toFixed(1)}s (~320/hr, yesterday's measured rate) + a ${BURST_SIZE_RANGE[0]}-${BURST_SIZE_RANGE[1]}-sender burst every ${BURST_EVERY_MS / 1000}s, all through a ${CONCURRENCY_CAP}-concurrent cap.\n`);

    const sem = makeSemaphore(CONCURRENCY_CAP);
    const latencies = []; // { atMs, latencyMs } - atMs relative to run start, for windowed reporting
    const runStart = Date.now();
    const endAt = runStart + DURATION_MINUTES * 60_000;
    let senderSeq = 0;
    let launched = 0;
    let completed = 0;
    let failures = 0;
    const inFlight = [];

    const launchSender = () => {
      senderSeq += 1;
      const seq = senderSeq;
      const phone = '9725' + String(9_000_000 + seq).padStart(8, '0');
      const jid = 'whatsapp:' + phone;
      const arrivedAt = Date.now();
      launched += 1;
      const p = (async () => {
        await sem.acquire();
        try {
          const result = storage.recordCampaignTrigger(campaign.id, phone, `sustained-${phone}`);
          storage.enqueueContactSave(phone, `Sustained ${phone}`, result.id);

          const message = storage.enqueueOutboxMessage({ kind: 'text', to: jid, text: 'decision message', idempotencyKey: `sustained:${phone}:decision` });
          if (!storage.claimOutboxMessage(message.id)) throw new Error(`could not claim outbox message for ${phone}`);
          await storage.flush();
          storage.markOutboxSent(message.id, `wamid.sustained.${seq}`);
          await storage.flush();

          const latencyMs = Date.now() - arrivedAt;
          latencies.push({ atMs: arrivedAt - runStart, latencyMs });
          completed += 1;

          storage.recordCampaignEvent({ campaignId: campaign.id, campaignResultId: result.id, phone, type: 'step_sent', label: 'sustained' });
          conversationState.set(jid, {
            kind: 'decision', senderJid: jid, senderPhone: phone,
            campaignId: campaign.id, campaignResultId: result.id,
            flow: campaign.conversation.decisionFlow, stepId: 's2',
            timestamp: Date.now(), timeoutHandle: setTimeout(() => {}, 10_000_000),
          });
        } catch (err) {
          failures += 1;
          console.error(`  [sender ${seq} failed] ${err.message}`);
        } finally {
          sem.release();
        }
      })();
      inFlight.push(p);
    };

    let lastSnapshotAt = 0;
    let lastBurstAt = 0;
    let nextBaselineAt = 0;
    while (Date.now() < endAt) {
      const elapsed = Date.now() - runStart;

      if (elapsed >= nextBaselineAt) {
        launchSender();
        nextBaselineAt = elapsed + BASELINE_INTERVAL_MS;
      }
      if (elapsed - lastBurstAt >= BURST_EVERY_MS) {
        lastBurstAt = elapsed;
        const size = BURST_SIZE_RANGE[0] + Math.floor(Math.random() * (BURST_SIZE_RANGE[1] - BURST_SIZE_RANGE[0]));
        console.log(`  [t+${(elapsed / 1000).toFixed(0)}s] burst event: ${size} concurrent arrivals`);
        for (let i = 0; i < size; i += 1) launchSender();
      }
      if (elapsed - lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
        lastSnapshotAt = elapsed;
        const recent = latencies.filter((l) => elapsed - l.atMs < SNAPSHOT_EVERY_MS).map((l) => l.latencyMs).sort((a, b) => a - b);
        const snap = {
          atS: Math.round(elapsed / 1000), launched, completed, failures, inFlight: sem.inUse(),
          recentP50: percentile(recent, 50), recentMax: recent[recent.length - 1] ?? 0,
        };
        report.snapshots.push(snap);
        console.log(`  [t+${snap.atS}s] launched=${launched} completed=${completed} failures=${failures} concurrent=${snap.inFlight} recent-p50=${fmtMs(snap.recentP50)} recent-max=${fmtMs(snap.recentMax)}`);
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`\nRun window elapsed (${DURATION_MINUTES} min). Draining ${inFlight.length - completed - failures} in-flight sender(s)...`);
    await Promise.all(inFlight);
    await storage.flush();
    const runWallMs = Date.now() - runStart;

    const allLatencies = latencies.map((l) => l.latencyMs).sort((a, b) => a - b);
    report.run = {
      durationMinutes: DURATION_MINUTES, wallMs: runWallMs, launched, completed, failures,
      p50: percentile(allLatencies, 50), p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99), max: allLatencies[allLatencies.length - 1] ?? 0,
    };
    console.log(`\nSustained run complete: ${completed}/${launched} sends completed (${failures} failure(s)) over ${(runWallMs / 1000).toFixed(0)}s.`);
    console.log('Trigger-to-first-send latency, whole run:');
    console.log(`  p50: ${fmtMs(report.run.p50)}  p95: ${fmtMs(report.run.p95)}  p99: ${fmtMs(report.run.p99)}  max: ${fmtMs(report.run.max)}`);
    assert.equal(failures, 0, `${failures} sender(s) failed during the sustained run`);

    // ---- Safety check 1: idle-in-transaction, with a settle grace period,
    // exactly as validated in the short-form run.
    console.log(`\nSettling for up to ${SETTLE_GRACE_MS / 1000}s before evaluating idle-in-transaction episodes...`);
    const settleDeadline = Date.now() + SETTLE_GRACE_MS;
    while (Date.now() < settleDeadline && [...idleStreaks.values()].some((e) => e.count >= REPORT_STREAK_AT)) {
      await new Promise((r) => setTimeout(r, 500));
    }
    sampling = false;
    await sampler;
    const stuckForever = episodes.filter((ep) => !ep.resolved);
    report.safety.idleTransactionEpisodes = episodes.length;
    report.safety.stuckForever = stuckForever.length;
    report.safety.longestEpisodeS = episodes.reduce((m, ep) => Math.max(m, ep.durationS), 0);
    if (episodes.length) {
      console.log(`${episodes.length} idle-in-transaction episode(s) of >= ${REPORT_STREAK_AT} samples, longest ${report.safety.longestEpisodeS.toFixed(1)}s, all ${stuckForever.length ? 'NOT ' : ''}resolved.`);
    }
    assert.equal(stuckForever.length, 0, `${stuckForever.length} connection(s) were still idle-in-transaction when the run ended`);
    console.log('1. no connection was ever stranded (all idle-in-transaction episodes resolved).');

    // ---- Safety check 2: durability and no duplicates across the whole run.
    const reloaded = await loadStorageSnapshot(baseUrl);
    const sustainedRows = reloaded.outboxMessages.filter((m) => m.idempotencyKey && m.idempotencyKey.startsWith('sustained:'));
    report.safety.expectedSends = completed;
    report.safety.durableRows = sustainedRows.length;
    assert.equal(sustainedRows.length, completed, `expected ${completed} durable sustained-run outbox rows, found ${sustainedRows.length}`);
    const distinctKeys = new Set(sustainedRows.map((m) => m.idempotencyKey));
    assert.equal(distinctKeys.size, completed, 'found a duplicate idempotencyKey among sustained-run outbox rows');
    const notSent = sustainedRows.filter((m) => m.status !== 'sent');
    assert.equal(notSent.length, 0, `${notSent.length} sustained-run outbox row(s) never reached "sent"`);
    console.log(`2. all ${completed} sustained sends are durable exactly once, all marked sent, no duplicates.`);

    console.log('\nSustained campaign-scale load test passed.');
    await backend.close();

    const reportPath = path.join(__dirname, '..', 'docs', 'campaign-scale-load-test-results-2026-09-02.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Raw results written to ${reportPath}`);
  } finally {
    sampling = false;
    await diagPool.end().catch(() => {});
    await setupPool.end().catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
