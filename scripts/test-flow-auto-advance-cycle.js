'use strict';

/**
 * A campaign whose message steps send on to each other in a circle used to send the same messages forever
 * (production incident 2026-10-12). Covers: the pure cycle finder, the runtime guard (a circular flow stops,
 * an ordinary chain and a question menu that loops back are untouched), the save-time rejection helper's
 * inputs, and the editor showing "send and end" for a step that has no next step.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findAutoAdvanceCycleStepIds } = require('../dist/flowCycles');
const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

const msg = (id, nextStepId) => ({ id, kind: 'message', text: `text ${id}`, ...(nextStepId ? { nextStepId } : {}) });

// ── pure finder
assert.deepEqual([...findAutoAdvanceCycleStepIds([msg('a', 'b'), msg('b', 'c'), msg('c')])], [], 'a plain chain is not a cycle');
assert.deepEqual([...findAutoAdvanceCycleStepIds([msg('a', 'a')])], ['a'], 'a step pointing at itself');
assert.deepEqual([...findAutoAdvanceCycleStepIds([msg('a', 'b'), msg('b', 'c'), msg('c', 'a')])].sort(), ['a', 'b', 'c']);
assert.deepEqual([...findAutoAdvanceCycleStepIds([msg('a', 'b'), msg('b', 'c'), msg('c', 'b')])].sort(), ['b', 'c'], 'a tail leading into a circle is not on the circle');
const menu = [
  { id: 'q', kind: 'question', presentation: 'buttons', text: 'menu', options: [{ id: 'o', text: 'x', action: 'goto', nextStepId: 'm' }] },
  msg('m', 'q'),
];
assert.deepEqual([...findAutoAdvanceCycleStepIds(menu)], [], 'a loop that passes through a question waits for the participant, so it is allowed');
assert.deepEqual([...findAutoAdvanceCycleStepIds(undefined)], []);

// ── editor default
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert.ok(html.includes("data-selected-next=\"${esc(step.nextStepId || '__END__')}\""), 'a step with no next step must load as "send and end"');

// ── runtime
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cycle-'));
let seq = 0;
async function run(storage, trigger, phone, decisionFlow) {
  storage.addCampaign({
    name: trigger, triggerType: 1, triggerPhrase: trigger, suffix: '', active: true,
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow },
  });
  const sent = [];
  const transport = {
    async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); },
    async sendMessage(to, text) {
      sent.push(String(text));
      if (sent.length > 40) { console.error('FAIL: runaway loop, more than 40 messages sent'); process.exit(1); }
      return { messageId: `wamid.${sent.length}` };
    },
  };
  seq += 1;
  await handleIncomingWhatsAppMessage({
    id: `cycle-${seq}`, from: `whatsapp:${phone}`, body: trigger, hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'Cycle test'; },
  }, storage, transport, 'webhook');
  conversationState.remove(`whatsapp:${phone}`);
  return sent;
}

(async () => {
  const storage = new Storage(path.join(directory, 'storage.json'));
  try {
    const chain = await run(storage, 'chain-trigger', '972500000601', [msg('a', 'b'), msg('b', 'c'), msg('c')]);
    assert.deepEqual(chain.filter((t) => /^text [abc]$/.test(t)), ['text a', 'text b', 'text c'], 'an ordinary chain still sends every step once');

    const loop = await run(storage, 'loop-trigger', '972500000602', [msg('a', 'b'), msg('b', 'c'), msg('c', 'a')]);
    assert.ok(loop.length <= 3, `a circular flow must stop, sent ${loop.length}`);
    console.log('circular flow sent', loop.length, 'message(s) and stopped');
    console.log('Flow auto-advance cycle tests passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
