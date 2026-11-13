'use strict';
/** Meta: a .vcf file is sent as a document BY LINK (upload of text/vcard is rejected by Meta, text/plain gets renamed .vcf.txt). */
process.env.NODE_ENV = 'test';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_PHONE_NUMBER_ID = '123456';
process.env.META_APP_SECRET = 'secret';
process.env.META_VERIFY_TOKEN = 'verify';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-vcf-'));
process.env.UPLOADS_PATH = path.join(dir, 'uploads');
process.env.PUBLIC_BASE_URL = 'https://client.example.test';

const calls = [];
global.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init && init.body });
  return { ok: true, status: 200, headers: { get: () => null }, async json() { return { messages: [{ id: 'wamid.TEST' }], id: 'media-1' }; }, async text() { return '{}'; } };
};
const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');

(async () => {
  try {
    const provider = new MetaCloudProvider();
    const folder = path.join(dir, 'x');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'Dana, Eli.vcf');
    fs.writeFileSync(file, 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dana\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Eli\r\nEND:VCARD\r\n', 'utf8');

    await provider.sendFile('972500000001', file);
    assert.ok(!calls.some((c) => /\/media$/.test(c.url)), 'no media upload for a .vcf');
    const msg = calls.find((c) => /\/messages$/.test(c.url));
    assert.ok(msg, 'a message was posted');
    const body = JSON.parse(msg.body);
    assert.strictEqual(body.type, 'document');
    assert.ok(/^https:\/\/client\.example\.test\/vcf\/[A-Za-z0-9_-]{22}\.vcf$/.test(body.document.link), body.document.link);
    assert.strictEqual(body.document.filename, 'Dana, Eli.vcf');
    assert.ok(!('id' in body.document));

    // the link serves the same content
    const vcf = require('../dist/vcfLink');
    const content = vcf.readVcfLink(body.document.link.split('/vcf/')[1]);
    assert.strictEqual((content.match(/BEGIN:VCARD/g) || []).length, 2);

    // without PUBLIC_BASE_URL a .vcf is rejected locally (no upload attempt that Meta would refuse and alert about)
    delete process.env.PUBLIC_BASE_URL;
    calls.length = 0;
    await assert.rejects(() => provider.sendFile('972500000001', file), /PUBLIC_BASE_URL/);
    assert.strictEqual(calls.length, 0);
    console.log('Meta VCF document-by-link test passed.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exit(1); });
