const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.BOT_REPLY_DELAY_MS = '0';
delete process.env.CLIENT_SERVICE_BOT_ENABLED;

const { config } = require('../dist/config');
const { emptyStorageData, Storage } = require('../dist/storage');
const { deliverServiceBotFollowUp, tryHandleServiceBotMessage, validateServiceBotConfig } = require('../dist/serviceBot');
const { buildMetaGatewayRoutes, campaignsToMetaGatewayRoutes, preferCampaignMetaRoutes } = require('../dist/adminServer');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');

assert.strictEqual(config.CLIENT_SERVICE_BOT_ENABLED, true, 'service bot feature must be available by default');

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

    const singletonSnapshot = emptyStorageData();
    delete singletonSnapshot.serviceBots;
    singletonSnapshot.serviceBot = {
      enabled: true,
      name: 'Legacy singleton',
      triggerText: 'legacy trigger',
      mainMenuNodeId: 'main',
      fallbackText: 'fallback',
      nodes: [{ id: 'main', title: 'Main', type: 'message', text: 'Hello' }],
    };
    singletonSnapshot.serviceBotSessions = [{ phone: '972500000000', nodeId: 'main', variables: {}, updatedAt: new Date().toISOString() }];
    const migratedSingletonStorage = new Storage(path.join(tempDir, 'legacy-singleton.json'), { initialData: singletonSnapshot });
    const migratedBots = migratedSingletonStorage.getServiceBots();
    assert.strictEqual(migratedBots.length, 1, 'legacy singleton must migrate to one service bot');
    assert.strictEqual(migratedBots[0].name, 'Legacy singleton');
    assert.ok(migratedBots[0].id, 'migrated service bot must receive an id');
    assert.strictEqual(migratedSingletonStorage.getServiceBotSession('972500000000').botId, migratedBots[0].id,
      'legacy sessions must be associated with the migrated bot');

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
    assert.strictEqual(buildMetaGatewayRoutes(storage, false).some(route => route.routeKind === 'service_bot'), false);
    const metaRoutes = buildMetaGatewayRoutes(storage, true);
    assert.strictEqual(metaRoutes.length, 1, 'enabled service bot must be exposed to the Meta gateway');
    assert.strictEqual(metaRoutes[0].triggerPhrase, serviceBot.triggerText);
    assert.strictEqual(metaRoutes[0].routeKind, 'service_bot');
    const legacyCampaignRoutes = campaignsToMetaGatewayRoutes([
      { id: 'legacy', name: 'Legacy', triggerType: 1, triggerPhrase: 'legacy', suffix: '', active: true },
    ]);
    assert.strictEqual(legacyCampaignRoutes[0].routeKind, 'campaign', 'legacy clients must keep campaign-only gateway routing');

    const preferredRoutes = preferCampaignMetaRoutes([
      { clientId: 'a', triggerText: 'menu', campaign: { routeKind: 'service_bot' } },
      { clientId: 'a', triggerText: 'menu', campaign: { routeKind: 'campaign' } },
      { clientId: 'b', triggerText: 'menu', campaign: { routeKind: 'service_bot' } },
    ]);
    assert.strictEqual(preferredRoutes.length, 2);
    assert.strictEqual(preferredRoutes.some(route => route.clientId === 'a' && route.campaign.routeKind === 'service_bot'), false,
      'campaign route must take priority over a same-client service bot trigger');
    assert.strictEqual(preferredRoutes.some(route => route.clientId === 'b' && route.campaign.routeKind === 'service_bot'), true);

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
    assert.ok(sent.some((item) => /wa\.me\/972501234567/.test(item.text || '')), 'handoff phone must be normalized');

    await tryHandleServiceBotMessage('\u05d7\u05d6\u05e8\u05d4', '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'main', 'back must return to main');
    await tryHandleServiceBotMessage('new', '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'new-info', 'option id must navigate');
    assert.ok(sent.some((item) => /wa\.me\/972501234567/.test(item.text || '')), 'handoff phone must be normalized');

    await tryHandleServiceBotMessage('\u05ea\u05e4\u05e8\u05d9\u05d8 \u05e8\u05d0\u05e9\u05d9', '111@c.us', '111', storage, transport);
    const beforeUnknown = sent.length;
    await tryHandleServiceBotMessage('???', '111@c.us', '111', storage, transport);
    assert.strictEqual(sent.length, beforeUnknown + 2, 'unknown input must send fallback and repeat menu');
    assert.strictEqual(sent[beforeUnknown].text, serviceBot.fallbackText);

    const secondBot = storage.createServiceBot({ ...serviceBot, id: undefined, name: 'Second service bot', triggerText: 'second menu' });
    assert.strictEqual(storage.getServiceBots().length, 2, 'multiple service bots must be persisted for one client');
    assert.strictEqual(buildMetaGatewayRoutes(storage, true).filter(route => route.routeKind === 'service_bot').length, 2,
      'every enabled service bot must be exposed as a Meta route');
    await tryHandleServiceBotMessage(secondBot.triggerText, '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').botId, secondBot.id, 'a new explicit trigger must switch the active bot session');
    await tryHandleServiceBotMessage(serviceBot.triggerText, '111@c.us', '111', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('111').botId, storage.getServiceBots()[0].id, 'the original trigger must switch back to the original bot');
    const duplicatedBot = storage.duplicateServiceBot(secondBot.id);
    assert.ok(duplicatedBot && !duplicatedBot.enabled, 'duplicated service bots must be created disabled');

    const quietStorage = new Storage(path.join(tempDir, 'quiet-navigation.json'), { initialData: emptyStorageData() });
    quietStorage.updateServiceBot({ ...serviceBot, navigationPromptText: '' });
    const quietSent = [];
    const quietTransport = createTransport(quietSent);
    await tryHandleServiceBotMessage(serviceBot.triggerText, '777@c.us', '777', quietStorage, quietTransport);
    const beforeQuietChoice = quietSent.length;
    await tryHandleServiceBotMessage('1', '777@c.us', '777', quietStorage, quietTransport);
    assert.strictEqual(quietSent.length, beforeQuietChoice + 1, 'blank navigation prompt must suppress the extra navigation message');
    assert.strictEqual(quietSent.at(-1).kind, 'text', 'only the destination message should be sent when navigation is disabled');

    await tryHandleServiceBotMessage('\u05ea\u05e4\u05e8\u05d9\u05d8', '222@c.us', '222', storage, transport);
    await tryHandleServiceBotMessage('2', '222@c.us', '222', storage, transport);
    assert.strictEqual(storage.getServiceBotSession('222').nodeId, 'existing-info');
    assert.strictEqual(storage.getServiceBotSession('111').nodeId, 'main', 'sessions must be isolated by phone');

    const advancedStorage = new Storage(path.join(tempDir, 'advanced.json'), { initialData: emptyStorageData() });
    const advancedBot = {
      ...serviceBot,
      nodes: [
        { id: 'main', title: 'Main', type: 'menu', text: 'Choose', options: [
          { id: 'recommend', label: 'Recommend', targetNodeId: 'decision', variableKey: 'need', variableValue: 'fit' },
          { id: 'return', label: 'Return', targetNodeId: 'order-input' },
          { id: 'purchase', label: 'Purchase', targetNodeId: 'purchase-info' },
        ] },
        { id: 'decision', title: 'Decision', type: 'condition', text: '', conditionRules: [
          { id: 'fit-rule', label: 'Fit', conditions: [{ variableKey: 'need', operator: 'equals', value: 'fit' }], targetNodeId: 'fit-result' },
        ], defaultTargetNodeId: 'other-result' },
        { id: 'fit-result', title: 'Fit', type: 'message', text: 'Recommended {{need}}' },
        { id: 'other-result', title: 'Other', type: 'message', text: 'Other' },
        { id: 'order-input', title: 'Order', type: 'input', text: 'Order number?', inputType: 'text', variableKey: 'order_number', nextNodeId: 'photo-input', inputErrorText: 'Order required' },
        { id: 'photo-input', title: 'Photo', type: 'input', text: 'Photo?', inputType: 'image', variableKey: 'product_photo', nextNodeId: 'return-done', inputErrorText: 'Photo required' },
        { id: 'return-done', title: 'Done', type: 'message', text: 'Saved {{order_number}}' },
        { id: 'purchase-info', title: 'Purchase', type: 'message', text: 'Purchase link', followUpDelayMinutes: 10, followUpTargetNodeId: 'purchase-check' },
        { id: 'purchase-check', title: 'Check', type: 'menu', text: 'Did you purchase?', options: [{ id: 'yes', label: 'Yes', targetNodeId: 'fit-result' }] },
      ],
    };
    assert.strictEqual(validateServiceBotConfig(advancedBot).ok, true, 'advanced service bot must validate');
    advancedStorage.updateServiceBot(advancedBot);
    const advancedSent = [];
    const advancedTransport = createTransport(advancedSent);

    await tryHandleServiceBotMessage(advancedBot.triggerText, '444@c.us', '444', advancedStorage, advancedTransport);
    await tryHandleServiceBotMessage('recommend', '444@c.us', '444', advancedStorage, advancedTransport);
    assert.strictEqual(advancedStorage.getServiceBotSession('444').nodeId, 'fit-result', 'condition must route from a saved option variable');
    assert.ok(advancedSent.some(item => /Recommended fit/.test(item.text || '')), 'saved variables must render in messages');

    await tryHandleServiceBotMessage(advancedBot.triggerText, '555@c.us', '555', advancedStorage, advancedTransport);
    await tryHandleServiceBotMessage('return', '555@c.us', '555', advancedStorage, advancedTransport);
    await tryHandleServiceBotMessage('ABC-123', '555@c.us', '555', advancedStorage, advancedTransport);
    assert.strictEqual(advancedStorage.getServiceBotSession('555').nodeId, 'photo-input');
    await tryHandleServiceBotMessage('', '555@c.us', '555', advancedStorage, advancedTransport, {
      messageId: 'photo-1', media: { kind: 'image', mimeType: 'image/jpeg', providerMediaId: 'meta-photo-1' },
    });
    assert.strictEqual(advancedStorage.getServiceBotSession('555').nodeId, 'return-done', 'image input must continue the flow');
    const capturedRecord = advancedStorage.getServiceBotRecords().find(item => item.phone === '555');
    assert.strictEqual(capturedRecord.variables.order_number, 'ABC-123');
    assert.strictEqual(capturedRecord.attachments.length, 1, 'captured media metadata must be retained');

    await tryHandleServiceBotMessage(advancedBot.triggerText, '666@c.us', '666', advancedStorage, advancedTransport);
    await tryHandleServiceBotMessage('purchase', '666@c.us', '666', advancedStorage, advancedTransport);
    const due = advancedStorage.getDueServiceBotFollowUps(10, new Date(Date.now() + 11 * 60 * 1000));
    assert.strictEqual(due.length, 1, 'node follow-up must be scheduled durably');
    const claimed = advancedStorage.claimServiceBotFollowUp(due[0].id);
    await deliverServiceBotFollowUp(claimed, advancedStorage, advancedTransport);
    advancedStorage.completeServiceBotFollowUp(claimed.id);
    assert.strictEqual(advancedStorage.getServiceBotSession('666').nodeId, 'purchase-check', 'scheduled follow-up must enter its target node');

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
    assert.strictEqual(storage.getServiceBotSession(pendingPhone)?.botId, storage.getServiceBot().id, 'an explicit service-bot trigger must replace campaign pending state');
    assert.notStrictEqual(sent.at(-1).text, 'campaign handoff', 'the stale campaign handoff must not consume an explicit service-bot trigger');
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
