const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_REPLY_DELAY_MS = '0';

const { config } = require('../dist/config');
const { emptyStorageData, Storage } = require('../dist/storage');
const { tryHandleServiceBotMessage, validateServiceBotConfig } = require('../dist/serviceBot');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

function createTransport(sent) {
  return {
    async sendMessage(to, text) { sent.push({ kind: 'text', to, text }); },
    async sendInteractiveButtons(to, text, items) { sent.push({ kind: 'buttons', to, text, items }); },
    async sendInteractiveList(to, text, buttonText, items) { sent.push({ kind: 'list', to, text, buttonText, items }); },
    async resolvePhone(jid) { return jid.split('@')[0]; },
  };
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-service-bot-'));
  try {
    const legacyData = emptyStorageData();
    delete legacyData.serviceBot;
    delete legacyData.serviceBotSessions;
    const legacyStorage = new Storage(path.join(tempDir, 'legacy.json'), { initialData: legacyData });
    assert.strictEqual(legacyStorage.getServiceBot().enabled, false, 'legacy snapshots must default to disabled');
    assert.strictEqual(legacyStorage.getServiceBotSession('1'), null);
    const storage = new Storage(path.join(tempDir, 'contacts.json'), { initialData: emptyStorageData() });
    const serviceBot = {
      enabled: true,
      name: 'Service test',
      triggerText: '\u05ea\u05e4\u05e8\u05d9\u05d8',
      mainMenuNodeId: 'main',
      fallbackText: '\u05d1\u05d7\u05d9\u05e8\u05d4 \u05dc\u05d0 \u05ea\u05e7\u05d9\u05e0\u05d4',
      nodes: [
        {
          id: 'main', title: '\u05ea\u05e4\u05e8\u05d9\u05d8 \u05e8\u05d0\u05e9\u05d9', type: 'menu', text: '\u05d0\u05d9\u05da \u05d0\u05e4\u05e9\u05e8 \u05dc\u05e2\u05d6\u05d5\u05e8?',
          options: [
            { id: 'new', label: '\u05dc\u05e7\u05d5\u05d7 \u05d7\u05d3\u05e9', targetNodeId: 'new-info' },
            { id: 'existing', label: '\u05dc\u05e7\u05d5\u05d7 \u05e7\u05d9\u05d9\u05dd', targetNodeId: 'existing-info' },
          ],
        },
        { id: 'new-info', title: '\u05dc\u05e7\u05d5\u05d7 \u05d7\u05d3\u05e9', type: 'message', text: '\u05de\u05d9\u05d3\u05e2 \u05dc\u05dc\u05e7\u05d5\u05d7 \u05d7\u05d3\u05e9' },
        { id: 'existing-info', title: '\u05dc\u05e7\u05d5\u05d7 \u05e7\u05d9\u05d9\u05dd', type: 'handoff', text: '\u05e0\u05d9\u05ea\u05df \u05dc\u05e4\u05e0\u05d5\u05ea \u05dc\u05e0\u05e6\u05d9\u05d2', handoffPhone: '0501234567' },
      ],
    };
    storage.updateServiceBot(serviceBot);

    const sent = [];
    const transport = createTransport(sent);
    config.CLIENT_SERVICE_BOT_ENABLED = false;
    assert.strictEqual(await tryHandleServiceBotMessage('\u05ea\u05e4\u05e8\u05d9\u05d8', '111@c.us', '111', storage, transport), false);
    assert.strictEqual(sent.length, 0, 'feature flag off must not send');

    config.CLIENT_SERVICE_BOT_ENABLED = true;
    assert.strictEqual(await tryHandleServiceBotMessage('\u05ea\u05e4\u05e8\u05d9\u05d8', '111@c.us', '111', storage, transport), true);
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'main');
    assert.strictEqual(sent.at(-1).kind, 'buttons');

    await tryHandleServiceBotMessage('1', '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'new-info', 'number must navigate');

    await tryHandleServiceBotMessage('\u05ea\u05e4\u05e8\u05d9\u05d8 \u05e8\u05d0\u05e9\u05d9', '111@c.us', '111', storage, transport);
    await tryHandleServiceBotMessage('\u05dc\u05e7\u05d5\u05d7 \u05e7\u05d9\u05d9\u05dd', '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'existing-info', 'label must navigate');
    assert.match(sent.at(-1).text, /wa\.me\/972501234567/, 'handoff phone must be normalized');

    await tryHandleServiceBotMessage('\u05d7\u05d6\u05e8\u05d4', '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'main', 'back must return to main');
    await tryHandleServiceBotMessage('new', '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'new-info', 'option id must navigate');

    await tryHandleServiceBotMessage('\u05ea\u05e4\u05e8\u05d9\u05d8 \u05e8\u05d0\u05e9\u05d9', '111@c.us', '111', storage, transport);
    const beforeUnknown = sent.length;
    await tryHandleServiceBotMessage('???', '111@c.us', '111', storage, transport);
    assert.strictEqual(sent.length, beforeUnknown + 2, 'unknown input must send fallback and repeat menu');
    assert.strictEqual(sent[beforeUnknown].text, serviceBot.fallbackText);

    await tryHandleServiceBotMessage('\u05ea\u05e4\u05e8\u05d9\u05d8', '222@c.us', '222', storage, transport);
    await tryHandleServiceBotMessage('2', '222@c.us', '222', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('222').nodeId, 'existing-info');
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'main', 'sessions must be isolated by phone');

    const invalid = JSON.parse(JSON.stringify(serviceBot));
    invalid.nodes[0].options[0].targetNodeId = 'missing';
    assert.strictEqual(validateServiceBotConfig(invalid).ok, false, 'missing target must fail validation');

    const pendingPhone = '333';
    const pendingJid = `${pendingPhone}@c.us`;
    conversationState.set(pendingJid, {
      kind: 'handoff', senderJid: pendingJid, senderPhone: pendingPhone,
      humanHandoffEnabled: true, humanHandoffText: 'campaign handoff', timestamp: Date.now(),
    });
    await handleIncomingWhatsAppMessage({
      id: 'service-bot-pending-priority', from: pendingJid, body: serviceBot.triggerText,
      timestamp: Math.floor(Date.now() / 1000), getDisplayName: async () => '',
    }, storage, transport, 'baileys');
    assert.strictEqual(storage.getServiceBotSession(pendingPhone), null, 'campaign pending state must stay higher priority');
    assert.strictEqual(sent.at(-1).text, 'campaign handoff');
    conversationState.remove(pendingJid);

    console.log('Service bot flow tests passed.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
