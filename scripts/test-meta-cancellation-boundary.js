'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-cancel-boundary-'));
Object.assign(process.env, { NODE_ENV:'test', WHATSAPP_PROVIDER:'META_CLOUD_API',
  STORAGE_PATH:path.join(root,'storage.json'), OWNER_STORAGE_PATH:path.join(root,'owner.json'),
  CONVERSATION_STATE_PATH:path.join(root,'state.json'), OWNER_ACCESS_TOKEN:'synthetic-owner', CLIENT_ACCESS_TOKEN:'synthetic-client',
  META_ACCESS_TOKEN:'', DOKPLOY_META_ACCESS_TOKEN:'', META_PHONE_NUMBER_ID:'', BOT_REPLY_DELAY_MS:'0' });
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { runCampaignWork, stopCampaignWork, campaignWorkSleep, hasCampaignWork } = require('../dist/campaignWork');
const { config } = require('../dist/config');
const storage = new Storage(process.env.STORAGE_PATH);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
(async () => {
  config.ADMIN_PORT = 0;
  server = require('../dist/adminServer').startAdminServer(storage);
  if (!server.listening) await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route,phone) => fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-owner-token':'synthetic-owner'},body:JSON.stringify({phone})});
  const phone = '15550100001';
  const pending = storage.enqueueOutboxMessage({kind:'text',to:`whatsapp:${phone}`,text:'old tail'});
  const unrelated = storage.enqueueOutboxMessage({kind:'text',to:'whatsapp:15550100002',text:'unrelated'});
  let finishSend;
  const old = runCampaignWork(phone, () => new Promise(resolve => { finishSend = resolve; }));
  assert.equal((await (await post('/owner-api/meta-pending-route',phone)).json()).activeWork,true);
  let returned = false;
  const clearing = post('/owner-api/meta-clear-pending',phone).then(r => { returned=true; return r; });
  await wait(80);
  assert.equal(returned,false,'handover must wait for already-started provider request');
  finishSend(); await old;
  const result = await clearing;
  assert.equal(result.status,200);
  assert.equal((await result.json()).cancelled,true);
  assert.equal(storage.getOutboxMessage(pending.id).status,'failed');
  assert.equal(storage.getOutboxMessage(unrelated.id).status,'queued');
  assert.equal(new Storage(process.env.STORAGE_PATH).getOutboxMessage(pending.id).status,'failed');
  conversationState.set('whatsapp:15550100003',{kind:'needs_review',senderPhone:'15550100003',senderJid:'whatsapp:15550100003',timestamp:Date.now(),reason:'test'});
  assert.equal((await post('/owner-api/meta-clear-pending','15550100003')).status,409);
  assert.equal(conversationState.isHeldForReview('15550100003'),true);

  // A timer inherits the original ALS context after it has finished. It must
  // register a fresh active run and remain cancellable.
  let timerStarted, timerDone;
  const started = new Promise(resolve=>{timerStarted=resolve;});
  const done = new Promise(resolve=>{timerDone=resolve;});
  let lateSend = false;
  await runCampaignWork('15550100004', async () => {
    setTimeout(() => { void runCampaignWork('15550100004', async () => {
      timerStarted(); await campaignWorkSleep(10000); lateSend=true;
    }).catch(()=>{}).finally(timerDone); },5);
  });
  await started;
  assert.equal(hasCampaignWork('15550100004'),true);
  await stopCampaignWork('15550100004',async()=>{}); await done;
  assert.equal(lateSend,false);
  console.log('PASS: HTTP handover joins active sends, cancels durable outbox, preserves other recipients and holds; inherited timer cancellation.');
})().then(()=>{server.closeAllConnections();server.close();setTimeout(()=>process.exit(0),200);},err=>{console.error(err);if(server){server.closeAllConnections();server.close();}setTimeout(()=>process.exit(1),200);});
