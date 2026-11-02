#!/usr/bin/env node
'use strict';
/**
 * Generates the two MASTER key rings for signed reply buttons and writes them to a file (never to the terminal):
 *
 *   node scripts/button-keys-generate-masters.js [--out <path>] [--kid k1]
 *
 * Output (default <home>/flowsbiz-secrets/button-master-keys.env, outside the repository), two lines:
 *   META_BUTTON_ROUTE_MASTER_KEYS=<kid>:<32 random bytes, base64url>
 *   META_BUTTON_FULL_MASTER_KEYS=<kid>:<32 random bytes, base64url>
 * They go into the environment of the ADMIN service (Dokploy). Every client key is derived from them (src/buttonKeys.ts), so:
 *   - this must run ONCE: it refuses to overwrite an existing file (new random rings would invalidate every key already handed out);
 *   - a rotation adds a second kid next to the first (do not replace it);
 *   - the file holds secrets: keep it out of git and delete the copy once the values are in Dokploy.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const kid = arg('kid') || 'k1';
if (!/^[A-Za-z0-9_-]{1,8}$/.test(kid)) { console.error('--kid must be 1-8 characters of [A-Za-z0-9_-]'); process.exit(2); }
const out = path.resolve(arg('out') || path.join(os.homedir(), 'flowsbiz-secrets', 'button-master-keys.env'));
const repoRoot = path.resolve(__dirname, '..');
if (out.startsWith(repoRoot + path.sep)) { console.error('Refusing to write secrets inside the repository.'); process.exit(2); }

fs.mkdirSync(path.dirname(out), { recursive: true });
const key = () => crypto.randomBytes(32).toString('base64url');
const text = `META_BUTTON_ROUTE_MASTER_KEYS=${kid}:${key()}\nMETA_BUTTON_FULL_MASTER_KEYS=${kid}:${key()}\n`;
try {
  fs.writeFileSync(out, text, { flag: 'wx', mode: 0o600 });
} catch (err) {
  if (err.code === 'EEXIST') { console.error(`Already exists: ${out}\nNot overwriting (new rings would invalidate every key already handed out).`); process.exit(3); }
  throw err;
}
console.log(`Wrote the two master rings (kid ${kid}) to ${out}. Values are not printed here.`);
