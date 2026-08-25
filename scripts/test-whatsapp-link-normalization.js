'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const publicNormalizeFn = extractFunction(html, 'normalizeSharePhone');
const publicFormatFn = extractFunction(html, 'formatWaMePhone');
const publicSandbox = {};
Function('sandbox', `${publicNormalizeFn}\n${publicFormatFn}\nsandbox.normalizeSharePhone = normalizeSharePhone; sandbox.formatWaMePhone = formatWaMePhone;`)(publicSandbox);

assert.equal(publicSandbox.formatWaMePhone('972529771002'), '972529771002');
assert.equal(publicSandbox.formatWaMePhone('0529771002'), '972529771002');
assert.equal(publicSandbox.formatWaMePhone('529771002'), '972529771002');
assert.equal(publicSandbox.formatWaMePhone('+1 (202) 555-0123'), '12025550123');

const adminSource = fs.readFileSync(path.join(__dirname, '..', 'dist', 'adminServer.js'), 'utf8');
const adminNormalizeFn = extractFunction(adminSource, 'normalizeSharePhone');
const adminSandbox = {};
Function('sandbox', `${adminNormalizeFn}\nsandbox.normalizeSharePhone = normalizeSharePhone;`)(adminSandbox);

assert.equal(adminSandbox.normalizeSharePhone('whatsapp:+972529771002'), '972529771002');
assert.equal(adminSandbox.normalizeSharePhone('0529771002'), '972529771002');
assert.equal(adminSandbox.normalizeSharePhone('529771002'), '972529771002');
assert.equal(adminSandbox.normalizeSharePhone('+1 (202) 555-0123'), '12025550123');

const messageFlowSource = fs.readFileSync(path.join(__dirname, '..', 'dist', 'messageFlow.js'), 'utf8');
const handoffNormalizeFn = extractFunction(messageFlowSource, 'normalizeHumanHandoffPhone');
const handoffSandbox = {};
Function('sandbox', `${handoffNormalizeFn}\nsandbox.normalizeHumanHandoffPhone = normalizeHumanHandoffPhone;`)(handoffSandbox);

assert.equal(handoffSandbox.normalizeHumanHandoffPhone('972529771002'), '972529771002');
assert.equal(handoffSandbox.normalizeHumanHandoffPhone('0529771002'), '972529771002');
assert.equal(handoffSandbox.normalizeHumanHandoffPhone('529771002'), '972529771002');
assert.equal(handoffSandbox.normalizeHumanHandoffPhone('+1 (202) 555-0123'), '12025550123');

console.log('WhatsApp link normalization tests passed.');
