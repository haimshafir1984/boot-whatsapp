'use strict';
/**
 * Signed button ids (src/buttonToken.ts): round trip, every field covered by BOTH signatures, purpose separation, strict parsing
 * (canonical encodings only, one accepted spelling per token), length limit as a hard error, expiry, key derivation, and a seeded fuzz
 * that must never throw and never accept a spelling other than the issued one.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const T = require('../dist/buttonToken');

const results = [];
function scenario(name, fn) {
  try { fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

const master = crypto.createHash('sha256').update('master-route-key-for-tests').digest();
const fullKey = crypto.createHash('sha256').update('client-full-key-for-tests').digest();
const routeKey = T.deriveRouteKey(master, 'c02484f2');
const keys = { routeKey, fullKey };
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const claims = (over = {}) => ({ kid: 'k1', clientId: 'c02484f2', resultId: 'mvtdgtab8bcy', stepId: 'step-mvng8b45-7lv1', optionId: 'option-mvng8b47-t6va', rev: 'a1b2c3d4', exp: Math.floor(NOW / 1000) + 86400, ...over });
const issue = (over) => T.issueButtonId(claims(over), keys);
const verifyAll = (id, k = keys) => { const p = T.parseButtonId(id); return p.ok && T.verifyAllSignatures(p.parsed, k); };

scenario('round trip: claims come back identical and both signatures verify', () => {
  const id = issue();
  const p = T.parseButtonId(id);
  assert.equal(p.ok, true);
  assert.deepEqual(p.parsed.claims, claims());
  assert.equal(T.verifyRouteSignature(p.parsed, routeKey), true);
  assert.equal(T.verifyFullSignature(p.parsed, fullKey), true);
  assert.equal(T.isV1ButtonId(id), true);
});

scenario('a production-sized id stays well under the limit (and the limit is a hard error)', () => {
  const id = issue();
  console.log(`      production-like id length: ${id.length} (limit ${T.BUTTON_ID_MAX_LENGTH})`);
  assert.ok(id.length < T.BUTTON_ID_MAX_LENGTH - 20, `length ${id.length}`);
  assert.throws(() => issue({ stepId: 'S'.repeat(100) }), (e) => e instanceof T.ButtonTokenError && e.reason === 'too_long');
  assert.throws(() => issue({ optionId: 'x'.repeat(129) }), (e) => e.reason === 'bad_field');
});

scenario('every claim is covered by BOTH signatures: changing any single field is detected by the gateway check and the client check', () => {
  const parts = issue().split('.');
  const b = (v) => Buffer.from(v, 'utf8').toString('base64url');
  const swaps = {
    1: 'k2', 2: b('c11111111'), 3: b('otherresult'), 4: b('step-other'), 5: b('option-other'), 6: b('ffffffff'), 7: (parseInt(parts[7], 36) + 1).toString(36),
  };
  for (const [i, replacement] of Object.entries(swaps)) {
    const forged = parts.slice(); forged[i] = replacement;
    const id = forged.join('.');
    const p = T.parseButtonId(id);
    assert.equal(p.ok, true, `field ${i} still parses`);
    assert.equal(T.verifyRouteSignature(p.parsed, routeKey), false, `gateway check, field ${i}`);
    assert.equal(T.verifyFullSignature(p.parsed, fullKey), false, `client check, field ${i}`);
  }
});

scenario('purpose separation and key separation: one signature cannot stand in for the other, other keys do not verify', () => {
  const parts = issue().split('.');
  const swapped = parts.slice(); swapped[8] = parts[9]; swapped[9] = parts[8];
  const p = T.parseButtonId(swapped.join('.'));
  assert.equal(p.ok, true);
  assert.equal(T.verifyRouteSignature(p.parsed, routeKey), false);
  assert.equal(T.verifyFullSignature(p.parsed, fullKey), false);
  const id = issue();
  assert.equal(verifyAll(id, { routeKey: T.deriveRouteKey(master, 'other-client'), fullKey }), false, 'another client route key');
  assert.equal(verifyAll(id, { routeKey, fullKey: crypto.randomBytes(32) }), false, 'another full key');
  assert.equal(verifyAll(id, { routeKey: crypto.randomBytes(32), fullKey }), false, 'another route key');
  assert.notDeepEqual(T.deriveRouteKey(master, 'a'), T.deriveRouteKey(master, 'b'));
  assert.notDeepEqual(T.deriveRouteKey(master, 'a'), T.deriveRouteKey(crypto.randomBytes(32), 'a'));
});

scenario('values with dots, newlines, separators, Hebrew and emoji round-trip, and field boundaries cannot be shifted (length-prefixed content)', () => {
  const tricky = claims({ stepId: 'a.b\nc|d:1', optionId: 'שלום🩷', resultId: '1:2|3' });
  const id = T.issueButtonId(tricky, keys);
  const p = T.parseButtonId(id);
  assert.equal(p.ok, true);
  assert.deepEqual(p.parsed.claims, tricky);
  assert.equal(verifyAll(id), true);
  const x = claims({ stepId: 'ab', optionId: 'c' }); const y = claims({ stepId: 'a', optionId: 'bc' });
  assert.notDeepEqual(T.canonicalButtonContent('route/v1', x), T.canonicalButtonContent('route/v1', y));
  const px = T.parseButtonId(T.issueButtonId(x, keys)); const py = T.parseButtonId(T.issueButtonId(y, keys));
  assert.notDeepEqual(px.parsed.routeSig, py.parsed.routeSig);
  assert.notDeepEqual(T.canonicalButtonContent('route/v1', x), T.canonicalButtonContent('full/v1', x), 'purpose is part of the content');
});

scenario('malformed input is rejected with a reason and never throws', () => {
  const good = issue(); const parts = good.split('.');
  const cases = [
    [undefined, 'not_v1'], [null, 'not_v1'], [42, 'not_v1'], ['', 'not_v1'], ['option-abc', 'not_v1'], ['v1', 'not_v1'], ['V1.' + parts.slice(1).join('.'), 'not_v1'],
    ['v1.', 'malformed'], [good + '.extra', 'malformed'], [parts.slice(0, 9).join('.'), 'malformed'],
    [[parts[0], 'toolongkid1', ...parts.slice(2)].join('.'), 'bad_kid'], [[parts[0], 'k 1', ...parts.slice(2)].join('.'), 'bad_kid'], [[parts[0], '', ...parts.slice(2)].join('.'), 'bad_kid'],
    [[...parts.slice(0, 2), '', ...parts.slice(3)].join('.'), 'bad_field'],
    [[...parts.slice(0, 3), 'a+b/c', ...parts.slice(4)].join('.'), 'bad_field'],
    [[...parts.slice(0, 4), 'YQ==', ...parts.slice(5)].join('.'), 'bad_field'],
    [[...parts.slice(0, 5), '_w', ...parts.slice(6)].join('.'), 'bad_field'],                     // 0xff: invalid UTF-8
    [[...parts.slice(0, 7), 'ZZZ', ...parts.slice(8)].join('.'), 'bad_exp'],
    [[...parts.slice(0, 7), '0' + parts[7], ...parts.slice(8)].join('.'), 'bad_exp'],
    [[...parts.slice(0, 7), '-5', ...parts.slice(8)].join('.'), 'bad_exp'],
    [[...parts.slice(0, 7), '0', ...parts.slice(8)].join('.'), 'bad_exp'],
    [[...parts.slice(0, 8), parts[8].slice(0, 21), parts[9]].join('.'), 'malformed'],
    [[...parts.slice(0, 8), parts[8], parts[9] + 'A'].join('.'), 'malformed'],
    ['v1.' + 'a.'.repeat(300), 'too_long'],
  ];
  for (const [input, reason] of cases) {
    const r = T.parseButtonId(input);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(String(input).slice(0, 60))}`);
    assert.equal(r.reason, reason, `${JSON.stringify(String(input).slice(0, 60))} -> ${r.reason}`);
  }
  assert.equal(T.isV1ButtonId('v1.garbage'), true, 'anything that claims v1 is v1 - it never falls back to the legacy path');
  assert.equal(T.isV1ButtonId('v10.x'), false);
  assert.equal(T.isV1ButtonId('option-v1.x'), false);
});

scenario('one accepted spelling per token: a signature or field spelled differently for the same bytes is rejected, and nothing but the issued token verifies', () => {
  const id = issue(); const parts = id.split('.');
  const original = T.parseButtonId(id).parsed;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const index of [8, 9]) {                       // the last char of a 22-char base64url has 4 unused bits: 16 spellings of each 2-bit value
    let sameBytes = 0; let parsed = 0; let verified = 0;
    for (const ch of alphabet) {
      const variant = parts.slice(); variant[index] = parts[index].slice(0, 21) + ch;
      const r = T.parseButtonId(variant.join('.'));
      if (!r.ok) continue;
      parsed += 1;
      const field = index === 8 ? 'routeSig' : 'sig';
      if (r.parsed[field].equals(original[field])) sameBytes += 1;
      if (T.verifyAllSignatures(r.parsed, keys)) verified += 1;
    }
    assert.equal(parsed, 4, `slot ${index}: only the 4 canonical spellings (one per data-bit value) parse, the 12 padded-bit variants do not`);
    assert.equal(sameBytes, 1, `slot ${index}: exactly one spelling carries the real signature bytes`);
    assert.equal(verified, 1, `slot ${index}: only the issued token verifies`);
  }
  const variant = parts.slice(); variant[7] = parts[7].toUpperCase();
  assert.equal(T.parseButtonId(variant.join('.')).ok, parts[7] === parts[7].toUpperCase(), 'uppercase exp is not accepted');
});

scenario('expiry: hard 24h from the send time, checked on the verifier clock with a small skew allowance', () => {
  const c = claims({ exp: 1_000_000 });
  assert.equal(T.isExpired(c, 1_000_000 * 1000), false);
  assert.equal(T.isExpired(c, 1_000_000 * 1000 + 60_000), false, 'inside the skew allowance');
  assert.equal(T.isExpired(c, 1_000_000 * 1000 + 60_001), true);
  assert.equal(T.isExpired(c, 1_000_000 * 1000 - 5 * 3600_000), false);
  assert.equal(T.isExpired(c, 1_000_000 * 1000 + 30_000, 0), true, 'no skew');
});

scenario('seeded fuzz: parse never throws; the only accepted spelling of a valid token is the issued one; a mutated token never verifies', () => {
  let seed = 123456789;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ \nא🩷';
  const base = [issue(), issue({ stepId: 'step-x', optionId: 'opt-y' }), T.issueButtonId(claims({ resultId: '1:2|3', optionId: 'שלום' }), keys)];
  let accepted = 0;
  for (let i = 0; i < 20000; i += 1) {
    const original = base[i % base.length];
    let s = original;
    const edits = 1 + Math.floor(rnd() * 3);
    for (let e = 0; e < edits; e += 1) {
      const pos = Math.floor(rnd() * (s.length + 1)); const kind = Math.floor(rnd() * 5);
      const ch = [...alphabet][Math.floor(rnd() * [...alphabet].length)];
      if (kind === 0) s = s.slice(0, pos) + ch + s.slice(pos);
      else if (kind === 1) s = s.slice(0, pos) + s.slice(pos + 1);
      else if (kind === 2) s = s.slice(0, pos) + ch + s.slice(pos + 1);
      else if (kind === 3) s = s.slice(0, pos);
      else { const q = Math.floor(rnd() * s.length); const arr = [...s]; [arr[pos % arr.length], arr[q]] = [arr[q], arr[pos % arr.length]]; s = arr.join(''); }
    }
    let r;
    assert.doesNotThrow(() => { r = T.parseButtonId(s); });
    if (r.ok) {
      accepted += 1;
      if (s !== original) assert.equal(T.verifyAllSignatures(r.parsed, keys), false, `a modified token verified: ${s}`);
    }
  }
  console.log(`      fuzz: 20000 mutations, ${accepted} still parsed structurally (all of them failed verification unless unchanged)`);
});

let failed = 0;
for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nButton token tests passed (${results.length} scenarios).`);
process.exit(failed ? 1 : 0);
