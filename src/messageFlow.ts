import { config } from './config';
import fs from 'fs';
import path from 'path';
import { conversationState } from './conversationState';
import { CampaignConversationSettings, CompletionLink, DecisionFlowOption, DecisionFlowStep, Storage } from './storage';
import { detectTrigger } from './triggerDetector';
import {
  IncomingWhatsAppMessage,
  WhatsAppMessageSource,
  WhatsAppTransport,
} from './types/whatsapp';

const handledMessageIds = new Set<string>();
const MAX_TRIGGER_AGE_MS = 2 * 60 * 1000;
const DECISION_REPLY_TIMEOUT_MS = 30 * 60 * 1000;
const HUMAN_HANDOFF_WINDOW_MS = 24 * 60 * 60 * 1000;
const ASK_NAME_RETRY_DELAY_MS = 5_000;
const FILE_SEND_RETRY_DELAY_MS = 5_000;
const TEXT_SEND_RETRY_DELAY_MS = 3_000;
const TEXT_SEND_ATTEMPTS = 2;
const BOT_REPLY_DELAY_MS = Math.max(
  0,
  Number.isFinite(config.BOT_REPLY_DELAY_MS) ? config.BOT_REPLY_DELAY_MS : 3000,
);

interface CampaignReplyBehavior {
  enabled?: boolean;
  text?: string;
  phone?: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
}

interface CompletionContactCard {
  enabled?: boolean;
  name?: string;
  phone?: string;
  email?: string;
  organization?: string;
}

interface CompletionDelivery {
  links?: CompletionLink[];
  fileIds?: string[];
  contactCard?: CompletionContactCard;
  contactCardPlacement?: 'after_completion' | 'before_questions';
  contactCardIntroText?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
}

