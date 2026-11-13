'use strict';
/** contactCardSendMode 'vcf': several contacts go out as ONE .vcf file (one tap saves them all); fallback to native cards if the file fails. */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
const META = process.argv.includes('--meta');
if (META) process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-mode-'));
process.env.UPLOADS_PATH = path.join(dir, 'uploads');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');

class Transport {
  constructor(failFile) { this.sent = []; this.failFile = failFile; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ type: 'text', text }); return { messageId: 'm' + this.sent.length }; }
  async sendFile(to, filePath, caption) {
    if (this.failFile) { const e = new Error('unsupported media type'); e.status = 400; throw e; }
    this.sent.push({ type: 'file', name: path.basename(filePath), body: fs.readFileSync(filePath, 'utf8') });
    return { messageId: 'f' + this.sent.length };
  }
  async sendContactCard(to, vcard, name) { this.sent.push({ type: 'card', name }); return { messageId: 'c' + this.sent.length }; }
  async sendContactCards(to, contacts) { this.sent.push({ type: 'cards', names: contacts.map((c) => c.displayName) }); return { messageId: 'cs' + this.sent.length }; }
}
let seq = 0;
async function run(storage, mode, failFile, cards, phone) {
  const trigger = 'vcf-' + (seq++);
  storage.addCampaign({ name: trigger, triggerType: 1, triggerPhrase: trigger, suffix: '', active: true,
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: 'hello', followupMessages: [],
      sendContactCard: true, contactCardSendMode: mode, contactCardPlacement: 'after_completion', contactCards: cards } });
  const tr = new Transport(failFile);
  await handleIncomingWhatsAppMessage({ id: 'v' + seq, from: 'whatsapp:' + phone, body: trigger, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'P'; } }, storage, tr, 'webhook');
  conversationState.remove('whatsapp:' + phone);
  return tr;
}
(async () => {
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    const two = [{ enabled: true, name: 'Dana', phone: '0501234567' }, { enabled: true, name: 'Eli', phone: '0527654321', email: 'e@x.co' }];
    if (META) {
      const m = await run(storage, 'vcf', false, two, '972500000041');
      assert.strictEqual(m.sent.filter((x) => x.type === 'file').length, 0, 'Meta: no .vcf file (Meta cannot deliver it)');
      assert.strictEqual(m.sent.filter((x) => x.type === 'cards').length, 1, 'Meta: one combined native card instead');
      console.log('Contact cards VCF mode (Meta) tests passed.');
      return;
    }
    let tr = await run(storage, 'vcf', false, two, '972500000031');
    const files = tr.sent.filter((x) => x.type === 'file');
    assert.strictEqual(files.length, 1, 'one vcf file');
    assert.ok(files[0].name.endsWith('.vcf'));
    assert.strictEqual((files[0].body.match(/BEGIN:VCARD/g) || []).length, 2, 'both contacts in the file');
    assert.ok(files[0].body.includes('FN:Dana') && files[0].body.includes('FN:Eli'));
    assert.strictEqual(tr.sent.filter((x) => x.type === 'card' || x.type === 'cards').length, 0, 'no native cards when the file works');

    tr = await run(storage, 'vcf', true, two, '972500000032');
    assert.strictEqual(tr.sent.filter((x) => x.type === 'file').length, 0);
    assert.strictEqual(tr.sent.filter((x) => x.type === 'cards').length, 1, 'file failed -> one combined native card');

    tr = await run(storage, 'vcf', false, [two[0]], '972500000033');
    assert.strictEqual(tr.sent.filter((x) => x.type === 'file').length, 0, 'a single contact is not sent as a file');
    assert.strictEqual(tr.sent.filter((x) => x.type === 'card').length, 1);

    tr = await run(storage, 'separate', false, two, '972500000034');
    assert.strictEqual(tr.sent.filter((x) => x.type === 'file').length, 0, 'separate mode unchanged');
    assert.strictEqual(tr.sent.filter((x) => x.type === 'card').length, 2);
    console.log('Contact cards VCF mode tests passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exit(1); });
