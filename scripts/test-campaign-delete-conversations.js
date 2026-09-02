/**
 * test-campaign-delete-conversations.js
 * Covers step 3 (B.2) of docs/safety-speed-deploy-plan-2026-09-02.md:
 * DELETE /api/campaigns/:id must delete the campaign FIRST and only then detach
 * live conversations — and must NOT touch conversationState when the delete fails.
 *
 * Drives the real admin-server route over HTTP.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = String(37000 + Math.floor(Math.random() * 5000));
process.env.CLIENT_ACCESS_TOKEN = 'campaign-delete-test-token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { startAdminServer } = require('../dist/adminServer');
const { conversationState } = require('../dist/conversationState');

const base = () => `http://127.0.0.1:${process.env.PORT}`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-delete-'));
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    conversationState.configurePersistence(path.join(dir, 'conversation-state.json'), storage);

    const keep = storage.addCampaign({ name: 'Keep', triggerType: 1, triggerPhrase: 'keep-trigger', suffix: '', active: true });
    const drop = storage.addCampaign({ name: 'Drop', triggerType: 1, triggerPhrase: 'drop-trigger', suffix: '', active: true });

    // One live conversation per campaign.
    conversationState.set('9720000000010@c.us', { kind: 'handoff', senderJid: '9720000000010@c.us', campaignId: keep.id, timestamp: Date.now() });
    conversationState.set('9720000000011@c.us', { kind: 'handoff', senderJid: '9720000000011@c.us', campaignId: drop.id, timestamp: Date.now() });
    assert.equal(conversationState.size(), 2, 'two conversations registered');

    const server = startAdminServer(storage);
    await new Promise((r) => setTimeout(r, 150));

    const login = await fetch(`${base()}/auth/client/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessCode: process.env.CLIENT_ACCESS_TOKEN }),
    });
    assert.equal(login.status, 200, 'client login');
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, 'got a session cookie');

    // ── failure path: deleteCampaign returns false -> conversationState untouched ──
    const realDelete = storage.deleteCampaign.bind(storage);
    storage.deleteCampaign = () => false;
    const failRes = await fetch(`${base()}/api/campaigns/${drop.id}`, { method: 'DELETE', headers: { cookie } });
    const failBody = await failRes.json();
    assert.equal(failRes.status, 200, 'handler responds 200 with ok:false');
    assert.equal(failBody.ok, false, 'delete reported as failed');
    assert.equal(failBody.conversations, 0, 'no conversations detached on a failed delete');
    assert.equal(conversationState.size(), 2, 'both conversations still present after failed delete');
    assert.ok(conversationState.get('9720000000011@c.us'), 'the drop-campaign conversation was NOT removed');
    console.log('  failure path — delete fails, conversationState untouched (no stranded conversations)');

    // ── success path: real delete -> conversationState.removeByCampaign runs ──
    storage.deleteCampaign = realDelete;
    const okRes = await fetch(`${base()}/api/campaigns/${drop.id}`, { method: 'DELETE', headers: { cookie } });
    const okBody = await okRes.json();
    assert.equal(okRes.status, 200);
    assert.equal(okBody.ok, true, 'delete succeeded');
    assert.equal(okBody.conversations, 1, 'exactly the one conversation on that campaign was detached');
    assert.equal(conversationState.get('9720000000011@c.us'), undefined, 'drop-campaign conversation removed');
    assert.ok(conversationState.get('9720000000010@c.us'), 'keep-campaign conversation left alone');
    assert.equal(conversationState.size(), 1, 'only the deleted campaign\'s conversation is gone');
    assert.equal(storage.getCampaigns().find((c) => c.id === drop.id), undefined, 'campaign is actually gone from storage');
    console.log('  success path — campaign deleted first, then its conversations cleared');

    void server;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('Campaign delete / conversation cleanup tests passed.');
    // The admin server keeps its own drain intervals alive; let open sockets
    // settle, then exit hard (throwaway process).
    await new Promise((r) => setTimeout(r, 200));
    process.exit(0);
  } catch (err) {
    console.error(err);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
})();