function logTimerError(label: string, err: unknown): void {
  console.error(`[TIMER] ${label} failed:`, err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitBeforeBotReply(): Promise<void> {
  if (BOT_REPLY_DELAY_MS > 0) await sleep(BOT_REPLY_DELAY_MS);
}

async function sendBotMessage(transport: WhatsAppTransport, to: string, text: string): Promise<void> {
  const cleanText = text.trim();
  if (!cleanText) return;

  let lastError: unknown;
  for (let attempt = 1; attempt <= TEXT_SEND_ATTEMPTS; attempt += 1) {
    await waitBeforeBotReply();
    try {
      await transport.sendMessage(to, cleanText);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < TEXT_SEND_ATTEMPTS) {
        console.warn(`[SEND_RETRY] text attempt=${attempt} to=${to}:`, err);
        await sleep(TEXT_SEND_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

export async function handleIncomingWhatsAppMessage(
  message: IncomingWhatsAppMessage,
  storage: Storage,
  transport: WhatsAppTransport,
  source: WhatsAppMessageSource,
): Promise<void> {
  if (!message.body?.trim() && !message.hasUserSignal && !message.isReaction) return;
  if (!rememberMessage(message)) return;

  try {
    await handleMessage(message, storage, transport, source);
  } catch (err) {
    console.error(`[MSG] handler failed via ${source}:`, err);
  }
}

function rememberMessage(message: IncomingWhatsAppMessage): boolean {
  const id = message.id || `${message.from}:${message.timestamp ?? ''}`;

  if (handledMessageIds.has(id)) return false;
  handledMessageIds.add(id);

  if (handledMessageIds.size > 1000) {
    const first = handledMessageIds.values().next().value;
    if (first) handledMessageIds.delete(first);
  }

  return true;
}

async function handleMessage(
  message: IncomingWhatsAppMessage,
  storage: Storage,
  transport: WhatsAppTransport,
  source: WhatsAppMessageSource,
): Promise<void> {
  if (message.from === 'status@broadcast') return;
  if (message.from.endsWith('@g.us')) return;

  const senderJid = message.from;
  const messageAgeMs = message.timestamp
    ? Date.now() - message.timestamp * 1000
    : 0;
  const senderPhone = message.senderPhone || await transport.resolvePhone(senderJid);
  const pending = conversationState.get(senderJid) || conversationState.findByPhone(senderPhone);

  if (pending) {
    if (pending.kind === 'pre-name-prompt') {
      console.log(`[PRE_NAME_REPLY] via=${source} from=${senderJid} phone=${pending.senderPhone} kind=${message.isReaction ? 'reaction' : (message.body?.trim() ? 'text' : 'non_text')}`);
      clearTimeout(pending.timeoutHandle);
      storage.markCampaignResultStage(pending.campaignResultId, 'pre_name_replied', pending.whatsappName);
      if (pending.campaignId) {
        storage.recordCampaignEvent({
          campaignId: pending.campaignId,
          campaignResultId: pending.campaignResultId,
          phone: pending.senderPhone,
          type: 'pre_name_replied',
          label: message.isReaction ? 'reaction' : (message.body?.trim() ? 'text' : 'non_text'),
        });
      }
      try {
        await askForContactName(
          transport,
          storage,
          pending.senderJid,
          pending.senderPhone,
          pending.whatsappName,
          pending.suffix,
          pending.campaignResultId,
          pending.campaignId,
          {
            askNameEnabled: true,
            askNameText: pending.askNameText,
            nameTimeoutMinutes: pending.nameTimeoutMinutes ?? 5,
            replyText: pending.replyText,
            completionLinks: pending.completionLinks,
            completionFileIds: pending.completionFileIds,
            sendContactCard: pending.sendContactCard,
            contactCardPlacement: pending.contactCardPlacement,
            contactCardName: pending.contactCardName,
            contactCardPhone: pending.contactCardPhone,
            contactCardEmail: pending.contactCardEmail,
            contactCardOrganization: pending.contactCardOrganization,
            contactCardIntroText: pending.contactCardIntroText,
            contactCardWaitForConfirmation: pending.contactCardWaitForConfirmation,
            contactCardConfirmationTimeoutMinutes: pending.contactCardConfirmationTimeoutMinutes,
            followupMessages: pending.followupMessages,
            decisionFlow: pending.decisionFlow,
            humanHandoffEnabled: pending.humanHandoffEnabled,
            humanHandoffText: pending.humanHandoffText,
            humanHandoffPhone: pending.humanHandoffPhone,
            decisionTimeoutMinutes: pending.decisionTimeoutMinutes,
            decisionTimeoutText: pending.decisionTimeoutText,
          },
        );
      } catch (err) {
        logTimerError('ask name after pre-name reply', err);
        keepPreNamePromptRetry(
          pending,
          transport,
          storage,
          ASK_NAME_RETRY_DELAY_MS,
        );
      }
      return;
    }

    if (message.isReaction) {
      console.log(`[MSG] reaction ignored for pending ${pending.kind} via=${source} from=${senderJid}`);
      return;
    }

    if (!message.body?.trim()) {
      console.log(`[MSG] non-text message ignored for pending ${pending.kind} via=${source} from=${senderJid}`);
      return;
    }

    if (pending.kind === 'decision') {
      await handleDecisionReply(
        message.body.trim(),
        pending.flow,
        pending.stepId,
        pending.senderJid,
        storage,
        transport,
        pending.campaignId,
        pending.campaignResultId,
        pending.senderPhone,
        {
          enabled: pending.humanHandoffEnabled,
          text: pending.humanHandoffText,
          phone: pending.humanHandoffPhone,
          decisionTimeoutMinutes: pending.decisionTimeoutMinutes,
          decisionTimeoutText: pending.decisionTimeoutText,
        },
      );
      return;
    }

    if (pending.kind === 'wait-reply') {
      await handleWaitReply(
        message.body.trim(),
        pending.flow,
        pending.stepId,
        pending.senderJid,
        storage,
        transport,
        pending.campaignId,
        pending.campaignResultId,
        pending.senderPhone,
        {
          enabled: pending.humanHandoffEnabled,
          text: pending.humanHandoffText,
          phone: pending.humanHandoffPhone,
          decisionTimeoutMinutes: pending.decisionTimeoutMinutes,
          decisionTimeoutText: pending.decisionTimeoutText,
        },
      );
      return;
    }

    if (pending.kind === 'contact-card-confirmation') {
      clearTimeout(pending.timeoutHandle);
      conversationState.remove(pending.senderJid);
      if (pending.campaignId) {
        storage.recordCampaignEvent({
          campaignId: pending.campaignId,
          campaignResultId: pending.campaignResultId,
          phone: pending.senderPhone,
          type: 'contact_card_confirmed',
          label: message.body.trim().slice(0, 120),
        });
      }
      await continueAfterContactCard(
        transport,
        storage,
        pending.senderJid,
        pending.senderPhone || senderPhone,
        pending.campaignResultId,
        pending.followupMessages,
        pending.decisionFlow,
        pending.campaignId,
        {
          enabled: pending.humanHandoffEnabled,
          text: pending.humanHandoffText,
          phone: pending.humanHandoffPhone,
          decisionTimeoutMinutes: pending.decisionTimeoutMinutes,
          decisionTimeoutText: pending.decisionTimeoutText,
        },
      );
      return;
    }
    if (pending.kind === 'handoff') {
      await sendHumanHandoff(
        transport,
        storage,
        pending.senderJid,
        {
          enabled: pending.humanHandoffEnabled,
          text: pending.humanHandoffText,
          phone: pending.humanHandoffPhone,
        },
        pending.campaignId,
        pending.campaignResultId,
        pending.senderPhone,
      );
      return;
    }

    const chosenName = message.body.trim();
    clearTimeout(pending.timeoutHandle);
    conversationState.remove(pending.senderJid);

    const finalName = chosenName
      ? `${chosenName}${pending.suffix}`
      : `${pending.whatsappName}${pending.suffix}`;

    console.log(`\nName reply from ${pending.senderPhone}: "${finalName}"`);
    await queueAndReply(
      transport,
      storage,
      pending.senderJid,
      pending.senderPhone,
      finalName,
      pending.campaignResultId,
      pending.replyText,
      pending.followupMessages,
      pending.decisionFlow,
      pending.campaignId,
      {
        enabled: pending.humanHandoffEnabled,
        text: pending.humanHandoffText,
        phone: pending.humanHandoffPhone,
        decisionTimeoutMinutes: pending.decisionTimeoutMinutes,
        decisionTimeoutText: pending.decisionTimeoutText,
      },
      {
        links: pending.completionLinks,
        fileIds: pending.completionFileIds,
        contactCard: contactCardFromSettings(pending),
        contactCardPlacement: pending.contactCardPlacement,
      },
    );
    return;
  }

  if (message.isReaction) return;
  if (!message.body?.trim()) return;

  const activeCampaigns = storage.getActiveCampaigns();
  const trigger = detectTrigger(message.body, activeCampaigns);
  if (!trigger.matched) {
    console.log(`[MSG] no trigger match via=${source} age=${Math.round(messageAgeMs / 1000)}s from=${senderJid} active=${activeCampaigns.length}`);
    return;
  }
  if (messageAgeMs > MAX_TRIGGER_AGE_MS) {
    console.warn(`[MSG] stale trigger ignored via=${source} age=${Math.round(messageAgeMs / 1000)}s campaign="${trigger.campaignName}" from=${senderJid}`);
    return;
  }
  console.log(`[MSG] trigger matched via=${source} age=${Math.round(messageAgeMs / 1000)}s campaign="${trigger.campaignName}" from=${senderJid}`);

  const displayName = await message.getDisplayName();
  const pushname =
    displayName.trim() ||
    config.CONTACT_NAME_FALLBACK.replace('{phone}', senderPhone);
  const campaign = activeCampaigns.find((item) => item.id === trigger.campaignId);
  if (!campaign) return;
  const campaignResult = storage.recordCampaignTrigger(trigger.campaignId, senderPhone, pushname);

  console.log(`\n[${trigger.campaignName}] from ${senderPhone} (${pushname})`);

  const settings = storage.getCampaignConversationSettings(campaign);
  if (settings.askNameEnabled) {
    const preNamePromptText = settings.preNamePromptText?.trim();
    if (preNamePromptText) {
      storage.markCampaignResultStage(campaignResult.id, 'pre_name_prompt_sending', pushname);
      try {
        await sendBotMessage(transport, senderJid, preNamePromptText);
      } catch (err) {
        console.error(`[SEND_FAIL] pre_name_prompt campaign=${campaign.id} to=${senderPhone}:`, err);
        storage.markCampaignResultStage(campaignResult.id, 'pre_name_prompt_failed', pushname);
        storage.recordCampaignEvent({
          campaignId: campaign.id,
          campaignResultId: campaignResult.id,
          phone: senderPhone,
          type: 'pre_name_prompt_failed',
          label: preNamePromptText.slice(0, 120),
        });
        await askForContactName(
          transport,
          storage,
          senderJid,
          senderPhone,
          pushname,
          trigger.suffix,
          campaignResult.id,
          campaign.id,
          settings,
        );
        return;
      }
      storage.markCampaignResultStage(campaignResult.id, 'pre_name_prompt_sent', pushname);
      storage.recordCampaignEvent({
        campaignId: campaign.id,
        campaignResultId: campaignResult.id,
        phone: senderPhone,
        type: 'pre_name_prompt_sent',
        label: preNamePromptText.slice(0, 120),
      });
      console.log(`[SEND_OK] pre_name_prompt campaign=${campaign.id} to=${senderPhone}`);
      const timeoutMinutes = settings.preNamePromptTimeoutMinutes && settings.preNamePromptTimeoutMinutes > 0
        ? settings.preNamePromptTimeoutMinutes
        : 1;
      conversationState.set(senderJid, {
        kind: 'pre-name-prompt',
        senderJid,
        senderPhone,
        campaignResultId: campaignResult.id,
        campaignId: campaign.id,
        replyText: settings.replyText,
        completionLinks: settings.completionLinks,
        completionFileIds: settings.completionFileIds,
        sendContactCard: settings.sendContactCard,
        contactCardPlacement: settings.contactCardPlacement,
        contactCardName: settings.contactCardName,
        contactCardPhone: settings.contactCardPhone,
        contactCardEmail: settings.contactCardEmail,
        contactCardOrganization: settings.contactCardOrganization,
        contactCardWaitForConfirmation: settings.contactCardWaitForConfirmation,
        contactCardConfirmationTimeoutMinutes: settings.contactCardConfirmationTimeoutMinutes,
        followupMessages: settings.followupMessages,
        decisionFlow: settings.decisionFlow,
        humanHandoffEnabled: settings.humanHandoffEnabled,
        humanHandoffText: settings.humanHandoffText,
        humanHandoffPhone: settings.humanHandoffPhone,
        nameTimeoutMinutes: settings.nameTimeoutMinutes,
        preNamePromptTimeoutMinutes: timeoutMinutes,
        askNameText: settings.askNameText,
        decisionTimeoutMinutes: settings.decisionTimeoutMinutes,
        decisionTimeoutText: settings.decisionTimeoutText,
        suffix: trigger.suffix,
        whatsappName: pushname,
        timestamp: Date.now(),
        timeoutHandle: schedulePreNamePromptTimeout(
          transport,
          storage,
          senderJid,
          senderPhone,
          pushname,
          trigger.suffix,
          campaignResult.id,
          campaign.id,
          settings,
          timeoutMinutes,
        ),
      });
      console.log(`[PRE_NAME_WAITING] campaign=${campaign.id} phone=${senderPhone} autoContinue=${settings.preNamePromptAutoContinue !== false}`);
    } else {
      await askForContactName(
        transport,
        storage,
        senderJid,
        senderPhone,
        pushname,
        trigger.suffix,
        campaignResult.id,
        campaign.id,
        settings,
      );
    }
  } else {
    const contactName = `${pushname}${trigger.suffix}`;
    storage.markCampaignResultStage(campaignResult.id, 'queue_without_name', contactName);
    await queueAndReply(
      transport,
      storage,
      senderJid,
      senderPhone,
      contactName,
      campaignResult.id,
      settings.replyText,
      settings.followupMessages,
      settings.decisionFlow,
      campaign.id,
      {
        enabled: settings.humanHandoffEnabled,
        text: settings.humanHandoffText,
        phone: settings.humanHandoffPhone,
        decisionTimeoutMinutes: settings.decisionTimeoutMinutes,
        decisionTimeoutText: settings.decisionTimeoutText,
      },
      {
        links: settings.completionLinks,
        fileIds: settings.completionFileIds,
        contactCard: contactCardFromSettings(settings),
        contactCardPlacement: settings.contactCardPlacement,
        contactCardIntroText: settings.contactCardIntroText,
        contactCardWaitForConfirmation: settings.contactCardWaitForConfirmation,
        contactCardConfirmationTimeoutMinutes: settings.contactCardConfirmationTimeoutMinutes,
      },
    );
  }
}

async function askForContactName(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  whatsappName: string,
  suffix: string,
  campaignResultId: string | undefined,
  campaignId: string | undefined,
  settings: CampaignConversationSettings,
): Promise<void> {
  const askText = settings.askNameText.replace(
    '{timeout}',
    String(settings.nameTimeoutMinutes),
  );
  console.log(`[SEND] ask_name campaign=${campaignId ?? ''} to=${senderPhone}`);
  storage.markCampaignResultStage(campaignResultId, 'ask_name_sending', `${whatsappName}${suffix}`);
  await sendBotMessage(transport, senderJid, askText);
  storage.markCampaignResultStage(campaignResultId, 'ask_name_sent', `${whatsappName}${suffix}`);
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'ask_name_sent',
      label: askText.slice(0, 120),
    });
  }
  console.log(`[SEND_OK] ask_name campaign=${campaignId ?? ''} to=${senderPhone}`);

  const timeoutHandle = setTimeout(() => {
    void (async () => {
      try {
        conversationState.remove(senderJid);
        const finalName = `${whatsappName}${suffix}`;
        console.log(`\n   Timeout - saving ${senderPhone} as "${finalName}"`);
        storage.markCampaignResultStage(campaignResultId, 'name_timeout_saving', finalName);
        await queueAndReply(
          transport,
          storage,
          senderJid,
          senderPhone,
          finalName,
          campaignResultId,
          settings.replyText,
          settings.followupMessages,
          settings.decisionFlow,
          campaignId,
          {
            enabled: settings.humanHandoffEnabled,
            text: settings.humanHandoffText,
            phone: settings.humanHandoffPhone,
            decisionTimeoutMinutes: settings.decisionTimeoutMinutes,
            decisionTimeoutText: settings.decisionTimeoutText,
          },
          {
            links: settings.completionLinks,
            fileIds: settings.completionFileIds,
            contactCard: contactCardFromSettings(settings),
            contactCardPlacement: settings.contactCardPlacement,
            contactCardIntroText: settings.contactCardIntroText,
            contactCardWaitForConfirmation: settings.contactCardWaitForConfirmation,
            contactCardConfirmationTimeoutMinutes: settings.contactCardConfirmationTimeoutMinutes,
          },
        );
      } catch (err) {
        logTimerError('name timeout', err);
      }
    })();
  }, settings.nameTimeoutMinutes * 60 * 1000);

  conversationState.set(senderJid, {
    kind: 'name',
    senderJid,
    senderPhone,
    campaignResultId,
    campaignId,
    replyText: settings.replyText,
    completionLinks: settings.completionLinks,
    completionFileIds: settings.completionFileIds,
    sendContactCard: settings.sendContactCard,
    contactCardPlacement: settings.contactCardPlacement,
    contactCardName: settings.contactCardName,
    contactCardPhone: settings.contactCardPhone,
    contactCardEmail: settings.contactCardEmail,
    contactCardOrganization: settings.contactCardOrganization,
    contactCardIntroText: settings.contactCardIntroText,
    contactCardWaitForConfirmation: settings.contactCardWaitForConfirmation,
    contactCardConfirmationTimeoutMinutes: settings.contactCardConfirmationTimeoutMinutes,
    followupMessages: settings.followupMessages,
    decisionFlow: settings.decisionFlow,
    humanHandoffEnabled: settings.humanHandoffEnabled,
    humanHandoffText: settings.humanHandoffText,
    humanHandoffPhone: settings.humanHandoffPhone,
    nameTimeoutMinutes: settings.nameTimeoutMinutes,
    decisionTimeoutMinutes: settings.decisionTimeoutMinutes,
    decisionTimeoutText: settings.decisionTimeoutText,
    suffix,
    whatsappName,
    timestamp: Date.now(),
    timeoutHandle,
  });
}

function schedulePreNamePromptTimeout(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  whatsappName: string,
  suffix: string,
  campaignResultId: string | undefined,
  campaignId: string | undefined,
  settings: CampaignConversationSettings,
  timeoutMinutes: number,
): NodeJS.Timeout {
  return setTimeout(() => {
    void (async () => {
      try {
        if (settings.preNamePromptAutoContinue === false) {
          console.log(`[PRE_NAME_TIMEOUT] auto_continue_disabled campaign=${campaignId ?? ''} phone=${senderPhone}`);
          storage.markCampaignResultStage(campaignResultId, 'pre_name_timeout_blocked', `${whatsappName}${suffix}`);
          return;
        }
        console.log(`[PRE_NAME_AUTO_CONTINUE] campaign=${campaignId ?? ''} phone=${senderPhone}`);
        storage.markCampaignResultStage(campaignResultId, 'pre_name_auto_continue', `${whatsappName}${suffix}`);
        if (campaignId) {
          storage.recordCampaignEvent({
            campaignId,
            campaignResultId,
            phone: senderPhone,
            type: 'pre_name_auto_continue',
            label: 'auto continue',
          });
        }
        await askForContactName(
          transport,
          storage,
          senderJid,
          senderPhone,
          whatsappName,
          suffix,
          campaignResultId,
          campaignId,
          settings,
        );
      } catch (err) {
        logTimerError('pre-name prompt timeout', err);
      }
    })();
  }, timeoutMinutes * 60 * 1000);
}

function keepPreNamePromptRetry(
  state: Extract<ReturnType<typeof conversationState.get>, { kind: 'pre-name-prompt' }>,
  transport: WhatsAppTransport,
  storage: Storage,
  delayMs: number,
): void {
  const timeoutHandle = setTimeout(() => {
    void (async () => {
      try {
        console.log(`[SEND_RETRY] ask_name campaign=${state.campaignId ?? ''} to=${state.senderPhone}`);
        await askForContactName(
          transport,
          storage,
          state.senderJid,
          state.senderPhone,
          state.whatsappName,
          state.suffix,
          state.campaignResultId,
          state.campaignId,
          {
            askNameEnabled: true,
            askNameText: state.askNameText,
            nameTimeoutMinutes: state.nameTimeoutMinutes ?? 5,
            replyText: state.replyText,
            completionLinks: state.completionLinks,
            completionFileIds: state.completionFileIds,
            sendContactCard: state.sendContactCard,
            contactCardPlacement: state.contactCardPlacement,
            contactCardName: state.contactCardName,
            contactCardPhone: state.contactCardPhone,
            contactCardEmail: state.contactCardEmail,
            contactCardOrganization: state.contactCardOrganization,
            contactCardIntroText: state.contactCardIntroText,
            contactCardWaitForConfirmation: state.contactCardWaitForConfirmation,
            contactCardConfirmationTimeoutMinutes: state.contactCardConfirmationTimeoutMinutes,
            followupMessages: state.followupMessages,
            decisionFlow: state.decisionFlow,
            humanHandoffEnabled: state.humanHandoffEnabled,
            humanHandoffText: state.humanHandoffText,
            humanHandoffPhone: state.humanHandoffPhone,
            decisionTimeoutMinutes: state.decisionTimeoutMinutes,
            decisionTimeoutText: state.decisionTimeoutText,
          },
        );
      } catch (err) {
        logTimerError('ask name retry', err);
      }
    })();
  }, delayMs);
  conversationState.set(state.senderJid, { ...state, timeoutHandle });
}

async function queueAndReply(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  contactName: string,
  campaignResultId?: string,
  replyText = storage.getAdminSettings().replyText,
  followupMessages = storage.getAdminSettings().followupMessages,
  decisionFlow: DecisionFlowStep[] = [],
  campaignId?: string,
  humanHandoff: CampaignReplyBehavior = {},
  completion: CompletionDelivery = {},
): Promise<void> {
  storage.markCampaignResultStage(campaignResultId, 'contact_queueing', contactName);
  const job = storage.enqueueContactSave(senderPhone, contactName, campaignResultId);
  if (job) {
    storage.markCampaignResultStage(campaignResultId, 'contact_queued', contactName);
    console.log(`   Contact queued for background save/update: ${senderPhone}`);
  }

  const contactCardPlacement = completion.contactCardPlacement ?? 'after_completion';
  const finalReplyText = replyText.trim();
  if (finalReplyText && contactCardPlacement !== 'before_questions') {
    await runReplyStep('completion text', async () => {
      await sendBotMessage(transport, senderJid, finalReplyText);
      console.log('   Text reply sent.');
      if (campaignId) {
        storage.recordCampaignEvent({
          campaignId,
          campaignResultId,
          phone: senderPhone,
          type: 'completion_sent',
          label: finalReplyText.slice(0, 120),
        });
      }
    });
  }

  await runReplyStep('completion links', async () => {
    await sendCompletionLinks(transport, storage, senderJid, completion.links, campaignId, campaignResultId, senderPhone);
  });
  await runReplyStep('completion files', async () => {
    await sendCompletionFiles(transport, storage, senderJid, completion.fileIds, campaignId, campaignResultId, senderPhone);
  });
  const sendContactCardAndMaybeWait = async (label: string): Promise<boolean> => {
    const introText = completion.contactCardIntroText?.trim();
    if (introText) {
      await runReplyStep(`${label} intro`, async () => {
        await sendBotMessage(transport, senderJid, introText);
      });
    }
    await runReplyStep(label, async () => {
      await sendCompletionContactCard(transport, storage, senderJid, completion.contactCard, campaignId, campaignResultId, senderPhone);
    });
    if (!completion.contactCard?.enabled || !completion.contactCardWaitForConfirmation) return false;
    waitForContactCardConfirmation(
      transport,
      storage,
      senderJid,
      senderPhone,
      campaignResultId,
      followupMessages,
      decisionFlow,
      campaignId,
      humanHandoff,
      completion.contactCardConfirmationTimeoutMinutes,
    );
    return true;
  };

  if (contactCardPlacement === 'before_questions') {
    if (await sendContactCardAndMaybeWait('contact card before follow-up')) return;
  } else {
    if (await sendContactCardAndMaybeWait('contact card')) return;
  }

  await continueAfterContactCard(
    transport,
    storage,
    senderJid,
    senderPhone,
    campaignResultId,
    followupMessages,
    decisionFlow,
    campaignId,
    humanHandoff,
  );
}

function waitForContactCardConfirmation(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  campaignResultId: string | undefined,
  followupMessages: string[],
  decisionFlow: DecisionFlowStep[],
  campaignId: string | undefined,
  humanHandoff: CampaignReplyBehavior,
  timeoutMinutes = 30,
): void {
  const minutes = Math.min(Math.max(Math.round(timeoutMinutes || 30), 1), 1440);
  const timeoutHandle = setTimeout(() => {
    continueAfterContactCard(
      transport,
      storage,
      senderJid,
      senderPhone,
      campaignResultId,
      followupMessages,
      decisionFlow,
      campaignId,
      humanHandoff,
    ).catch((err) => logTimerError('contact card confirmation timeout', err));
    conversationState.remove(senderJid);
  }, minutes * 60 * 1000);
  conversationState.set(senderJid, {
    kind: 'contact-card-confirmation',
    senderJid,
    senderPhone,
    campaignId,
    campaignResultId,
    followupMessages,
    decisionFlow,
    humanHandoffEnabled: humanHandoff.enabled,
    humanHandoffText: humanHandoff.text,
    humanHandoffPhone: humanHandoff.phone,
    decisionTimeoutMinutes: humanHandoff.decisionTimeoutMinutes,
    decisionTimeoutText: humanHandoff.decisionTimeoutText,
    contactCardConfirmationTimeoutMinutes: minutes,
    timestamp: Date.now(),
    timeoutHandle,
  });
}

async function continueAfterContactCard(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  senderPhone: string,
  campaignResultId: string | undefined,
  followupMessages: string[],
  decisionFlow: DecisionFlowStep[],
  campaignId: string | undefined,
  humanHandoff: CampaignReplyBehavior,
): Promise<void> {
  for (const followupText of followupMessages) {
    const text = followupText.trim();
    if (!text) continue;
    await runReplyStep('follow-up text', async () => {
      await sendBotMessage(transport, senderJid, text);
      console.log('   Follow-up reply sent.');
    });
  }

  await runReplyStep('decision flow start', async () => {
    await sendDecisionFlowStart(
      transport,
      storage,
      senderJid,
      decisionFlow,
      campaignId,
      campaignResultId,
      senderPhone,
      humanHandoff,
    );
  });
}
async function runReplyStep(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(`   Failed to send ${label}:`, err);
  }
}

async function sendCompletionLinks(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  links: CompletionLink[] | undefined,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
): Promise<void> {
  const cleanLinks = (links ?? []).filter((link) => link.url?.trim());
  if (!cleanLinks.length) return;
  const text = cleanLinks
    .map((link) => `${link.label?.trim() || link.url}\n${link.url}`)
    .join('\n\n');
  await sendBotMessage(transport, senderJid, text);
  console.log('   Completion links sent.');
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'completion_link_sent',
      label: String(cleanLinks.length),
    });
  }
}

