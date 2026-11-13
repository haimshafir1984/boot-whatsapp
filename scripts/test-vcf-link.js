'use strict';
/** vcf_link mode: one link to a .vcf served from the client's public domain (Meta cannot deliver a .vcf document). */
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-link-'));
process.env.UPLOADS_PATH = path.join(dir, 'uploads');
process.env.PUBLIC_BASE_URL = 'https://client.example.test/';
const express = require('express');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const vcf = require('../dist/vcfLink');

class Transport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ type: 'text', text }); return { messageId: 'm' + this.sent.length }; }
  async sendFile() { this.sent.push({ type: 'file' }); return { messageId: 'f' }; }
  async sendContactCard(to, v, name) { this.sent.push({ type: 'card', name }); return { messageId: 'c' + this.sent.length }; }
  async sendContactCards(to, contacts) { this.sent.push({ type: 'cards', names: contacts.map((c) => c.displayName) }); return { messageId: 'cs' + this.sent.length }; }
}
let seq = 0;
async function run(storage, trigger, cards, phone, mode = 'vcf_link') {
  const name = trigger + '-' + (seq++);
  storage.addCampaign({ name, triggerType: 1, triggerPhrase: name, suffix: '', active: true,
    conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: 'hello', followupMessages: [],
      sendContactCard: true, contactCardSendMode: mode, contactCardPlacement: 'after_completion', contactCards: cards } });
  const tr = new Transport();
  await handleIncomingWhatsAppMessage({ id: 'l' + seq, from: 'whatsapp:' + phone, body: name, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'P'; } }, storage, tr, 'webhook');
  conversationState.remove('whatsapp:' + phone);
  return tr;
}
const urlOf = (tr) => (tr.sent.map((x) => x.text || '').join('\n').match(/https:\/\/client\.example\.test\/vcf\/[A-Za-z0-9_-]{22}\.vcf/) || [])[0];
function get(port, p) {
  return new Promise((resolve, reject) => http.get({ port, path: p }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject));
}
(async () => {
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    const two = [{ enabled: true, name: 'דנה', phone: '0501234567' }, { enabled: true, name: 'Eli', phone: '0527654321', email: 'e@x.co' }];

    // 1. one text with the link, no file and no native card
    const a = await run(storage, 'link-a', two, '972500000051');
    const urlA = urlOf(a);
    assert.ok(urlA, 'a link is sent: ' + JSON.stringify(a.sent));
    assert.strictEqual(a.sent.filter((x) => x.type === 'file' || x.type === 'card' || x.type === 'cards').length, 0);

    // 2. file content: both contacts, Hebrew intact, CRLF
    const fileName = urlA.split('/vcf/')[1];
    const content = vcf.readVcfLink(fileName);
    assert.strictEqual((content.match(/BEGIN:VCARD/g) || []).length, 2);
    assert.ok(content.includes('FN:דנה') && content.includes('FN:Eli') && content.includes('\r\n'));

    // 3. unknown / malformed / traversal ids rejected
    assert.strictEqual(vcf.readVcfLink('x'.repeat(22) + '.vcf'), null);
    assert.strictEqual(vcf.readVcfLink('../../etc/passwd'), null);
    assert.strictEqual(vcf.readVcfLink(fileName.replace('.vcf', '.txt')), null);

    // 4. a second participant of the same campaign gets the SAME link and no extra file
    const campaign = storage.getCampaigns().find((c) => c.name.startsWith('link-a-'));
    const base = fs.readdirSync(path.join(process.env.UPLOADS_PATH, 'vcf-links')).filter((f) => f.endsWith('.vcf')).length;
    const tr2 = new Transport();
    await handleIncomingWhatsAppMessage({ id: 'l-b', from: 'whatsapp:972500000056', body: campaign.name, hasUserSignal: true, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'Q'; } }, storage, tr2, 'webhook');
    conversationState.remove('whatsapp:972500000056');
    assert.strictEqual(urlOf(tr2), urlA, 'same contact set + same campaign => same link');
    assert.strictEqual(fs.readdirSync(path.join(process.env.UPLOADS_PATH, 'vcf-links')).filter((f) => f.endsWith('.vcf')).length, base, 'no extra file');

    // 5. changed contacts => a NEW link; the old one still serves the OLD contacts
    const changed = two.map((c, i) => (i === 0 ? { ...c, phone: '0509999999' } : c));
    const b = await run(storage, 'link-a', changed, '972500000052');
    assert.ok(urlOf(b) && urlOf(b) !== urlA);
    assert.ok(vcf.readVcfLink(fileName).includes('FN:דנה'), 'old link unchanged');

    // 6. HTTP route: headers, 404, no auth needed
    const app = express();
    vcf.mountVcfLinkRoutes(app);
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const port = server.address().port;
    const ok = await get(port, '/vcf/' + fileName);
    assert.strictEqual(ok.status, 200);
    assert.ok(/^text\/vcard/.test(ok.headers['content-type']));
    assert.strictEqual(ok.headers['referrer-policy'], 'no-referrer');
    assert.ok(/noindex/.test(ok.headers['x-robots-tag']));
    assert.strictEqual((ok.body.match(/BEGIN:VCARD/g) || []).length, 2);
    assert.strictEqual((await get(port, '/vcf/' + 'y'.repeat(22) + '.vcf')).status, 404);
    assert.strictEqual((await get(port, '/vcf/not-a-file')).status, 404);
    server.close();

    // 7. expiry: an old file is not served
    const old = new Date(Date.now() - vcf.VCF_LINK_MAX_AGE_MS - 60000);
    fs.utimesSync(path.join(process.env.UPLOADS_PATH, 'vcf-links', fileName), old, old);
    assert.strictEqual(vcf.readVcfLink(fileName), null, 'expired link');

    // 8. single contact keeps the native card; separate mode unchanged
    const s1 = await run(storage, 'link-b', [two[0]], '972500000053');
    assert.strictEqual(s1.sent.filter((x) => x.type === 'card').length, 1);
    assert.ok(!urlOf(s1));
    const s2 = await run(storage, 'link-c', two, '972500000054', 'separate');
    assert.strictEqual(s2.sent.filter((x) => x.type === 'card').length, 2);

    // 9. no PUBLIC_BASE_URL => falls back to the combined native card (Meta)
    delete process.env.PUBLIC_BASE_URL;
    const f = await run(storage, 'link-d', two, '972500000055');
    assert.ok(!urlOf(f));
    assert.strictEqual(f.sent.filter((x) => x.type === 'cards').length, 1, 'fallback combined card');
    console.log('VCF link tests passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exit(1); });
