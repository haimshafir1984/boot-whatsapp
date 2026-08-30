'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runCase(provider, expected, extraCode = '') {
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { Storage } = require('./dist/storage');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contacts-provider-default-'));
    try {
      ${extraCode || `
      const storage = new Storage(path.join(dir, 'storage.json'));
      assert.equal(storage.getAdminSettings().contactsProvider, ${JSON.stringify(expected)});
      `}
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, WHATSAPP_PROVIDER: provider },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Case ${provider} failed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

runCase('META_CLOUD_API', 'manual');
runCase('TWILIO_API', 'manual');
runCase('BAILEYS', 'google');

runCase('META_CLOUD_API', 'google', `
  const file = path.join(dir, 'storage.json');
  fs.writeFileSync(file, JSON.stringify({ adminSettings: { contactsProvider: 'google' } }), 'utf8');
  const storage = new Storage(file);
  assert.equal(storage.getAdminSettings().contactsProvider, 'google');
`);

console.log('Contacts provider defaults test passed.');
