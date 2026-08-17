'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../dist/storage');
const { conversationState } = require('../dist/conversationState');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');

class Transport {
  constructor() { this.sent = []; }
  async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); }
  async sendMessage(to, text) { this.sent.push({ to, text }); }
}

let sequence = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inbound(storage, transport, phone, body) {
  sequence += 1;
  await handleIncomingWhatsAppMessage({
    id: `email-${sequence}`,
    from: `whatsapp:${phone}`,
    body,
    hasUserSignal: true,
    timestamp: Math.floor(Date.now() / 1000),
    async getDisplayName() { return 'Participant'; },
  }, storage, transport, 'webhook');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-capture-'));
  const jid = 'whatsapp:972500000003';
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    inlineScripts.forEach((script) => new Function(script));
    assert.match(html, /<option value="email_capture">קליטת כתובת מייל<\/option>/);
    assert.match(html, /data-email-invalid-text/);

    const storage = new Storage(path.join(dir, 'storage.json'));
    const campaign = storage.addCampaign({
      name: 'Email capture',
      triggerType: 1,
      triggerPhrase: 'email-test',
      suffix: '',
      active: true,
      conversation: {
        askNameEnabled: false,
        nameTimeoutMinutes: 5,
        askNameText: '',
        replyText: '',
        followupMessages: [],
        decisionFlow: [
          { id: 'email', kind: 'email_capture', text: 'Your email?', emailInvalidText: 'Invalid email', nextStepId: 'thanks' },
          { id: 'thanks', kind: 'message', text: 'Thanks!' },
        ],
      },
    });
    const transport = new Transport();

    await inbound(storage, transport, '972500000003', 'email-test');
    assert.equal(transport.sent.at(-1).text, 'Your email?');

    await inbound(storage, transport, '972500000003', 'not-an-email');
    assert.equal(transport.sent.at(-1).text, 'Invalid email');
    assert.equal(storage.getCampaignResults(campaign.id)[0].email, undefined);
    assert.equal(conversationState.get(jid)?.kind, 'wait-reply');

    await inbound(storage, transport, '972500000003', 'Person+Guide@Example.COM');
    const result = storage.getCampaignResults(campaign.id)[0];
    assert.equal(result.email, 'Person+Guide@example.com');
    assert.ok(result.emailCollectedAt);
    assert.equal(transport.sent.at(-1).text, 'Thanks!');
    const emailEvents = storage.getCampaignEvents(campaign.id).filter((event) => event.type === 'email_captured');
    assert.equal(emailEvents.length, 1);
    assert.equal(emailEvents[0].label, 'Person+Guide@example.com');

    const timeoutCampaign = storage.addCampaign({
      name: 'Email capture timeout continuation',
      triggerType: 1,
      triggerPhrase: 'email-timeout-test',
      suffix: '',
      active: true,
      conversation: {
        askNameEnabled: false,
        nameTimeoutMinutes: 5,
        askNameText: '',
        replyText: '',
        followupMessages: [],
        decisionFlow: [
          {
            id: 'email-timeout',
            kind: 'email_capture',
            text: 'Email before timeout?',
            emailInvalidText: 'Invalid email',
            timeoutMode: 'continue',
            timeoutSeconds: 1,
            timeoutNextStepId: 'skipped-email',
          },
          { id: 'skipped-email', kind: 'message', text: 'Continuing without email' },
        ],
      },
    });
    await inbound(storage, transport, '972500000004', 'email-timeout-test');
    assert.equal(transport.sent.at(-1).text, 'Email before timeout?');
    await sleep(1200);
    assert.equal(transport.sent.at(-1).text, 'Continuing without email');
    assert.equal(storage.getCampaignResults(timeoutCampaign.id)[0].email, undefined);
    const timeoutEvents = storage.getCampaignEvents(timeoutCampaign.id).filter((event) => event.type === 'timeout_flow_started');
    assert.equal(timeoutEvents.length, 1);

    await inbound(storage, transport, '972500000005', 'email-timeout-test');
    assert.equal(transport.sent.at(-1).text, 'Email before timeout?');
    await inbound(storage, transport, '972500000005', 'wrong-email');
    assert.equal(transport.sent.at(-1).text, 'Invalid email');
    await sleep(1200);
    assert.equal(transport.sent.at(-1).text, 'Continuing without email');
    assert.equal(storage.getCampaignResults(timeoutCampaign.id)[1].email, undefined);
    const timeoutEventsAfterInvalid = storage.getCampaignEvents(timeoutCampaign.id).filter((event) => event.type === 'timeout_flow_started');
    assert.equal(timeoutEventsAfterInvalid.length, 2);

    console.log('Email capture tests passed.');
  } finally {
    conversationState.remove(jid);
    conversationState.remove('whatsapp:972500000004');
    conversationState.remove('whatsapp:972500000005');
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
