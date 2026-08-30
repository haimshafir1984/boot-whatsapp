'use strict';

/**
 * Meta Cloud API supports showing the typing dots by including a typing
 * indicator together with the read receipt for the inbound message.
 */

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.META_PHONE_NUMBER_ID = '1234567890';
process.env.META_GRAPH_API_VERSION = 'v23.0';

const assert = require('node:assert/strict');

const calls = [];
global.fetch = async (url, init = {}) => {
  calls.push({ url, init });
  return {
    ok: true,
    async json() { return { success: true }; },
  };
};

const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');

(async () => {
  const provider = new MetaCloudProvider();
  await provider.showTypingIndicator({ id: 'wamid.inbound-1', from: 'whatsapp:972500000502', body: 'היי' });

  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.status, 'read');
  assert.equal(payload.message_id, 'wamid.inbound-1');
  assert.deepEqual(payload.typing_indicator, { type: 'text' });

  console.log('Meta typing indicator payload test passed.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
