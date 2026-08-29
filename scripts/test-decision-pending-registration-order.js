'use strict';

/**
 * Regression test for a race condition identified in code review: the pending
 * "awaiting a decision reply" state (conversationState) used to be registered
 * AFTER the question message was sent, not before. Since Meta can deliver a
 * button/list message to the recipient the instant our API call is accepted,
 * a fast enough reply could arrive and be processed while this function was
 * still awaiting that same API call - finding no pending state yet.
 *
 * sendDecisionStep (src/messageFlow.ts) now registers the pending state
 * BEFORE attempting the send, and rolls it back if the send ultimately fails
 * entirely - preserving the pre-existing "no pending state on total send
 * failure" behavior while closing the window where a reply could outrun it.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-pending-order-'));

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

function addCampaign(storage, trigger) {
  return storage.addCampaign({
    name: trigger,
    triggerType: 1,
    triggerPhrase: trigger,
    suffix: '',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      decisionFlow: [{
        id: 'question', kind: 'question', presentation: 'buttons', text: 'Continue?',
        options: [{ id: 'yes', text: 'Yes', action: 'goto', nextStepId: '' }],
      }],
    },
  });
}

let inboundSequence = 0;
async function inbound(storage, transport, phone, body) {
  inboundSequence += 1;
  await handleIncomingWhatsAppMessage({
    id: `pending-order-${inboundSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Pending order test'; },
  }, storage, transport, 'webhook');
}

(async () => {
  const storage = new Storage(path.join(directory, 'storage.json'));
  try {
    // ── Case 1: the pending state must already exist at the moment the send
    // is actually attempted - not only after it resolves. No transport
    // supports interactive buttons here, so the flow falls back to plain
    // text (sendMessage), which is where we capture the state mid-send.
    {
      const phone1 = '972500000401';
      addCampaign(storage, 'order-test-1');
      let stateDuringSend;
      const transport1 = {
        async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); },
        async sendMessage(to) {
          stateDuringSend = conversationState.get(to);
          return { messageId: 'wamid.order-1' };
        },
      };
      await inbound(storage, transport1, phone1, 'order-test-1');
      assert.ok(stateDuringSend, 'pending state must already be registered at the moment the question is being sent, not only after it succeeds');
      assert.equal(stateDuringSend.kind, 'decision');
      const stateAfter = conversationState.get(`whatsapp:${phone1}`);
      assert.ok(stateAfter, 'pending state must remain registered after a successful send');
      conversationState.remove(`whatsapp:${phone1}`);
      console.log('Case 1 passed: pending state exists before the send resolves, not only after.');
    }

    // ── Case 2: if the send fails completely (all attempts exhausted), the
    // pending state registered up front must be rolled back - matching the
    // pre-existing "no pending state on total failure" behavior exactly.
    {
      const phone2 = '972500000402';
      addCampaign(storage, 'order-test-2');
      const transport2 = {
        async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); },
        async sendMessage() {
          throw new Error('Simulated total Meta API failure');
        },
      };
      // A total send failure is caught and logged upstream (sendDecisionFlowStart)
      // rather than propagating out of handleIncomingWhatsAppMessage - that
      // catch/log behavior is pre-existing and unrelated to this fix. What
      // this test verifies is that it does not leave a stale pending state.
      await inbound(storage, transport2, phone2, 'order-test-2');
      const stateAfterFailure = conversationState.get(`whatsapp:${phone2}`);
      assert.equal(stateAfterFailure, undefined, 'pending state must be rolled back when the question was never actually delivered');
      console.log('Case 2 passed: pending state is rolled back when the send fails completely.');
    }

    console.log('Decision pending-state registration order tests passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
