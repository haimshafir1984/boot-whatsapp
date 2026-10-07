'use strict';

/**
 * A campaign step that carries an AUDIO clip plus text (e.g. "listen and guess the song").
 *
 * WhatsApp has no caption on an audio message: Meta accepts the send and silently ignores the
 * text. So passing the step's text as the clip's caption loses it with no error anywhere - the
 * client sees a saved step, the participant just never gets the words. sendDecisionFile() now
 * sends that text as its own message immediately BEFORE the clip instead.
 *
 * What this asserts, in order:
 *   1. the text is actually sent (the regression: it used to vanish),
 *   2. it is sent BEFORE the clip - the order a quiz needs,
 *   3. the clip itself carries no caption,
 *   4. the text is not sent twice,
 *   5. an IMAGE still gets its caption the old way - the fix must not change that.
 */

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.FILE_DELIVERY_WAIT_TIMEOUT_MS = '2000';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-step-caption-'));
process.env.UPLOADS_PATH = path.join(directory, 'uploads');
fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
fs.writeFileSync(path.join(process.env.UPLOADS_PATH, 'clip.m4a'), 'fake audio bytes');
fs.writeFileSync(path.join(process.env.UPLOADS_PATH, 'photo.jpg'), 'fake image bytes');

const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

const QUIZ_TEXT = 'תקשיבו לקטע ונחשו את השיר';

class FakeTransport {
  constructor(messageId) { this.sent = []; this.messageId = messageId; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ type: 'text', to, text, at: Date.now() }); }
  async sendFile(to, filePath, caption) {
    this.sent.push({ type: 'file', to, filePath, caption, at: Date.now() });
    return { messageId: this.messageId };
  }
}

function addCampaign(storage, name, fileId) {
  return storage.addCampaign({
    name,
    triggerType: 1,
    triggerPhrase: name,
    suffix: '',
    active: true,
    conversation: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      askNameText: '',
      replyText: '',
      followupMessages: [],
      decisionFlow: [
        { id: 'media-step', kind: 'message', text: QUIZ_TEXT, fileId, nextStepId: 'after-step' },
        { id: 'after-step', kind: 'message', text: 'נעבור לשאלה' },
      ],
    },
  });
}

let inboundSequence = 0;
async function inbound(storage, transport, phone, body) {
  inboundSequence += 1;
  await handleIncomingWhatsAppMessage({
    id: `audio-caption-${inboundSequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Audio caption test'; },
  }, storage, transport, 'webhook');
}

/** Confirm delivery as soon as the file is handed to the transport, so the wait is not the subject here. */
function autoConfirm(storage, transport, messageId) {
  return setInterval(() => {
    if (transport.sent.some((item) => item.type === 'file')) storage.recordOutboxDelivery(messageId, 'delivered');
  }, 25);
}

const phoneAudio = '972500000401';
const phoneImage = '972500000402';

(async () => {
  const storage = new Storage(path.join(directory, 'storage.json'));
  try {
    // ---------------------------------------------------------------- audio: text becomes its own message
    const audioFile = storage.addUploadedFile({ originalName: 'clip.m4a', filename: 'clip.m4a', mimeType: 'audio/mp4', size: 17 });
    addCampaign(storage, 'audio-quiz', audioFile.id);
    const audioTransport = new FakeTransport('wamid.fake-audio-1');
    const audioTimer = autoConfirm(storage, audioTransport, 'wamid.fake-audio-1');
    await inbound(storage, audioTransport, phoneAudio, 'audio-quiz');
    clearInterval(audioTimer);

    const clipIndex = audioTransport.sent.findIndex((item) => item.type === 'file');
    const quizTextIndices = audioTransport.sent
      .map((item, index) => (item.type === 'text' && item.text.trim() === QUIZ_TEXT ? index : -1))
      .filter((index) => index >= 0);

    assert.ok(clipIndex >= 0, 'the audio clip must have been sent');
    assert.equal(quizTextIndices.length, 1, `the step text must be sent exactly once, got ${quizTextIndices.length} copies`);
    assert.ok(
      quizTextIndices[0] < clipIndex,
      'the step text must be sent BEFORE the clip - a quiz instruction after the audio is the wrong order',
    );
    assert.equal(
      audioTransport.sent[clipIndex].caption,
      undefined,
      'the clip must carry no caption: WhatsApp drops it, which is the whole bug',
    );
    assert.ok(
      audioTransport.sent.some((item) => item.type === 'text' && item.text.includes('נעבור לשאלה')),
      'the flow must continue to the next step',
    );
    console.log(`PASS  audio step: text sent once, before the clip, and the clip has no caption (${audioTransport.sent.length} sends).`);

    // ---------------------------------------------------------------- image: unchanged, caption stays on the media
    const imageFile = storage.addUploadedFile({ originalName: 'photo.jpg', filename: 'photo.jpg', mimeType: 'image/jpeg', size: 17 });
    addCampaign(storage, 'image-step', imageFile.id);
    const imageTransport = new FakeTransport('wamid.fake-image-1');
    const imageTimer = autoConfirm(storage, imageTransport, 'wamid.fake-image-1');
    await inbound(storage, imageTransport, phoneImage, 'image-step');
    clearInterval(imageTimer);

    const imageIndex = imageTransport.sent.findIndex((item) => item.type === 'file');
    assert.ok(imageIndex >= 0, 'the image must have been sent');
    assert.equal(
      imageTransport.sent[imageIndex].caption,
      QUIZ_TEXT,
      'an image must still carry its caption - the audio fix must not change the image path',
    );
    assert.ok(
      !imageTransport.sent.some((item) => item.type === 'text' && item.text.trim() === QUIZ_TEXT),
      'the image caption must NOT also be sent as a separate message',
    );
    console.log('PASS  image step: caption still rides on the media, and is not duplicated as text.');

    console.log('\naudio-step-caption: 2 passed, 0 failed');
  } finally {
    conversationState.remove(`whatsapp:${phoneAudio}`);
    conversationState.remove(`whatsapp:${phoneImage}`);
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
