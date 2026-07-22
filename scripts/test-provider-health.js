const assert = require('assert');

process.env.WHATSAPP_PROVIDER = 'META_CLOUD_API';
process.env.META_ACCESS_TOKEN = 'qa-access-token';
process.env.META_PHONE_NUMBER_ID = 'qa-phone-id';
process.env.META_VERIFY_TOKEN = 'qa-verify-token';
process.env.META_DISPLAY_PHONE_NUMBER = '972500000000';

const { getWhatsAppHealth } = require('../dist/adminServer');

const health = getWhatsAppHealth('972511111111');
assert.strictEqual(health.ready, true);
assert.strictEqual(health.authenticated, true);
assert.strictEqual(health.lifecycle, 'running');
assert.strictEqual(health.requestedProvider, 'META_CLOUD_API');
assert.strictEqual(health.actualProvider, 'META_CLOUD_API');
assert.strictEqual(health.connectedPhone, '972500000000');
assert.strictEqual(health.listeningReason, 'meta webhook mode');
assert.strictEqual(health.notReadySince, null);

console.log('Provider health regression test passed.');
