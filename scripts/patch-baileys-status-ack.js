'use strict';
/**
 * Baileys patch: acknowledge <status> stanzas (upstream issue https://github.com/WhiskeySockets/Baileys/issues/2858, PR #2866 / #2883 not merged).
 *
 * Why: WhatsApp closes the stream about 50 minutes after connect ("Stream Errored (ack)", status 500, ack class=status) when a <status> stanza
 * is never acknowledged. Confirmed on production 9.11.2026 (abytl-tna: 17:19:09 and 18:09:21 UTC, 50 minutes apart,
 * `[BAILEYS_DISCONNECT] status=500 message="Stream Errored (ack)" node=ack class=status type=media`).
 *
 * What: three small insertions in lib/Socket/messages-recv.js
 *   1. handleStatusAck: sends the ack with the library's own sendMessageAck (ack only: the stanza is not decoded, no message event).
 *   2. ['status', handleStatusAck] in the offline node processor map, so a <status> flagged offline="true" (redelivered after a reconnect)
 *      is acknowledged too, in order, through the same queue the other stanza types use.
 *   3. ws.on('CB:status') -> processNode('status', ...), which also acks (once) an ignored JID on its fast path.
 *
 * Unlike scripts/patch-baileys-prelogin-ack.js this script is STRICT: it exits non-zero (failing `npm ci` / the Docker build) when the installed
 * library is not the locked version, when an anchor is missing, or when the file is half patched. A silently unpatched library would bring the
 * 50-minute disconnects back without anyone noticing. If a future upstream release handles <status> natively, the script accepts it (exit 0)
 * but only for the locked version bump to be done deliberately: update LOCKED_VERSION after re-reading the new source.
 *
 * Test hook: BAILEYS_PATCH_BASE_DIR points the script at another copy of the package (used by scripts/test-baileys-status-ack-patch.js).
 */
const fs = require('fs');
const path = require('path');

const LOCKED_VERSION = '7.0.0-rc14';
const baseDir = process.env.BAILEYS_PATCH_BASE_DIR || path.join(process.cwd(), 'node_modules', '@whiskeysockets', 'baileys');
const target = path.join(baseDir, 'lib', 'Socket', 'messages-recv.js');

const MARK_HANDLER = 'const handleStatusAck = async (node) => {';
const MARK_MAP = "['status', handleStatusAck]";
// Our own listener line, not just "ws.on('CB:status'": an upstream release that adds its own CB:status handler must not look like ours.
const MARK_LISTENER = "processNode('status', node, 'handling status', handleStatusAck)";

const MAP_ANCHOR = "        ['notification', handleNotification]\n    ]), {";
const MAP_PATCHED = "        ['notification', handleNotification],\n        ['status', handleStatusAck]\n    ]), {";

const HANDLER_ANCHOR = '    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([\n';
const HANDLER_CODE = [
  '    // FlowsBiz patch (Baileys issue #2858): WhatsApp closes the stream ("Stream Errored (ack)", status 500) about 50 minutes after connect',
  '    // when a <status> stanza is never acknowledged. Acknowledge it: ack only, the stanza is not decoded and produces no message event.',
  '    const handleStatusAck = async (node) => {',
  "        await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack status'));",
  '    };',
  '',
].join('\n');

const LISTENER_ANCHOR = [
  "    ws.on('CB:notification', async (node) => {",
  "        await processNode('notification', node, 'handling notification', handleNotification);",
  '    });',
  '',
].join('\n');
const LISTENER_CODE = [
  "    ws.on('CB:status', async (node) => {",
  "        await processNode('status', node, 'handling status', handleStatusAck);",
  '    });',
  '',
].join('\n');

function fail(message) {
  console.error(`Baileys status-ack patch FAILED: ${message}`);
  process.exit(1);
}
const count = (text, needle) => text.split(needle).length - 1;

if (!fs.existsSync(target)) fail(`installed file not found: ${target}`);
let version = '';
try { version = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8')).version; } catch (err) { fail(`cannot read the library version (${err.message})`); }

const source = fs.readFileSync(target, 'utf8');
if (source.includes('\r\n')) fail('unexpected CRLF line endings in messages-recv.js');

const marks = { handler: count(source, MARK_HANDLER), map: count(source, MARK_MAP), listener: count(source, MARK_LISTENER) };
const present = Object.values(marks).filter((n) => n > 0).length;

if (marks.handler === 1 && marks.map === 1 && marks.listener === 1) {
  console.log(`Baileys status-ack patch already present (library ${version}).`);
  process.exit(0);
}
if (present > 0) fail(`the file is partly patched or has duplicates (handler=${marks.handler}, map=${marks.map}, listener=${marks.listener}); reinstall the package`);

// Nothing of ours is present. An upstream release that handles <status> itself needs no patch (and a second ack would be wrong).
if (/CB:status/.test(source)) {
  console.log(`Baileys ${version} already handles <status> natively; the status-ack patch is not needed.`);
  process.exit(0);
}
if (version !== LOCKED_VERSION) fail(`installed Baileys is ${version}, this patch is locked to ${LOCKED_VERSION}. Re-read lib/Socket/messages-recv.js in the new version, then update LOCKED_VERSION (or drop the patch if it handles <status>).`);

for (const [name, anchor] of [['offline map', MAP_ANCHOR], ['offline processor', HANDLER_ANCHOR], ['notification listener', LISTENER_ANCHOR]]) {
  const n = count(source, anchor);
  if (n !== 1) fail(`anchor "${name}" found ${n} times (expected exactly 1); upstream changed`);
}

let patched = source
  .replace(MAP_ANCHOR, MAP_PATCHED)
  .replace(HANDLER_ANCHOR, HANDLER_CODE + HANDLER_ANCHOR)
  .replace(LISTENER_ANCHOR, LISTENER_ANCHOR + LISTENER_CODE);

const after = { handler: count(patched, MARK_HANDLER), map: count(patched, MARK_MAP), listener: count(patched, MARK_LISTENER) };
if (after.handler !== 1 || after.map !== 1 || after.listener !== 1) fail(`verification after patching failed (${JSON.stringify(after)}); nothing was written`);

fs.writeFileSync(target, patched, 'utf8');
console.log(`Applied Baileys status-ack patch (library ${version}).`);
