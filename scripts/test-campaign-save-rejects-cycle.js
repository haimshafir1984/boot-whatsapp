/**
 * Saving a campaign whose message steps send on to each other in a circle must be refused (400) on both
 * create and update, and the stored campaign must stay untouched. Ordinary flows, including a question menu
 * that loops back, still save. Drives the real admin-server routes over HTTP.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = String(37000 + Math.floor(Math.random() * 5000));
process.env.CLIENT_ACCESS_TOKEN = 'campaign-cycle-test-token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { startAdminServer } = require('../dist/adminServer');

const base = () => `http://127.0.0.1:${process.env.PORT}`;
const msg = (id, nextStepId) => ({ id, kind: 'message', text: `text ${id}`, ...(nextStepId ? { nextStepId } : {}) });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-cycle-'));
  let server;
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    server = startAdminServer(storage);
    await new Promise((r) => setTimeout(r, 150));
    const login = await fetch(`${base()}/auth/client/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: process.env.CLIENT_ACCESS_TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const send = (method, url, body) => fetch(`${base()}${url}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const campaignBody = (trigger, decisionFlow) => ({ name: trigger, triggerType: 1, triggerPhrase: trigger, conversation: { decisionFlow } });

    const circle = [msg('a', 'b'), msg('b', 'c'), msg('c', 'a')];
    const create = await send('POST', '/api/campaigns', campaignBody('cycle-create', circle));
    assert.equal(create.status, 400, 'creating a circular campaign is refused');
    assert.match((await create.json()).error, /שלב 1/);
    assert.equal(storage.getCampaigns().length, 0, 'nothing stored');

    const good = await send('POST', '/api/campaigns', campaignBody('cycle-ok', [msg('a', 'b'), msg('b', 'c'), msg('c')]));
    assert.equal(good.status, 200, `an ordinary chain saves (got ${good.status})`);
    const saved = storage.getCampaigns()[0];
    const before = JSON.stringify(storage.getCampaignConversationSettings(saved).decisionFlow);

    const put = await send('PUT', `/api/campaigns/${saved.id}`, campaignBody('cycle-ok', circle));
    assert.equal(put.status, 400, 'editing into a circle is refused');
    assert.equal(JSON.stringify(storage.getCampaignConversationSettings(storage.getCampaigns()[0]).decisionFlow), before, 'stored flow untouched by the refused edit');

    const menu = [
      { id: 'q', kind: 'question', presentation: 'buttons', text: 'menu', options: [{ id: 'o', text: 'more', action: 'next', nextStepId: 'm' }] },
      msg('m', 'q'),
    ];
    const menuPut = await send('PUT', `/api/campaigns/${saved.id}`, campaignBody('cycle-ok', menu));
    assert.equal(menuPut.status, 200, 'a menu that loops back through a question still saves');
    console.log('Campaign save cycle-rejection tests passed.');
  } finally {
    if (server && server.close) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