function contactCardFromSettings(settings: {
  sendContactCard?: boolean;
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardIntroText?: string;
}): CompletionContactCard | undefined {
  if (!settings.sendContactCard) return undefined;
  return {
    enabled: true,
    name: settings.contactCardName,
    phone: settings.contactCardPhone,
    email: settings.contactCardEmail,
    organization: settings.contactCardOrganization,
  };
}

async function sendCompletionFiles(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  fileIds: string[] | undefined,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
): Promise<void> {
  for (const fileId of fileIds ?? []) {
    try {
      await sendDecisionFile(
        transport,
        storage,
        senderJid,
        fileId,
        undefined,
        false,
        campaignId,
        campaignResultId,
        senderPhone,
        { sent: 'completion_file_sent', failed: 'completion_file_failed' },
      );
    } catch (err) {
      console.error(`   Completion file failed hard: ${fileId}`, err);
    }
  }
}

async function sendCompletionContactCard(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  contactCard: CompletionContactCard | undefined,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
): Promise<void> {
  if (!contactCard?.enabled) return;
  const name = (contactCard.name || 'Contact').trim();
  const phone = normalizeVCardPhone((contactCard.phone || '').trim());
  const email = (contactCard.email || '').trim();
  const organization = (contactCard.organization || '').trim();
  if (!name && !phone && !email) return;

  fs.mkdirSync(config.UPLOADS_PATH, { recursive: true });
  const safeFileName = [
    'contact-card',
    campaignId || 'default',
    campaignResultId || senderPhone || 'contact',
  ].join('-').replace(/[^a-z0-9.-]+/gi, '-').slice(0, 120) + '.vcf';
  const filePath = path.join(config.UPLOADS_PATH, safeFileName);
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeVCardValue(name || phone || email || 'Contact')}`,
    `N:${escapeVCardValue(name || phone || email || 'Contact')};;;;`,
  ];
  if (phone) lines.push(`TEL;TYPE=CELL,VOICE:${escapeVCardValue(phone)}`);
  if (email) lines.push(`EMAIL:${escapeVCardValue(email)}`);
  if (organization) lines.push(`ORG:${escapeVCardValue(organization)}`);
  lines.push('END:VCARD');
  fs.writeFileSync(filePath, `${lines.join('\r\n')}\r\n`, 'utf8');

  const displayFileName = `${(name || 'contact').replace(/[\/:*?"<>|]+/g, '-').slice(0, 80)}.vcf`;
  await sendFileWithRetry(transport, senderJid, filePath, undefined, {}, displayFileName);
  console.log('   Contact card sent.');
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'completion_file_sent',
      label: `contact card: ${name}`.slice(0, 120),
    });
  }
}

