'use strict';

/**
 * Regression test for the file-delivery-ordering fix: on Meta Cloud API, Meta
 * accepting a media send call means "queued", not "already visible to the
 * recipient" - a heavy file can still be transcoding server-side while a
 * later, lighter text sails through and arrives first. sendFileWithRetry now
 * waits for the actual delivery webhook (storage.recordOutboxDelivery) before
 * letting the flow continue to its next step, bounded by a timeout so a
 * missing/slow webhook can never stall the conversation forever.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.FILE_DELIVERY_WAIT_TIMEOUT_MS = '2000';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'file-delivery-order-'));
process.env.UPLOADS_PATH = path.join(directory, 'uploads');
fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
fs.writeFileSync(path.join(process.env.UPLOADS_PATH, 'video.mp4'), 'fake video bytes');

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

class FakeTransport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ type: 'text', to, text, at: Date.now() }); }
  async sendFile(to, filePath, caption) {
    this.sent.push({ type: 'file', to, filePath, caption, at: Date.now() });
    return { messageId: 'wamid.fake-video-1' };
  }
}

function addCampaign(storage, uploadedFileId) {
  return storage.addCampaign({
    name: 'video-share',
    triggerType: 1,
    triggerPhrase: 'video-share',
    suffix: '',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      decisionFlow: [
        { id: 'video-step', kind: 'message', text: '', fileId: uploadedFileId, nextStepId: 'congrats-step' },
        { id: 'congrats-step', kind: 'message', text: '👏👏 יש לכם את זה!' },
      ],
    },
  });
}

function addCampaign2(storage, uploadedFileId) {
  return storage.addCampaign({
    name: 'video-share-2',
    triggerType: 1,
    triggerPhrase: 'video-share-2',
    suffix: '',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      decisionFlow: [
        { id: 'video-step', kind: 'message', text: '', fileId: uploadedFileId, nextStepId: 'congrats-step' },
        { id: 'congrats-step', kind: 'message', text: '👏👏 יש לכם את זה!' },
      ],
    },
  });
}

let inboundSequence = 0;
async function inbound(storage, transport, phone, body) {
  inboundSequence += 1;
  await handleIncomingWhatsAppMessage({
    id: `delivery-order-${inboundSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Delivery order test'; },
  }, storage, transport, 'webhook');
}

(async () => {
  const storage = new Storage(path.join(directory, 'storage.json'));
  const transport = new FakeTransport();
  const phone = '972500000301';
  try {
    const uploaded = storage.addUploadedFile({ originalName: 'video.mp4', filename: 'video.mp4', mimeType: 'video/mp4', size: 17 });
    addCampaign(storage, uploaded.id);

    // Simulate the delivery webhook arriving 150ms after the send call - the
    // flow must actually be blocked waiting on it, not just coincidentally slow.
    // FakeTransport.sendFile always returns this fixed providerMessageId.
    let deliveredAt = 0;
    const deliveryTimer = setTimeout(() => {
      storage.recordOutboxDelivery('wamid.fake-video-1', 'delivered');
      deliveredAt = Date.now();
    }, 150);

    const t0 = Date.now();
    await inbound(storage, transport, phone, 'video-share');
    const elapsedMs = Date.now() - t0;
    clearTimeout(deliveryTimer);

    const fileIndex = transport.sent.findIndex((item) => item.type === 'file');
    const textIndex = transport.sent.findIndex((item) => item.type === 'text' && item.text.includes('יש לכם את זה'));
    assert.ok(fileIndex >= 0, 'the video must have been sent');
    assert.ok(textIndex >= 0, 'the congrats text must have been sent');
    assert.ok(fileIndex < textIndex, 'the video must be submitted before the congrats text, matching the visible order');

    assert.ok(deliveredAt > 0, 'the delivery webhook simulation must have fired');
    assert.ok(transport.sent[textIndex].at >= deliveredAt, 'the congrats text must not be sent before the file was confirmed delivered');
    assert.ok(elapsedMs < 2000, `should unblock as soon as the delivery webhook arrives (~150ms), not wait out the full ${process.env.FILE_DELIVERY_WAIT_TIMEOUT_MS}ms timeout - took ${elapsedMs}ms`);

    console.log(`File-delivery ordering test passed (unblocked in ${elapsedMs}ms after a 150ms delivery webhook, well under the ${process.env.FILE_DELIVERY_WAIT_TIMEOUT_MS}ms timeout).`);

    // Second scenario: the delivery webhook never arrives at all (e.g. lost,
    // or Meta never sends one for some edge case). The flow must still
    // complete - falling back to today's pre-fix ordering for that one file -
    // rather than stalling the conversation forever.
    const phone2 = '972500000302';
    const uploaded2 = storage.addUploadedFile({ originalName: 'video2.mp4', filename: 'video.mp4', mimeType: 'video/mp4', size: 17 });
    addCampaign2(storage, uploaded2.id);
    const transport2 = new FakeTransport();
    const t1 = Date.now();
    await inbound(storage, transport2, phone2, 'video-share-2');
    const elapsedMs2 = Date.now() - t1;
    const timeoutMs = Number(process.env.FILE_DELIVERY_WAIT_TIMEOUT_MS);
    assert.ok(elapsedMs2 >= timeoutMs, `with no delivery webhook ever arriving, it must wait out the full timeout (${timeoutMs}ms) rather than skip the wait, took ${elapsedMs2}ms`);
    assert.ok(elapsedMs2 < timeoutMs + 2000, `must not hang past a bounded slack over the timeout, took ${elapsedMs2}ms`);
    assert.ok(
      transport2.sent.some((item) => item.type === 'text' && item.text.includes('יש לכם את זה')),
      'the flow must still complete and send the next step even without a delivery confirmation',
    );
    conversationState.remove(`whatsapp:${phone2}`);
    console.log(`File-delivery timeout-fallback test passed (completed after ${elapsedMs2}ms with no delivery webhook, never hung).`);
  } finally {
    conversationState.remove(`whatsapp:${phone}`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
