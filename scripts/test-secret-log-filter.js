'use strict';
// Signal session key material must never reach the logs. Drives the REAL libsignal SessionRecord code (the actual source of
// "Closing session: SessionEntry {...privKey, rootKey...}" in production Baileys logs) with the real process console, and checks
// what is actually written to stdout/stderr.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const filterPath = path.resolve(__dirname, '..', 'dist', 'secretLogFilter');
const secret = 'e840f171854f2d31bd02c31b2998daf6ed3ba5cca6fbc6e3223adeafade33760';

function run(install) {
  const code = `
    ${install ? `require(${JSON.stringify(filterPath)}).installSecretLogFilter();` : ''}
    const { SessionRecord } = require('libsignal');
    const record = new SessionRecord();
    const entry = SessionRecord.createEntry();
    entry.registrationId = 11972;
    entry.currentRatchet = { ephemeralKeyPair: { pubKey: Buffer.alloc(33, 5), privKey: Buffer.from('${secret}', 'hex') }, rootKey: Buffer.from('${secret}', 'hex'), previousCounter: 0 };
    entry.indexInfo = { baseKey: Buffer.alloc(33, 7), baseKeyType: 2, closed: -1, used: 1, created: 1, remoteIdentityKey: Buffer.alloc(33, 9) };
    record.setSession(entry);
    record.closeSession(entry);          // "Closing session:"
    record.closeSession(entry);          // "Session already closed"
    record.openSession(entry);           // "Opening session:"
    console.log('ordinary object stays', { campaign: 'x', count: 3 });
    console.error(new Error('ordinary error stays'));
  `;
  const out = spawnSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout + out.stderr;
}

// Sanity: without the filter, libsignal really does print the private key (so the test proves something).
const unfiltered = run(false);
assert.ok(unfiltered.includes('privKey') && /e8 40 f1 71/.test(unfiltered), 'precondition: libsignal leaks key bytes when unfiltered');

const filtered = run(true);
assert.ok(!filtered.includes('privKey') && !filtered.includes('rootKey') && !/e8 40 f1 71/.test(filtered), 'no key material in logs');
assert.equal((filtered.match(/\[signal session redacted\]/g) || []).length, 3, 'each session dump is replaced, the event stays visible');
assert.ok(filtered.includes('Closing session:') && filtered.includes('Opening session:') && filtered.includes('Session already closed'));
assert.ok(filtered.includes("campaign: 'x'") && filtered.includes('ordinary error stays'), 'ordinary objects and errors are untouched');
console.log('secret-log-filter tests passed.');