function normalizeVCardPhone(value: string): string {
  const ascii = value.replace(/[^\x00-\x7F]/g, '');
  const clean = ascii.replace(/[^\d+]/g, '');
  if (!clean) return '';
  if (clean.startsWith('+')) return clean;
  const digits = clean.replace(/\D/g, '');
  if (digits.startsWith('972')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 9) return `+972${digits.slice(1)}`;
  return digits ? `+${digits}` : '';
}

function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

async function handleDecisionReply(
  answer: string,
  flow: DecisionFlowStep[],
  stepId: string,
  senderJid: string,
  storage: Storage,
  transport: WhatsAppTransport,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  const step = flow.find((item) => item.id === stepId);
  if (!step || (step.kind !== 'question' && step.kind !== 'score_question')) {
    conversationState.remove(senderJid);
    return;
  }

  const normalized = normalizeDecisionAnswer(answer);
  const option = step.options?.find((item, index) => {
    const optionId = String(item.id ?? '').trim().toLowerCase();
    return normalized === String(index + 1) ||
      Boolean(optionId && normalized === optionId) ||
      normalized === normalizeDecisionAnswer(item.text);
  });

  if (!option && humanHandoff.enabled) {
    await sendHumanHandoff(transport, storage, senderJid, humanHandoff, campaignId, campaignResultId, senderPhone);
    conversationState.remove(senderJid);
    return;
  }

  if (!option) {
    await sendBotMessage(transport, senderJid, `לא הבנתי את הבחירה.\n\n${formatQuestion(step)}`);
    return;
  }

  conversationState.remove(senderJid);
  if (step.kind === 'score_question') {
    const score = scoreForOption(option, step);
    storage.recordScoreAnswer(campaignResultId, {
      stepId: step.id,
      question: step.text,
      optionId: option.id,
      answerText: option.text,
      score,
    });
    if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'score_answered',
        label: `${option.text} (${score})`,
      });
    }
  }
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'step_answered',
      label: option.text,
    });
  }
  if (option.fileId) {
    await sendDecisionFile(
      transport,
      storage,
      senderJid,
      option.fileId,
      option.endText?.trim(),
      option.fileAsSticker,
      campaignId,
      campaignResultId,
      senderPhone,
    );
  } else if (option.endText?.trim()) {
    await sendBotMessage(transport, senderJid, option.endText.trim());
    console.log('   Decision reply sent.');
  }

  if (option.nextStepId) {
    await sendDecisionStep(transport, storage, senderJid, flow, option.nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
  } else if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'completed',
      label: 'סיום תהליך',
    });
    keepHumanHandoffOpen(senderJid, campaignId, campaignResultId, senderPhone, humanHandoff);
  }
}

