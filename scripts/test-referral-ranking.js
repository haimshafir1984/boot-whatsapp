'use strict';
process.env.NODE_ENV = 'test';
process.env.BOT_REPLY_DELAY_MS = '0';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../dist/storage');
const { handleIncomingWhatsAppMessage } = require('../dist/messageFlow');
const { conversationState } = require('../dist/conversationState');
class FakeTransport { constructor() { this.sent = []; } async resolvePhone(jid) { return String(jid).replace(/\D/g, ''); } async sendMessage(to, text) { this.sent.push({ type: 'text', to, text }); } async sendInteractiveButtons(to, text, buttons) { this.sent.push({ type: 'buttons', to, text, buttons }); } }
let messageId = 0;
async function inbound(storage, transport, phone, body, isButtonReply = false) { messageId += 1; await handleIncomingWhatsAppMessage({ id: `referral-test-${messageId}`, from: `whatsapp:${phone}`, body, hasUserSignal: true, isButtonReply, timestamp: Math.floor(Date.now() / 1000), async getDisplayName() { return 'Flow User'; } }, storage, transport, 'webhook'); }
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'referral-ranking-test-'));
const storage = new Storage(path.join(tempDir, 'storage.json'));
(async () => { try {
  const campaign = storage.addCampaign({ name: 'Referral ranking', triggerType: 1, triggerPhrase: 'join', suffix: '', active: true, conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: '', followupMessages: [], decisionFlow: [{ id: 'referral-hub', kind: 'question', presentation: 'buttons', text: 'Choose', options: [{ id: 'link', text: 'Personal link', action: 'referral_link', endText: 'Your link: {referral_link}', nextStepId: 'referral-hub' }, { id: 'leaders', text: 'Leaders', action: 'referral_leaderboard', endText: 'Current leaders:', nextStepId: 'referral-hub' }, { id: 'rank', text: 'My rank', action: 'referral_my_rank', endText: 'Rank {rank}; referrals {referrals}', nextStepId: 'done' }] }, { id: 'done', kind: 'message', text: 'Done' }] } });
  const leader = storage.recordCampaignTrigger(campaign.id, '972500000001', 'Leader'); const second = storage.recordCampaignTrigger(campaign.id, '972500000002', 'Second');
  storage.recordCampaignTrigger(campaign.id, '972500000101', 'Invite A', leader.referralCode); storage.recordCampaignTrigger(campaign.id, '972500000101', 'Invite A duplicate', leader.referralCode); storage.recordCampaignTrigger(campaign.id, '972500000102', 'Invite B', leader.referralCode); storage.recordCampaignTrigger(campaign.id, '972500000103', 'Invite C', second.referralCode);
  const rows = storage.getCampaignReferralLeaderboard(campaign.id); assert.strictEqual(rows.find((row) => row.phone === leader.phone).invited, 2, 'duplicate invitee must count once'); assert.strictEqual(rows.find((row) => row.phone === second.phone).invited, 1);
  const rank = storage.getCampaignReferralRank(campaign.id, leader.phone); assert.deepStrictEqual({ rank: rank.rank, invited: rank.invited, nextGap: rank.nextGap }, { rank: 1, invited: 2, nextGap: 0 });
  const transport = new FakeTransport(); const flowPhone = '972500000009'; await inbound(storage, transport, flowPhone, 'join'); await inbound(storage, transport, flowPhone, 'link', true);
  assert(transport.sent.some((item) => item.type === 'text' && item.text.includes('Your link:') && item.text.includes('ref:')), 'personal-link action must send a share URL'); assert(transport.sent.filter((item) => item.type === 'buttons' && item.to === `whatsapp:${flowPhone}`).length >= 2, 'referral menu must remain open after an action');
  await inbound(storage, transport, flowPhone, 'rank', true); assert(transport.sent.some((item) => item.type === 'text' && item.text.includes('Rank ')), 'my-rank action must render the editable template'); assert(transport.sent.some((item) => item.type === 'text' && item.text === 'Done'), 'referral action must proceed to its configured next step');
  storage.startNewCampaignResultBatch(campaign.id); storage.recordCampaignTrigger(campaign.id, '972500000002', 'Second, new batch'); const currentRows = storage.getCampaignReferralLeaderboard(campaign.id); assert.strictEqual(currentRows.length, 1, 'leaderboard must use only current batch'); assert.strictEqual(currentRows[0].phone, second.phone);
  conversationState.remove(`whatsapp:${flowPhone}`);
  console.log('Referral ranking and menu tests passed.');
} finally { fs.rmSync(tempDir, { recursive: true, force: true }); } })().catch((err) => { console.error(err); process.exit(1); });
