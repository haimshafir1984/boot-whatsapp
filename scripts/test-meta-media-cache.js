'use strict';

process.env.NODE_ENV = 'test';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_PHONE_NUMBER_ID = 'test-phone-id';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-media-cache-'));
const filePath = path.join(directory, 'campaign-video.mp4');
fs.writeFileSync(filePath, Buffer.from('test-video'));

const originalFetch = global.fetch;
let uploads = 0;
let sends = 0;
global.fetch = async (url) => {
  const value = String(url);
  if (value.endsWith('/media')) {
    uploads += 1;
    return new Response(JSON.stringify({ id: 'media-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (value.endsWith('/messages')) {
    sends += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sends}` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected Meta URL: ${value}`);
};

(async () => {
  try {
    const first = new MetaCloudProvider();
    const second = new MetaCloudProvider();
    await Promise.all([
      first.sendFile('972500000001', filePath, 'First'),
      second.sendFile('972500000002', filePath, 'Second'),
    ]);
    await new MetaCloudProvider().sendFile('972500000003', filePath, 'Third');
    assert.equal(uploads, 1, 'concurrent and later sends of the same file should share one Meta upload');
    assert.equal(sends, 3, 'each recipient must still receive its own message');
    console.log('Meta media cache tests passed.');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