async function handleWaitReply(
  answer: string,
  flow: DecisionFlowStep[],
  stepId: string,
  senderJid: string,
  storage: Storage,
  transport: WhatsAppTransport,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  const step = flow.find((item) => item.id === stepId);
  conversationState.remove(senderJid);
  if (!step || step.kind !== 'wait_reply') return;
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'step_answered',
      label: answer.slice(0, 120),
    });
  }
  if (step.nextStepId) {
    await sendDecisionStep(transport, storage, senderJid, flow, step.nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
  } else if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'completed',
      label: 'סיום תהליך',
    });
    keepHumanHandoffOpen(senderJid, campaignId, campaignResultId, senderPhone, humanHandoff);
  }
}

async function sendDecisionFlowStart(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  flow: DecisionFlowStep[],
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  const first = flow.find((step) => step.text.trim());
  if (!first) return;
  await sendDecisionStep(transport, storage, senderJid, flow, first.id, campaignId, campaignResultId, senderPhone, humanHandoff);
}

async function sendDecisionStep(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  flow: DecisionFlowStep[],
  stepId: string,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  const step = flow.find((item) => item.id === stepId);
  if (!step?.text.trim()) return;

  if (step.kind === 'wait_reply') {
    await sendBotMessage(transport, senderJid, step.text.trim());
    console.log('   Wait-for-reply message sent.');
    if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'step_sent',
        label: step.text.slice(0, 120),
      });
    }
    const timeoutMinutes = step.timeoutMinutes && step.timeoutMinutes > 0
      ? step.timeoutMinutes
      : (humanHandoff.decisionTimeoutMinutes && humanHandoff.decisionTimeoutMinutes > 0
        ? humanHandoff.decisionTimeoutMinutes
        : DECISION_REPLY_TIMEOUT_MS / 60_000);
    const timeoutHandle = setTimeout(() => {
      void (async () => {
        try {
          conversationState.remove(senderJid);
          console.log(`   Wait-reply timeout - cleared pending state for ${senderJid}.`);
          await sendDecisionTimeoutAction(transport, storage, senderJid, step, humanHandoff.decisionTimeoutText, campaignId, campaignResultId, senderPhone);
        } catch (err) {
          logTimerError('wait-reply timeout', err);
        }
      })();
    }, timeoutMinutes * 60 * 1000);
    conversationState.set(senderJid, {
      kind: 'wait-reply',
      senderJid,
      senderPhone,
      campaignId,
      campaignResultId,
      flow,
      stepId: step.id,
      humanHandoffEnabled: humanHandoff.enabled,
      humanHandoffText: humanHandoff.text,
      humanHandoffPhone: humanHandoff.phone,
      decisionTimeoutMinutes: humanHandoff.decisionTimeoutMinutes,
      decisionTimeoutText: humanHandoff.decisionTimeoutText,
      timestamp: Date.now(),
      timeoutHandle,
    });
    return;
  }

  if (step.kind === 'message') {
    await sendBotMessage(transport, senderJid, step.text.trim());
    console.log('   Decision message sent.');
    if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'step_sent',
        label: step.text.slice(0, 120),
      });
    }
    if (step.nextStepId) {
      await sendDecisionStep(transport, storage, senderJid, flow, step.nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
    } else if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'completed',
        label: 'סיום תהליך',
      });
      keepHumanHandoffOpen(senderJid, campaignId, campaignResultId, senderPhone, humanHandoff);
    }
    return;
  }

  if (step.kind === 'score_question' && !step.options?.length) {
    step.options = buildDefaultScoreOptions(step.id);
  }

  const presentation = step.presentation ?? 'buttons';
  let sentInteractive = false;
  if (presentation === 'list' && transport.sendInteractiveList && step.options?.length) {
    try {
      await waitBeforeBotReply();
      await transport.sendInteractiveList(
        senderJid,
        step.text.trim(),
        'בחר/י תשובה',
        step.options.slice(0, 10).map((option) => ({ id: option.id, text: option.text })),
      );
      sentInteractive = true;
    } catch (err) {
      console.warn('   Interactive decision list failed, falling back to text:', err);
    }
  }
  if (presentation === 'buttons' && transport.sendInteractiveButtons && step.options?.length) {
    try {
      await waitBeforeBotReply();
      await transport.sendInteractiveButtons(
        senderJid,
        step.text.trim(),
        step.options.slice(0, 3).map((option) => ({ id: option.id, text: option.text })),
      );
      sentInteractive = true;
    } catch (err) {
      console.warn('   Interactive decision question failed, falling back to text:', err);
    }
  }
  if (!sentInteractive) {
    await sendBotMessage(transport, senderJid, formatQuestion(step));
  }
  console.log('   Decision question sent.');
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'step_sent',
      label: step.text.slice(0, 120),
    });
  }
  const timeoutMinutes = step.timeoutMinutes && step.timeoutMinutes > 0
    ? step.timeoutMinutes
    : (humanHandoff.decisionTimeoutMinutes && humanHandoff.decisionTimeoutMinutes > 0
      ? humanHandoff.decisionTimeoutMinutes
      : DECISION_REPLY_TIMEOUT_MS / 60_000);
  const timeoutHandle = setTimeout(() => {
    void (async () => {
      try {
        conversationState.remove(senderJid);
        console.log(`   Decision reply timeout - cleared pending state for ${senderJid}.`);
        await sendDecisionTimeoutAction(transport, storage, senderJid, step, humanHandoff.decisionTimeoutText, campaignId, campaignResultId, senderPhone);
      } catch (err) {
        logTimerError('decision timeout', err);
      }
    })();
  }, timeoutMinutes * 60 * 1000);
  conversationState.set(senderJid, {
    kind: 'decision',
    senderJid,
    senderPhone,
    campaignId,
    campaignResultId,
    flow,
    stepId: step.id,
    humanHandoffEnabled: humanHandoff.enabled,
    humanHandoffText: humanHandoff.text,
    humanHandoffPhone: humanHandoff.phone,
    decisionTimeoutMinutes: humanHandoff.decisionTimeoutMinutes,
    decisionTimeoutText: humanHandoff.decisionTimeoutText,
    timestamp: Date.now(),
    timeoutHandle,
  });
}

