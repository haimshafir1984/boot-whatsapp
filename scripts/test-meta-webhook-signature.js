/**
 * test-meta-webhook-signature.js
 * Covers docs/safety-speed-deploy-plan-2026-09-02.md B.1 (step 1 of the safety plan):
 * X-Hub-Signature-256 verification on POST /webhooks/meta/whatsapp.
 *
 * Two layers:
 *  1. isValidMetaSignature() pure-function cases (incl. large Hebrew unicode body).
 *  2. The real createMetaSignatureVerifier() middleware, mounted the same way
 *     adminServer.ts mounts it (global express.json verify callback capturing
 *     rawBody), driven over a real HTTP socket, asserting status codes AND that
 *     the downstream handler (stand-in for enqueue) runs only when it should.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const {
  isValidMetaSignature,
  createMetaSignatureVerifier,
} = require('../dist/metaWebhookSignature');

const SECRET = 'test_app_secret_5f3a1c';

function sign(rawBody, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// A realistic inbound-message webhook body with Hebrew trigger text and enough
// bulk that it is not a trivial "{}" — mirrors what the gateway logs show.
const realBodyObj = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: '106540352242922' },
            contacts: [{ profile: { name: 'דנה כהן' }, wa_id: '972541234567' }],
            messages: [
              {
                from: '972541234567',
                id: 'wamid.HBgLOTcyNTQxMjM0NTY3FQIAEhgUM0Ew:' + 'x'.repeat(40),
                timestamp: '1725270000',
                type: 'text',
                text: { body: 'אני רוצה להצטרף הגעתי דרך דנה ' + 'שלום '.repeat(50) },
              },
            ],
          },
        },
      ],
    },
  ],
};
const realBody = Buffer.from(JSON.stringify(realBodyObj), 'utf-8');

// ── Layer 1: pure function ────────────────────────────────────────────────────
(function pureCases() {
  assert.equal(isValidMetaSignature(realBody, sign(realBody), SECRET), true, 'valid signature over real body');
  assert.equal(
    isValidMetaSignature(realBody, sign(realBody, 'wrong_secret'), SECRET),
    false,
    'signature computed with a different secret is rejected',
  );
  assert.equal(isValidMetaSignature(realBody, 'sha256=deadbeef', SECRET), false, 'garbage signature rejected (length mismatch path)');
  assert.equal(
    isValidMetaSignature(realBody, 'sha256=' + '0'.repeat(64), SECRET),
    false,
    'well-formed but wrong signature rejected (timingSafeEqual path)',
  );
  assert.equal(isValidMetaSignature(realBody, '', SECRET), false, 'missing signature header rejected');
  assert.equal(isValidMetaSignature(realBody, undefined, SECRET), false, 'undefined signature header rejected');
  assert.equal(isValidMetaSignature(realBody, sign(realBody), ''), false, 'empty secret cannot verify');

  // Tamper one byte of the body -> signature must fail.
  const tampered = Buffer.from(realBody);
  tampered[tampered.length - 5] ^= 0x01;
  assert.equal(isValidMetaSignature(tampered, sign(realBody), SECRET), false, 'body tampering invalidates signature');

  // Large (~600KB) Hebrew unicode body round-trips.
  const bigObj = { object: 'whatsapp_business_account', note: 'שלום עולם '.repeat(60000) };
  const bigBody = Buffer.from(JSON.stringify(bigObj), 'utf-8');
  assert.ok(bigBody.length > 500_000, 'big body is actually big: ' + bigBody.length + ' bytes');
  assert.equal(isValidMetaSignature(bigBody, sign(bigBody), SECRET), true, 'valid signature over large Hebrew body');
  console.log('  layer 1 (isValidMetaSignature) — 10 assertions passed; big body =', bigBody.length, 'bytes');
})();

// ── Layer 2: real middleware over HTTP ────────────────────────────────────────
function buildApp(getSecret) {
  const app = express();
  app.use(express.json({
    limit: '24mb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));
  const verifyMetaSignature = createMetaSignatureVerifier(getSecret);
  const state = { handlerHits: 0, lastBody: null };
  app.post('/webhooks/meta/whatsapp', verifyMetaSignature, (req, res) => {
    // Stand-in for the enqueue path — records that it ran and what it saw.
    state.handlerHits += 1;
    state.lastBody = req.body;
    res.sendStatus(200);
  });
  return { app, state };
}

function request(server, { body, headers }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/webhooks/meta/whatsapp', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function layer2() {
  // --- secret configured ---
  {
    const { app, state } = buildApp(() => SECRET);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const good = await request(server, { body: realBody, headers: { 'x-hub-signature-256': sign(realBody) } });
      assert.equal(good.status, 200, 'valid signature -> 200');
      assert.equal(state.handlerHits, 1, 'valid signature reaches the handler (enqueue stand-in)');
      assert.ok(state.lastBody && state.lastBody.object === 'whatsapp_business_account', 'handler received the parsed body');

      const bad = await request(server, { body: realBody, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
      assert.equal(bad.status, 403, 'wrong signature -> 403');
      assert.equal(state.handlerHits, 1, 'wrong signature does NOT reach the handler (no side effect)');

      const missing = await request(server, { body: realBody, headers: {} });
      assert.equal(missing.status, 403, 'missing signature -> 403');
      assert.equal(state.handlerHits, 1, 'missing signature does NOT reach the handler');

      const wrongSecretSig = await request(server, { body: realBody, headers: { 'x-hub-signature-256': sign(realBody, 'attacker_secret') } });
      assert.equal(wrongSecretSig.status, 403, 'signature from a different secret -> 403');
      assert.equal(state.handlerHits, 1, 'still no extra handler hits');

      console.log('  layer 2a (secret set) — 403 on bad/missing, 200 + enqueue on valid');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // --- secret NOT configured: do not block ---
  {
    const { app, state } = buildApp(() => '');
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const noSig = await request(server, { body: realBody, headers: {} });
      assert.equal(noSig.status, 200, 'no secret configured -> request passes through even with no signature');
      assert.equal(state.handlerHits, 1, 'no secret configured -> handler runs');
      console.log('  layer 2b (secret unset) — request passes through unverified, handler runs');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
}

layer2()
  .then(() => console.log('Meta webhook signature tests passed.'))
  .catch((err) => { console.error(err); process.exit(1); });
