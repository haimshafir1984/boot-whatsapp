const fs = require('fs');
const path = require('path');

const target = path.join(
  process.cwd(),
  'node_modules',
  '@whiskeysockets',
  'baileys',
  'lib',
  'Socket',
  'messages-recv.js',
);

if (!fs.existsSync(target)) {
  console.warn('Baileys pre-login ACK patch skipped: installed file was not found.');
  process.exit(0);
}

const source = fs.readFileSync(target, 'utf8');
const original = 'buildAckStanza(node, errorCode, authState.creds.me.id)';
const patched = 'buildAckStanza(node, errorCode, authState.creds.me?.id)';

if (source.includes(patched)) {
  console.log('Baileys pre-login ACK patch already present.');
  process.exit(0);
}

if (!source.includes(original)) {
  console.warn('Baileys pre-login ACK patch skipped: upstream implementation has changed.');
  process.exit(0);
}

fs.writeFileSync(target, source.replace(original, patched), 'utf8');
console.log('Applied Baileys pre-login ACK patch.');