async function sendHumanHandoff(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  humanHandoff: CampaignReplyBehavior = {},
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
): Promise<void> {
  if (!humanHandoff.enabled) return;
  const handoffText = formatHumanHandoffText(humanHandoff.text, humanHandoff.phone);
  if (handoffText) await sendBotMessage(transport, senderJid, handoffText);
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'human_handoff',
      label: 'מענה אנושי',
    });
  }
}

function keepHumanHandoffOpen(
  senderJid: string,
  campaignId: string | undefined,
  campaignResultId: string | undefined,
  senderPhone: string | undefined,
  humanHandoff: CampaignReplyBehavior = {},
): void {
  if (!humanHandoff.enabled) return;
  const timeoutHandle = setTimeout(() => {
    conversationState.remove(senderJid);
  }, HUMAN_HANDOFF_WINDOW_MS);
  conversationState.set(senderJid, {
    kind: 'handoff',
    senderJid,
    senderPhone,
    campaignId,
    campaignResultId,
    humanHandoffEnabled: humanHandoff.enabled,
    humanHandoffText: humanHandoff.text,
    humanHandoffPhone: humanHandoff.phone,
    timestamp: Date.now(),
    timeoutHandle,
  });
}

async function sendDecisionTimeoutAction(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  step: DecisionFlowStep,
  defaultTimeoutText?: string,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
): Promise<void> {
  const caption = step.timeoutText?.trim() || defaultTimeoutText?.trim();
  if (step.timeoutFileId) {
    await sendDecisionFile(
      transport,
      storage,
      senderJid,
      step.timeoutFileId,
      caption,
      step.timeoutFileAsSticker,
      campaignId,
      campaignResultId,
      senderPhone,
    );
    return;
  }
  if (caption) {
    await sendBotMessage(transport, senderJid, caption);
    console.log('   Decision timeout message sent.');
  }
}

