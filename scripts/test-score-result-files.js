'use strict';
/** A score_result step can send a different image per rule AND one for the fallback (tie / no match). */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
class Transport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ type: 'text', to, text }); return { messageId: 'm' + this.sent.length }; }
  async sendInteractiveButtons(to, text, buttons) { this.sent.push({ type: 'buttons', to, text }); return { messageId: 'b' + this.sent.length }; }
  async sendFile(to, filePath, caption, options) { this.sent.push({ type: 'file', to, file: path.basename(String(filePath)), caption, sticker: Boolean(options && options.asSticker) }); return { messageId: 'f' + this.sent.length }; }
}
let seq = 0;
async function inbound(storage, transport, phone, body, isButtonReply = false) {
  seq += 1;
  await handleIncomingWhatsAppMessage({ id: 'sr-' + seq, from: 'whatsapp:' + phone, body, isButtonReply, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'P'; } }, storage, transport, 'webhook');
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-files-'));
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    const a = storage.addUploadedFile({ originalName: 'a.png', filename: 'a.png', mimeType: 'image/png', size: 1 });
    const b = storage.addUploadedFile({ originalName: 'b.png', filename: 'b.png', mimeType: 'image/png', size: 1 });
    const t = storage.addUploadedFile({ originalName: 'tie.png', filename: 'tie.png', mimeType: 'image/png', size: 1 });
    const q = (id, next) => ({ id, kind: 'score_question', presentation: 'buttons', text: id, options: [{ id: id + '1', text: id + ' One', score: 1, nextStepId: next }, { id: id + '2', text: id + ' Two', score: 2, nextStepId: next }] });
    storage.addCampaign({ name: 'Score files', triggerType: 1, triggerPhrase: 'score-files', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [
      q('q1', 'q2'), q('q2', 'result'),
      { id: 'result', kind: 'score_result', text: 'Calculating', resultRules: [
        { id: 'r1', type: 'majority', value: 1, endText: 'You are A', fileId: a.id },
        { id: 'r2', type: 'majority', value: 2, endText: 'You are B', fileId: b.id },
      ], fallbackText: 'A tie', fallbackFileId: t.id },
    ] } });
    const files = (tr, phone) => tr.sent.filter((x) => x.type === 'file' && x.to === 'whatsapp:' + phone);
    async function run(phone, n1, n2) {
      const tr = new Transport();
      await inbound(storage, tr, phone, 'score-files');
      await inbound(storage, tr, phone, 'q1 ' + n1, true);
      await inbound(storage, tr, phone, 'q2 ' + n2, true);
      conversationState.remove('whatsapp:' + phone);
      return tr;
    }
    let tr = await run('972500000011', 'One', 'One');
    assert.strictEqual(files(tr, '972500000011').length, 1, 'rule A sends exactly one file');
    const fa = files(tr, '972500000011')[0];
    tr = await run('972500000012', 'Two', 'Two');
    const fb = files(tr, '972500000012')[0];
    assert.notStrictEqual(fa.file, fb.file, 'different rules send different files');
    tr = await run('972500000013', 'One', 'Two');
    const ft = files(tr, '972500000013');
    assert.strictEqual(ft.length, 1, 'tie sends the fallback file');
    assert.notStrictEqual(ft[0].file, fa.file);
    assert.notStrictEqual(ft[0].file, fb.file);
    assert.strictEqual(ft[0].caption, 'A tie');
    console.log('Score-result files test passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exit(1); });
