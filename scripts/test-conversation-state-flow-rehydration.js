'use strict';

/**
 * Regression test for the conversation-state size fix: the campaign decision
 * flow is an identical copy in every conversation on the same campaign and
 * dominated the persisted snapshot (~7.0 KB of a ~7.6 KB conversation; 13 MB
 * across ~1,200 live conversations). persist() runs synchronously on every
 * conversation change, so that size was paid as event-loop blocking on every
 * step transition.
 *
 * The flow is now stripped before writing and rebuilt from the campaign on
 * restore. These tests prove the restored state is equivalent to what was
 * stored, that older snapshots which still embed a flow keep working, and that
 * a deleted campaign degrades cleanly instead of crashing.
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { conversationState } = require('../dist/conversationState');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'convstate-flow-'));
const filePath = path.join(directory, 'conversation-state.json');

// Sized to match a real campaign flow measured in production: each live
// conversation was ~7.6 KB, of which ~7.0 KB was this flow.
function buildFlow(marker) {
  const steps = [
    { id: 'step-a', kind: 'message', text: 'שמחים שהצטרפת לפעילות! תכף שולחים לך את כל הפרטים. ' + marker, nextStepId: 'step-b' },
    {
      id: 'step-b', kind: 'question', presentation: 'buttons', text: 'רוצה לשמוע עוד? ' + marker,
      options: [{ id: 'opt-1', text: 'כן בשמחה', action: 'goto', nextStepId: 'step-c' }],
    },
    { id: 'step-c', kind: 'message', text: 'done ' + marker },
  ];
  // Filler steps so the flow reaches production size; the test measures the
  // effect of flow SIZE, so an unrealistically small flow would understate it.
  for (let i = 0; i < 14; i += 1) {
    steps.push({
      id: `step-filler-${i}`,
      kind: 'question',
      presentation: 'buttons',
      text: `אפשרות מספר ${i} עם טקסט ארוך שמתאר את השלב הזה בפירוט למשתתפת ${marker}`,
      options: [
        { id: `opt-${i}-a`, text: 'האפשרות הראשונה', action: 'goto', nextStepId: 'step-c', endText: 'תודה שבחרת באפשרות הראשונה, נחזור אליך בהקדם' },
        { id: `opt-${i}-b`, text: 'האפשרות השנייה', action: 'goto', nextStepId: 'step-c', endText: 'תודה שבחרת באפשרות השנייה, נחזור אליך בהקדם' },
      ],
    });
  }
  return steps;
}

function decisionState(jid, campaignId, flow) {
  return {
    kind: 'decision',
    senderJid: jid,
    senderPhone: jid.replace(/\D/g, ''),
    campaignId,
    campaignResultId: 'result-' + jid.slice(-4),
    flow,
    stepId: 'step-b',
    humanHandoffEnabled: true,
    humanHandoffText: 'talk to a human',
    humanHandoffPhone: '972500000000',
    decisionTimeoutMinutes: 30,
    decisionTimeoutText: 'timed out',
    decisionTimeoutMode: 'stop',
    timeoutFlowStarted: false,
    timestamp: Date.now(),
    timeoutHandle: setTimeout(() => {}, 60_000),
  };
}

function readSnapshotFromDisk() {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// A minimal stand-in for Storage as the persistence backend.
function makeBackend() {
  let stored;
  return {
    loadConversationStateSnapshot: () => stored,
    saveConversationStateSnapshot: (snapshot) => { stored = JSON.parse(JSON.stringify(snapshot)); },
    _peek: () => stored,
  };
}

(async () => {
  try {
    const flow = buildFlow('campaign-1');

    // ── 1. The flow must NOT be written to disk, but everything else must be.
    {
      const backend = makeBackend();
      conversationState.configurePersistence(filePath, backend);
      conversationState.restore(() => setTimeout(() => {}, 60_000)); // marks hydration complete
      const jid = 'whatsapp:972500000001';
      conversationState.set(jid, decisionState(jid, 'campaign-1', flow));

      const onDisk = readSnapshotFromDisk().conversations[jid];
      assert.ok(onDisk, 'the conversation must still be persisted');
      assert.equal(onDisk.flow, undefined, 'the campaign flow must NOT be written to the snapshot');
      assert.equal(onDisk.stepId, 'step-b', 'the step pointer must still be persisted');
      assert.equal(onDisk.campaignId, 'campaign-1', 'campaignId must be persisted - it is what rebuilds the flow');
      assert.equal(onDisk.campaignResultId, 'result-0001');
      assert.equal(onDisk.humanHandoffPhone, '972500000000', 'unrelated fields must be untouched');
      assert.equal(onDisk.decisionTimeoutMode, 'stop');

      // The in-memory state must still carry the flow - runtime code reads it.
      const inMemory = conversationState.get(jid);
      assert.deepEqual(inMemory.flow, flow, 'the in-memory state must keep the flow for runtime use');
      conversationState.remove(jid);
      console.log('1. flow stripped from the snapshot, in-memory state untouched.');
    }

    // ── 2. Restore rebuilds the flow from the campaign, producing a state
    //      equivalent to what was originally stored.
    {
      const backend = makeBackend();
      conversationState.configurePersistence(filePath, backend);
      conversationState.restore(() => setTimeout(() => {}, 60_000));
      const jid = 'whatsapp:972500000002';
      const original = decisionState(jid, 'campaign-1', flow);
      conversationState.set(jid, original);
      conversationState.remove(jid); // clear in-memory; snapshot in backend still has it

      // Re-seed the backend with the stripped snapshot as if the process restarted.
      const stripped = { version: 1, savedAt: new Date().toISOString(), conversations: {} };
      stripped.conversations[jid] = (() => {
        const { timeoutHandle, flow: _f, ...rest } = original;
        return rest;
      })();
      const restartBackend = {
        loadConversationStateSnapshot: () => stripped,
        saveConversationStateSnapshot: () => {},
      };
      conversationState.configurePersistence(filePath, restartBackend);
      let seen;
      const count = conversationState.restore(
        (_jid, state) => { seen = state; return setTimeout(() => {}, 60_000); },
        (campaignId) => (campaignId === 'campaign-1' ? flow : undefined),
      );
      assert.equal(count, 1, 'the conversation must be restored');
      assert.deepEqual(seen.flow, flow, 'the flow must be rebuilt from the campaign before scheduling');
      assert.equal(seen.stepId, 'step-b', 'the step pointer must survive the round trip');
      assert.equal(seen.campaignResultId, 'result-0002');
      assert.deepEqual(conversationState.get(jid).flow, flow, 'the restored in-memory state must carry the flow');
      conversationState.remove(jid);
      console.log('2. restore rebuilds the flow from the campaign.');
    }

    // ── 3. Backward compatibility: a snapshot written BEFORE this change still
    //      embeds its own flow. It must be used as-is, not overwritten.
    {
      const jid = 'whatsapp:972500000003';
      const legacyFlow = buildFlow('legacy-embedded');
      const legacy = { version: 1, savedAt: new Date().toISOString(), conversations: {} };
      legacy.conversations[jid] = (() => {
        const { timeoutHandle, ...rest } = decisionState(jid, 'campaign-1', legacyFlow);
        return rest;
      })();
      conversationState.configurePersistence(filePath, {
        loadConversationStateSnapshot: () => legacy,
        saveConversationStateSnapshot: () => {},
      });
      let seen;
      conversationState.restore(
        (_jid, state) => { seen = state; return setTimeout(() => {}, 60_000); },
        () => buildFlow('resolver-should-not-win'),
      );
      assert.deepEqual(seen.flow, legacyFlow, 'an already-embedded flow must be preserved, not replaced by the resolver');
      conversationState.remove(jid);
      console.log('3. older snapshots that still embed a flow keep working.');
    }

    // ── 4. Deleted campaign: must degrade cleanly to an empty flow (every
    //      reader already treats "step not found" as a stale conversation),
    //      never crash and never leave `flow` undefined.
    {
      const jid = 'whatsapp:972500000004';
      const orphan = { version: 1, savedAt: new Date().toISOString(), conversations: {} };
      orphan.conversations[jid] = (() => {
        const { timeoutHandle, flow: _f, ...rest } = decisionState(jid, 'deleted-campaign', flow);
        return rest;
      })();
      conversationState.configurePersistence(filePath, {
        loadConversationStateSnapshot: () => orphan,
        saveConversationStateSnapshot: () => {},
      });
      let seen;
      conversationState.restore(
        (_jid, state) => { seen = state; return setTimeout(() => {}, 60_000); },
        () => undefined, // campaign no longer exists
      );
      assert.ok(Array.isArray(seen.flow), 'flow must always be an array, never undefined');
      assert.equal(seen.flow.length, 0, 'a deleted campaign must yield an empty flow');
      assert.equal(seen.flow.find((s) => s.id === 'step-b'), undefined, 'lookups must return undefined, which callers already handle');
      conversationState.remove(jid);
      console.log('4. a deleted campaign degrades cleanly to an empty flow.');
    }

    // ── 5. The actual point: measured snapshot size at live scale.
    {
      const backend = makeBackend();
      conversationState.configurePersistence(filePath, backend);
      conversationState.restore(() => setTimeout(() => {}, 60_000));
      const jids = [];
      for (let i = 0; i < 1000; i += 1) {
        const jid = `whatsapp:97253${String(1000000 + i).padStart(7, '0')}`;
        jids.push(jid);
        conversationState.set(jid, decisionState(jid, 'campaign-1', flow));
      }
      const leanBytes = fs.statSync(filePath).size;

      // What the same 1,000 conversations would have cost with the flow embedded.
      const snapshot = readSnapshotFromDisk();
      for (const jid of jids) snapshot.conversations[jid].flow = flow;
      const fatBytes = Buffer.byteLength(JSON.stringify(snapshot, null, 2));

      const flowBytes = Buffer.byteLength(JSON.stringify(flow, null, 2));
      console.log(`5. flow size ${(flowBytes / 1024).toFixed(1)} KB (production measured ~7.0 KB)`);
      console.log(`   1,000 conversations: ${(fatBytes / 1024 / 1024).toFixed(2)} MB before → ${(leanBytes / 1024 / 1024).toFixed(2)} MB after (${(fatBytes / leanBytes).toFixed(1)}x smaller)`);
      assert.ok(leanBytes * 5 < fatBytes, `expected a large reduction at production flow size, got ${fatBytes} → ${leanBytes}`);
      for (const jid of jids) conversationState.remove(jid);
    }

    console.log('\nConversation-state flow rehydration tests passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
