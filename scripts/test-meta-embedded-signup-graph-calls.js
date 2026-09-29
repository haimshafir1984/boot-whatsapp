'use strict';

// embedded-signup-automation-plan-2026-09-28, stage 7 step 3: unit-level coverage
// of the Graph API calls and connect-link helpers in src/metaEmbeddedSignup.ts,
// against the real compiled module with a global.fetch stub (same convention as
// scripts/test-dokploy-provisioner-postgres.js).

const assert = require('node:assert/strict');
const {
  generateConnectLinkToken,
  hashConnectLinkToken,
  validateConnectLinkToken,
  META_CONNECT_LINK_TTL_MS,
  exchangeMetaEmbeddedSignupCode,
  verifyMetaEmbeddedSignupToken,
  discoverMetaDedicatedPhoneNumberId,
  getMetaPhoneNumberDetails,
  subscribeMetaWabaApp,
  syncMetaSmbAppData,
  MetaEmbeddedSignupError,
} = require('../dist/metaEmbeddedSignup');

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function main() {
  // ── connect link token / hashing ──────────────────────────────────────────
  const { token, hash } = generateConnectLinkToken();
  assert.equal(hash, hashConnectLinkToken(token), 'the stored hash must be reproducible from the raw token');
  assert.notEqual(token, hash, 'the raw token and its hash must never be the same string');

  const now = Date.now();
  assert.deepEqual(
    validateConnectLinkToken({ metaConnectLinkTokenHash: hash, metaConnectLinkExpiresAt: new Date(now + 1000).toISOString() }, hash, now),
    { ok: true },
  );
  assert.deepEqual(
    validateConnectLinkToken({ metaConnectLinkTokenHash: hash, metaConnectLinkExpiresAt: new Date(now + 1000).toISOString() }, 'wrong-hash', now),
    { ok: false, reason: 'not_found' },
  );
  assert.deepEqual(
    validateConnectLinkToken({ metaConnectLinkTokenHash: hash, metaConnectLinkExpiresAt: new Date(now - 1000).toISOString() }, hash, now),
    { ok: false, reason: 'expired' },
  );
  assert.deepEqual(
    validateConnectLinkToken({ metaConnectLinkTokenHash: hash, metaConnectLinkExpiresAt: new Date(now + 1000).toISOString(), metaConnectLinkUsedAt: new Date(now - 1000).toISOString() }, hash, now),
    { ok: false, reason: 'used' },
  );
  assert.deepEqual(validateConnectLinkToken({}, hash, now), { ok: false, reason: 'not_found' }, 'a client with no link at all must reject every token, not throw');
  assert.equal(META_CONNECT_LINK_TTL_MS, 7 * 24 * 60 * 60 * 1000, 'section 3.1: the link is valid for 7 days');
  console.log('  connect-link token helpers - 6 assertions passed');

  // ── exchangeMetaEmbeddedSignupCode ────────────────────────────────────────
  {
    let lastUrl;
    global.fetch = async (url) => { lastUrl = String(url); return json({ access_token: 'issued-token-abc' }); };
    const result = await exchangeMetaEmbeddedSignupCode({ graphApiVersion: 'v23.0', appId: 'app-1', appSecret: 'secret-1', code: 'one-time-code' });
    assert.equal(result.accessToken, 'issued-token-abc');
    assert.match(lastUrl, /\/v23\.0\/oauth\/access_token\?client_id=app-1&client_secret=secret-1&code=one-time-code/);

    global.fetch = async () => json({ error: { message: 'invalid or expired code' } }, 400);
    await assert.rejects(
      exchangeMetaEmbeddedSignupCode({ graphApiVersion: 'v23.0', appId: 'app-1', appSecret: 'secret-1', code: 'bad' }),
      (err) => err instanceof MetaEmbeddedSignupError && /invalid or expired code/.test(err.message),
    );

    global.fetch = async () => json({});
    await assert.rejects(
      exchangeMetaEmbeddedSignupCode({ graphApiVersion: 'v23.0', appId: 'app-1', appSecret: 'secret-1', code: 'bad' }),
      /לא החזירה access_token/,
      'a 200 with no access_token must still be treated as a failure, not a silently empty token',
    );
    console.log('  exchangeMetaEmbeddedSignupCode - 3 cases passed');
  }

  // ── verifyMetaEmbeddedSignupToken (debug_token) ───────────────────────────
  {
    global.fetch = async () => json({
      data: { is_valid: true, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-123'] }] },
    });
    await verifyMetaEmbeddedSignupToken({ graphApiVersion: 'v23.0', appId: 'app-1', appSecret: 'secret-1', accessToken: 'tok', wabaId: 'waba-123' });

    global.fetch = async () => json({
      data: { is_valid: true, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['some-other-waba'] }] },
    });
    await assert.rejects(
      verifyMetaEmbeddedSignupToken({ graphApiVersion: 'v23.0', appId: 'app-1', appSecret: 'secret-1', accessToken: 'tok', wabaId: 'waba-123' }),
      /אינו מכסה/,
      'a token that does not cover the reported wabaId must be rejected - never trust the browser-supplied id alone',
    );

    global.fetch = async () => json({ data: { is_valid: true, scopes: ['whatsapp_business_management'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-123'] }] } });
    await assert.rejects(
      verifyMetaEmbeddedSignupToken({ graphApiVersion: 'v23.0', appId: 'app-1', appSecret: 'secret-1', accessToken: 'tok', wabaId: 'waba-123' }),
      /whatsapp_business_messaging/,
      'a missing required scope must be rejected',
    );

    global.fetch = async () => json({ data: { is_valid: false } });
    await assert.rejects(verifyMetaEmbeddedSignupToken({ graphApiVersion: 'v23.0', appId: 'app-1', appSecret: 'secret-1', accessToken: 'tok', wabaId: 'waba-123' }), /אינו תקף/);
    console.log('  verifyMetaEmbeddedSignupToken - 4 cases passed');
  }

  // ── discoverMetaDedicatedPhoneNumberId ────────────────────────────────────
  {
    global.fetch = async () => json({ data: [{ id: 'phone-1' }] });
    assert.equal(await discoverMetaDedicatedPhoneNumberId({ graphApiVersion: 'v23.0', wabaId: 'waba-1', accessToken: 'tok' }), 'phone-1');

    global.fetch = async () => json({ data: [] });
    await assert.rejects(discoverMetaDedicatedPhoneNumberId({ graphApiVersion: 'v23.0', wabaId: 'waba-1', accessToken: 'tok' }), /לא נמצא אף מספר/);

    global.fetch = async () => json({ data: [{ id: 'phone-1' }, { id: 'phone-2' }] });
    await assert.rejects(
      discoverMetaDedicatedPhoneNumberId({ graphApiVersion: 'v23.0', wabaId: 'waba-1', accessToken: 'tok' }),
      /יותר ממספר טלפון אחד/,
      'embedded-signup-coexistence-event-contract-finding-2026-09-29.md: more than one number under the WABA must stop with an error, never guess',
    );
    console.log('  discoverMetaDedicatedPhoneNumberId - 3 cases passed (0 / 1 / 2+ numbers)');
  }

  // ── getMetaPhoneNumberDetails ──────────────────────────────────────────────
  {
    global.fetch = async () => json({ display_phone_number: '+972 52-9771003', verified_name: 'עסק לדוגמה', quality_rating: 'GREEN', code_verification_status: 'VERIFIED' });
    const details = await getMetaPhoneNumberDetails({ graphApiVersion: 'v23.0', phoneNumberId: 'phone-1', accessToken: 'tok' });
    assert.equal(details.displayPhoneNumber, '972529771003', 'the display number must be normalized to digits only');
    assert.equal(details.qualityRating, 'GREEN');

    global.fetch = async () => json({});
    await assert.rejects(getMetaPhoneNumberDetails({ graphApiVersion: 'v23.0', phoneNumberId: 'phone-1', accessToken: 'tok' }), /לא החזירה מספר תצוגה/);
    console.log('  getMetaPhoneNumberDetails - 2 cases passed');
  }

  // ── subscribeMetaWabaApp / syncMetaSmbAppData ─────────────────────────────
  {
    let calledUrl;
    global.fetch = async (url) => { calledUrl = String(url); return json({ success: true }); };
    await subscribeMetaWabaApp({ graphApiVersion: 'v23.0', wabaId: 'waba-1', accessToken: 'tok' });
    assert.match(calledUrl, /\/v23\.0\/waba-1\/subscribed_apps$/);

    let sentBody;
    global.fetch = async (url, init) => { sentBody = JSON.parse(init.body); return json({ success: true }); };
    await syncMetaSmbAppData({ graphApiVersion: 'v23.0', phoneNumberId: 'phone-1', accessToken: 'tok', syncType: 'history' });
    assert.deepEqual(sentBody, { messaging_product: 'whatsapp', sync_type: 'history' });

    global.fetch = async () => json({ error: { message: 'temporarily unavailable' } }, 503);
    await assert.rejects(syncMetaSmbAppData({ graphApiVersion: 'v23.0', phoneNumberId: 'phone-1', accessToken: 'tok', syncType: 'smb_app_state_sync' }), /temporarily unavailable/);
    console.log('  subscribeMetaWabaApp / syncMetaSmbAppData - 3 cases passed');
  }

  // ── secrets never leak into thrown error messages ─────────────────────────
  {
    global.fetch = async () => json({ error: { message: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345 failed' } }, 401);
    try {
      await subscribeMetaWabaApp({ graphApiVersion: 'v23.0', wabaId: 'waba-1', accessToken: 'tok' });
      assert.fail('expected a rejection');
    } catch (err) {
      assert.ok(!err.message.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), `redactSecrets must scrub tokens out of Graph error messages, got: ${err.message}`);
    }
    console.log('  Graph error messages are redacted before reaching the caller');
  }

  console.log('Embedded Signup Graph-call unit tests passed.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
