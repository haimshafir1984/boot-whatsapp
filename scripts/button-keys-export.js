#!/usr/bin/env node
'use strict';
/**
 * Exports the signed-button environment variables of EXISTING clients (new clients get them from the provisioner automatically).
 *
 *   META_BUTTON_ROUTE_MASTER_KEYS="k1:..." META_BUTTON_FULL_MASTER_KEYS="k1:..." \
 *     node scripts/button-keys-export.js [--owner data/owner/clients.json] [--out path] [--clients id1,id2]
 *
 * Writes, per Meta Cloud API client, the three lines to paste into that client's Dokploy environment:
 *   META_BUTTON_CLIENT_ID, META_BUTTON_ROUTE_KEYS, META_BUTTON_FULL_KEYS
 * The values are the same every time (derived from the master rings), so running it again changes nothing.
 * THE OUTPUT FILE CONTAINS SECRETS: it goes to the OS temp folder by default, is never printed to the terminal, and must not be committed.
 * It does not turn issuing on: META_BUTTON_V1_ISSUE is a separate step after /owner/api/button-v1/readiness says ready.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clientButtonEnv } = require('../dist/buttonKeys');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ownerPath = path.resolve(arg('owner') || process.env.OWNER_STORAGE_PATH || './data/owner/clients.json');
const only = new Set(String(arg('clients') || '').split(',').map((x) => x.trim()).filter(Boolean));
const routeMaster = process.env.META_BUTTON_ROUTE_MASTER_KEYS;
const fullMaster = process.env.META_BUTTON_FULL_MASTER_KEYS;

if (!routeMaster || !fullMaster) { console.error('Both META_BUTTON_ROUTE_MASTER_KEYS and META_BUTTON_FULL_MASTER_KEYS must be set in the environment of this command.'); process.exit(2); }
if (!fs.existsSync(ownerPath)) { console.error(`Owner storage not found: ${ownerPath}`); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
const clients = (Array.isArray(raw) ? raw : raw.clients || []).filter((client) => client && client.whatsappProvider === 'META_CLOUD_API' && (!only.size || only.has(client.id)));
if (!clients.length) { console.error('No Meta Cloud API clients matched.'); process.exit(2); }

const out = path.resolve(arg('out') || path.join(os.tmpdir(), `button-keys-${new Date().toISOString().slice(0, 10)}.env`));
const lines = ['# Signed reply buttons: per-client environment. CONTAINS SECRETS - do not commit, delete after use.'];
let written = 0;
for (const client of clients) {
  const env = clientButtonEnv(client.id, routeMaster, fullMaster);
  if (!env) { console.error(`Skipped ${client.id}: the two master rings have no kid in common.`); continue; }
  lines.push('', `# ${client.name || client.id}  (${client.id})`);
  for (const [key, value] of Object.entries(env)) lines.push(`${key}=${JSON.stringify(value)}`);
  written += 1;
}
fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
console.log(`Wrote ${written} client(s) to ${out} (secrets inside; not printed here).`);
