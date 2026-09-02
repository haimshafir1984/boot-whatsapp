/**
 * test-conversation-state-atomic-write.js
 * Covers step 5 (B.3) of docs/safety-speed-deploy-plan-2026-09-02.md:
 * atomic temp+rename+.bak write for conversation-state.json IN JSON MODE ONLY,
 * plus .bak fallback on restore. The Postgres-mode write path must be unchanged.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-atomic-'));
const sched = () => setTimeout(() => {}, 60_000).unref();
const handoff = (jid) => ({ kind: 'handoff', senderJid: jid, timestamp: Date.now() });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

try {
  // ── Phase 1: JSON mode -> atomic write, previous good copy kept as .bak ──
  {
    const convPath = path.join(dir, 'p1.json');
    const storage = new Storage(path.join(dir, 'p1-contacts.json')); // JSON mode, no DB backend
    assert.equal(storage.isPrimaryConversationStore(), true, 'JSON-mode Storage is the primary conversation store');
    conversationState.configurePersistence(convPath, storage);
    conversationState.restore(sched);

    conversationState.set('a@c.us', handoff('a@c.us'));
    assert.ok(fs.existsSync(convPath), 'snapshot file written');
    assert.equal(fs.existsSync(`${convPath}.tmp`), false, 'no leftover .tmp after a successful write');
    assert.equal(Object.keys(readJson(convPath).conversations).length, 1, 'one conversation on disk');

    conversationState.set('b@c.us', handoff('b@c.us'));
    assert.equal(Object.keys(readJson(convPath).conversations).length, 2, 'two conversations on disk');
    assert.ok(fs.existsSync(`${convPath}.bak`), '.bak created on the second write');
    assert.equal(Object.keys(readJson(`${convPath}.bak`).conversations).length, 1, '.bak holds the PREVIOUS good snapshot');

    conversationState.remove('a@c.us');
    conversationState.remove('b@c.us');
    console.log('  1. JSON mode — atomic write, .bak = previous good snapshot, no .tmp left behind');
  }

  // ── Phase 2: restore falls back to .bak when the main file is truncated ──
  {
    const convPath = path.join(dir, 'p2.json');
    fs.writeFileSync(convPath, '{"version":1,"conversations":{"x@c.us":', 'utf-8'); // crashed mid-write
    const good = { version: 1, savedAt: new Date().toISOString(), conversations: { 'x@c.us': handoff('x@c.us') } };
    fs.writeFileSync(`${convPath}.bak`, JSON.stringify(good), 'utf-8');

    const storage = new Storage(path.join(dir, 'p2-contacts.json'));
    conversationState.configurePersistence(convPath, storage);
    const n = conversationState.restore(sched);
    assert.equal(n, 1, 'restore recovered the conversation from .bak instead of failing on the truncated file');
    assert.ok(conversationState.get('x@c.us'), 'the recovered conversation is in memory');
    conversationState.remove('x@c.us');
    console.log('  2. restore — truncated main file, recovers cleanly from .bak');
  }

  // ── Phase 3: truncated main, no .bak -> clean 0, no throw ──
  {
    const convPath = path.join(dir, 'p3.json');
    fs.writeFileSync(convPath, '{ this is not json', 'utf-8');
    const storage = new Storage(path.join(dir, 'p3-contacts.json'));
    conversationState.configurePersistence(convPath, storage);
    let n, threw = false;
    try { n = conversationState.restore(sched); } catch { threw = true; }
    assert.equal(threw, false, 'restore does not throw on an unreadable file with no .bak');
    assert.equal(n, 0, 'restore returns 0 when nothing parses');
    console.log('  3. restore — truncated main, no .bak -> returns 0, no throw');
  }

  // ── Phase 4: Postgres-mode / non-primary backend -> plain write, UNCHANGED ──
  for (const [label, backend] of [
    ['no isPrimaryConversationStore()', {
      loadConversationStateSnapshot: () => undefined,
      saveConversationStateSnapshot: () => {},
    }],
    ['isPrimaryConversationStore() === false', {
      loadConversationStateSnapshot: () => undefined,
      saveConversationStateSnapshot: () => {},
      isPrimaryConversationStore: () => false,
    }],
  ]) {
    const convPath = path.join(dir, `p4-${label.replace(/\W+/g, '_')}.json`);
    conversationState.configurePersistence(convPath, backend);
    conversationState.restore(sched);
    conversationState.set('p@c.us', handoff('p@c.us'));
    assert.ok(fs.existsSync(convPath), `[${label}] file still written`);
    assert.equal(fs.existsSync(`${convPath}.bak`), false, `[${label}] no .bak — atomic path NOT taken in non-JSON mode`);
    assert.equal(fs.existsSync(`${convPath}.tmp`), false, `[${label}] no .tmp`);
    conversationState.remove('p@c.us');
    console.log(`  4. non-primary backend (${label}) — plain write, no .bak/.tmp (Postgres path unchanged)`);
  }

  console.log('Conversation-state atomic write tests passed.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