async function sendDecisionFile(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  fileId: string,
  caption?: string,
  asSticker?: boolean,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  eventTypes: { sent: 'file_sent' | 'completion_file_sent'; failed: 'file_failed' | 'completion_file_failed' } = { sent: 'file_sent', failed: 'file_failed' },
): Promise<void> {
  const file = storage.getUploadedFile(fileId);
  if (file && transport.sendFile) {
    const canSendAsSticker = Boolean(asSticker && file.mimeType.startsWith('image/'));
    const filePath = path.join(config.UPLOADS_PATH, file.filename);
    try {
      await sendFileWithRetry(
        transport,
        senderJid,
        filePath,
        caption,
        { asSticker: canSendAsSticker },
        file.originalName,
      );
      console.log(canSendAsSticker ? '   Decision sticker sent.' : '   Decision file sent.');
      if (campaignId) {
        storage.recordCampaignEvent({
          campaignId,
          campaignResultId,
          phone: senderPhone,
          type: eventTypes.sent,
          label: file.originalName,
        });
      }
    } catch (err) {
      console.error(`   Decision file failed: ${file.originalName}`, err);
      if (campaignId) {
        storage.recordCampaignEvent({
          campaignId,
          campaignResultId,
          phone: senderPhone,
          type: eventTypes.failed,
          label: file.originalName,
        });
      }
      await sendFileFallback(transport, senderJid, caption);
    }
  } else {
    if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: eventTypes.failed,
        label: file?.originalName || fileId,
      });
    }
    await sendFileFallback(transport, senderJid, caption);
    console.warn(`   Decision file unavailable: ${fileId}`);
  }
}

