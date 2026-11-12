'use strict';

/**
 * A "message that waits for a reply" step asks the participant to send a photo (production, 2026-11-11: participants who answered with a
 * caption-less photo were ignored and never got the next message). Covers: a caption-less image/video/document advances the flow,
 * a text reply still does, a voice message / sticker is still ignored, and an email_capture step is NOT advanced by media.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage, mediaReplyLabel } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

assert.equal(mediaReplyLabel('image'), '[image]');
assert.equal(mediaReplyLabel('video'), '[video]');
assert.equal(mediaReplyLabel('document'), '[document]');
assert.equal(mediaReplyLabel('audio'), undefined);
assert.equal(mediaReplyLabel('sticker'), undefined);
assert.equal(mediaReplyLabel(undefined), undefined);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-media-'));
let seq = 0;

async function scenario(storage, name, firstKind, reply) {
  const trigger = `trig-${name}`;
  const phone = `97250000${String(700 + seq).padStart(4, '0')}`;
  const from = `whatsapp:${phone}`;
  const decisionFlow = [
    { id: 'w', kind: firstKind, text: 'send the photo', nextStepId: 'done' },
    { id: 'done', kind: 'message', text: 'thanks, you are in' },
  ];
  storage.addCampaign({
    name: trigger, triggerType: 1, triggerPhrase: trigger, suffix: '', active: true,
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow },
  });
  const sent = [];
  const transport = {
    async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); },
    async sendMessage(to, text) { sent.push(String(text)); return { messageId: `wamid.${name}.${sent.length}` }; },
  };
  const base = { from, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'Wait media test'; } };
  seq += 1;
  await handleIncomingWhatsAppMessage({ ...base, id: `${name}-1`, body: trigger, hasUserSignal: true }, storage, transport, 'webhook');
  assert.ok(sent.includes('send the photo'), `${name}: the waiting step must be sent first`);
  assert.ok(!sent.includes('thanks, you are in'), `${name}: the next step must wait for the reply`);
  seq += 1;
  await handleIncomingWhatsAppMessage({ ...base, id: `${name}-2`, ...reply }, storage, transport, 'webhook');
  const advanced = sent.includes('thanks, you are in');
  conversationState.remove(from);
  return advanced;
}

(async () => {
  const storage = new Storage(path.join(directory, 'storage.json'));
  try {
    assert.equal(await scenario(storage, 'image', 'wait_reply', { body: '', hasUserSignal: true, media: { kind: 'image', mimeType: 'image/jpeg' } }), true, 'a caption-less image must advance a wait_reply step');
    assert.equal(await scenario(storage, 'video', 'wait_reply', { body: '', hasUserSignal: true, media: { kind: 'video', mimeType: 'video/mp4' } }), true, 'a caption-less video must advance');
    assert.equal(await scenario(storage, 'document', 'wait_reply', { body: '', hasUserSignal: true, media: { kind: 'document' } }), true, 'a caption-less document must advance');
    assert.equal(await scenario(storage, 'text', 'wait_reply', { body: 'table', hasUserSignal: true }), true, 'a text reply still advances');
    assert.equal(await scenario(storage, 'audio', 'wait_reply', { body: '', hasUserSignal: true, media: { kind: 'audio' } }), false, 'a voice message is still ignored');
    assert.equal(await scenario(storage, 'sticker', 'wait_reply', { body: '', hasUserSignal: true, media: { kind: 'sticker' } }), false, 'a sticker is still ignored');
    assert.equal(await scenario(storage, 'email', 'email_capture', { body: '', hasUserSignal: true, media: { kind: 'image' } }), false, 'an email_capture step must not be advanced by media');
    console.log('Wait-reply media tests passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