async function sendFileFallback(
  transport: WhatsAppTransport,
  senderJid: string,
  caption?: string,
): Promise<void> {
  try {
    await sendBotMessage(
      transport,
      senderJid,
      formatFileFailureFallback(caption),
    );
  } catch (err) {
    console.error('   Failed to send file fallback text:', err);
  }
}

function formatFileFailureFallback(caption?: string): string {
  const failureText = 'הקובץ לא נשלח כרגע. אפשר לבקש אותו שוב בהודעה חוזרת.';
  const cleanCaption = caption?.trim();
  return cleanCaption ? `${cleanCaption}\n\n${failureText}` : failureText;
}

async function sendFileWithRetry(
  transport: WhatsAppTransport,
  to: string,
  filePath: string,
  caption: string | undefined,
  options: { asSticker?: boolean },
  label: string,
): Promise<void> {
  if (!transport.sendFile) throw new Error('WhatsApp transport does not support files.');
  await waitBeforeBotReply();
  console.log(`[SEND] file "${label}"`);
  try {
    await transport.sendFile(to, filePath, caption, options);
    console.log(`[SEND_OK] file "${label}"`);
    return;
  } catch (err) {
    console.warn(`[SEND_RETRY] file "${label}" after failure:`, err);
  }

  await sleep(FILE_SEND_RETRY_DELAY_MS);
  await waitBeforeBotReply();
  try {
    await transport.sendFile(to, filePath, caption, options);
    console.log(`[SEND_OK] file "${label}" after retry`);
  } catch (err) {
    console.error(`[SEND_FAIL] file "${label}"`, err);
    throw err;
  }
}

function formatQuestion(step: DecisionFlowStep): string {
  const options = (step.options ?? [])
    .map((option: DecisionFlowOption, index) => `${index + 1}. ${option.text}`)
    .join('\n');
  return options ? `${step.text.trim()}\n\n${options}` : step.text.trim();
}

function normalizeDecisionAnswer(answer: string): string {
  return answer
    .trim()
    .toLowerCase()
    .replace(/^\u05ea\u05e9\u05d5\u05d1\u05d4\s+/u, '')
    .replace(/[.)\]\s]+$/u, '')
    .trim();
}

function buildDefaultScoreOptions(stepId: string): DecisionFlowOption[] {
  return [1, 2, 3].map((score) => ({
    id: `${stepId}-${score}`,
    text: String(score),
    score,
  }));
}

function scoreForOption(option: DecisionFlowOption, step: DecisionFlowStep): number {
  if (typeof option.score === 'number' && Number.isFinite(option.score)) return option.score;
  const index = (step.options ?? []).findIndex((item) => item.id === option.id);
  return index >= 0 ? index + 1 : Number(option.text.match(/\d+/)?.[0] ?? 0);
}

function formatHumanHandoffText(text?: string, phone?: string): string {
  const base = (text || 'אני מענה אוטומטי.\nלשאלות נוספות אפשר לעבור לשיחה אנושית כאן:\n[מעבר ל-WhatsApp]').trim();
  const cleanPhone = normalizeHumanHandoffPhone(phone);
  if (!cleanPhone) return base;
  const link = `https://wa.me/${cleanPhone}`;
  return base.includes('[מעבר ל-WhatsApp]')
    ? base.replace('[מעבר ל-WhatsApp]', link)
    : `${base}\n${link}`;
}

function normalizeHumanHandoffPhone(phone?: string): string {
  const raw = String(phone || '').replace(/[^\d+]/g, '');
  if (!raw) return '';
  if (raw.startsWith('+')) return raw.slice(1);
  if (raw.startsWith('00')) return raw.slice(2);
  if (raw.startsWith('0') && raw.length >= 9) return `972${raw.slice(1)}`;
  return raw;
}
