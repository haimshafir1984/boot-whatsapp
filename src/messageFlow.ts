import { config } from './config';
import fs from 'fs';
import path from 'path';
import { conversationState, PersistablePendingConversation } from './conversationState';
import { CampaignConversationSettings, CampaignScoreAnswer, CompletionLink, DecisionFlowOption, DecisionFlowStep, ScoreResultRule, Storage } from './storage';
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
const CONTACT_CARD_NEXT_STEP_DELAY_MS = Math.max(BOT_REPLY_DELAY_MS, 4000);
const FLOW_STEP_FAILURE_CONTINUE_DELAY_MS = 60_000;

interface CampaignReplyBehavior {
  enabled?: boolean;
  text?: string;
  phone?: string;
  decisionTimeoutMinutes?: number;
  decisionTimeoutText?: string;
  decisionTimeoutMode?: 'message' | 'flow';
  decisionTimeoutNextStepId?: string;
  timeoutFlowStarted?: boolean;
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
  contactCards?: CompletionContactCard[];
  contactCard?: CompletionContactCard;
  contactCardSendMode?: 'separate' | 'combined';
  contactCardPlacement?: 'after_completion' | 'before_questions';
  contactCardIntroText?: string;
  contactCardWaitForConfirmation?: boolean;
  contactCardConfirmationTimeoutMinutes?: number;
}

type RestoredTimeoutTransportResolver = () => WhatsAppTransport | null | undefined;

const RESTORED_TIMEOUT_RETRY_MS = 60_000;

function logTimerError(label: string, err: unknown): void {
  console.error(`[TIMER] ${label} failed:`, err);
}

function restoredConversationTtlMs(state: PersistablePendingConversation): number {
  if (state.kind === 'name') {
    return Math.max(1, state.nameTimeoutMinutes ?? 5) * 60 * 1000;
  }
  if (state.kind === 'pre-name-prompt') {
    return Math.max(1, state.preNamePromptTimeoutMinutes ?? 1) * 60 * 1000;
  }
  if (state.kind === 'contact-card-confirmation') {
    const minutes = state.contactCardConfirmationTimeoutMinutes || 30;
    return Math.max(1, minutes) * 60 * 1000;
  }
  if (state.kind === 'decision' || state.kind === 'wait-reply') {
    const step = state.flow.find((item) => item.id === state.stepId);
    const minutes = step?.timeoutMinutes || state.decisionTimeoutMinutes || 30;
    return Math.max(1, minutes) * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
}

export function scheduleRestoredConversationTimeout(
  storage: Storage,
  getTransport: RestoredTimeoutTransportResolver,
  jid: string,
  state: PersistablePendingConversation,
): NodeJS.Timeout | undefined {
  const ageMs = Date.now() - Number(state.timestamp || 0);
  const remainingMs = Math.max(0, restoredConversationTtlMs(state) - ageMs);

  const schedule = (delayMs: number): NodeJS.Timeout => setTimeout(() => {
    void (async () => {
      try {
        if (state.kind === 'decision' || state.kind === 'wait-reply') {
          const transport = getTransport();
          if (!transport) {
            throw new Error('WhatsApp transport is not ready for restored timeout.');
          }
          const step = state.flow.find((item) => item.id === state.stepId);
          if (!step) {
            conversationState.remove(jid);
            return;
          }
          conversationState.remove(jid);
          await handleDecisionTimeout(
            transport,
            storage,
            jid,
            step,
            state.decisionTimeoutText,
            state.campaignId,
            state.campaignResultId,
            state.senderPhone,
            state.kind,
            state.flow,
            {
              decisionTimeoutMode: state.decisionTimeoutMode,
              decisionTimeoutNextStepId: state.decisionTimeoutNextStepId,
              timeoutFlowStarted: state.timeoutFlowStarted,
            },
          );
          return;
        }

        conversationState.remove(jid);
        console.log(`Restored conversation expired: ${jid}`);
      } catch (err) {
        logTimerError('restored conversation timeout', err);
        const current = conversationState.get(jid);
        if (!current) return;
        current.timeoutHandle = schedule(RESTORED_TIMEOUT_RETRY_MS);
        conversationState.set(jid, current);
      }
    })();
  }, delayMs);

  return schedule(remainingMs);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitBeforeBotReply(delayMs = BOT_REPLY_DELAY_MS): Promise<void> {
  if (delayMs > 0) await sleep(delayMs);
}

async function sendBotMessage(transport: WhatsAppTransport, to: string, text: string, delayMs = BOT_REPLY_DELAY_MS): Promise<void> {
  const cleanText = text.trim();
  if (!cleanText) return;

  let lastError: unknown;
  for (let attempt = 1; attempt <= TEXT_SEND_ATTEMPTS; attempt += 1) {
    await waitBeforeBotReply(delayMs);
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

  await markIncomingMessageReadIfEnabled(message, storage, transport, source);

  try {
    await handleMessage(message, storage, transport, source);
  } catch (err) {
    console.error(`[MSG] handler failed via ${source}:`, err);
  }
}

async function markIncomingMessageReadIfEnabled(
  message: IncomingWhatsAppMessage,
  storage: Storage,
  transport: WhatsAppTransport,
  source: WhatsAppMessageSource,
): Promise<void> {
  if (!storage.getAdminSettings().readReceiptsEnabled) return;
  if (!transport.markRead) {
    console.warn(`[READ_RECEIPT] markRead is not supported via ${source}.`);
    return;
  }
  try {
    await transport.markRead(message);
  } catch (err) {
    console.warn(`[READ_RECEIPT] markRead failed via ${source}:`, err);
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
  let pending = conversationState.get(senderJid) || conversationState.findByPhone(senderPhone);
  const activeCampaigns = storage.getActiveCampaigns();
  const trigger = message.body?.trim() ? detectTrigger(message.body, activeCampaigns) : { matched: false, campaignId: '', suffix: '', campaignName: '' };
  if (pending && trigger.matched && messageAgeMs <= MAX_TRIGGER_AGE_MS) {
    clearTimeout(pending.timeoutHandle);
    conversationState.remove(pending.senderJid);
    pending = undefined;
  }

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
            contactCards: pending.contactCards,
            contactCardSendMode: pending.contactCardSendMode,
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
            decisionTimeoutMode: pending.decisionTimeoutMode,
            decisionTimeoutNextStepId: pending.decisionTimeoutNextStepId,
            timeoutFlowStarted: pending.timeoutFlowStarted,
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

    let replyBody = message.body?.trim() ?? '';
    if (!replyBody && pending.kind === 'decision' && message.isButtonReply) {
      const pendingStep = pending.flow.find((item) => item.id === pending.stepId);
      const options = pendingStep?.kind === 'question' || pendingStep?.kind === 'score_question'
        ? (pendingStep.options ?? [])
        : [];
      if (options.length === 1) {
        replyBody = options[0].id || options[0].text;
        console.warn(`[META_BUTTON_FALLBACK] Empty button reply resolved to the only option for step=${pending.stepId} from=${senderJid}`);
      }
    }

    if (!replyBody) {
      console.log(`[MSG] non-text message ignored for pending ${pending.kind} via=${source} from=${senderJid}`);
      return;
    }

    if (pending.kind === 'decision') {
      await handleDecisionReply(
        replyBody,
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
          decisionTimeoutMode: pending.decisionTimeoutMode,
          decisionTimeoutNextStepId: pending.decisionTimeoutNextStepId,
          timeoutFlowStarted: pending.timeoutFlowStarted,
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
          decisionTimeoutMode: pending.decisionTimeoutMode,
          decisionTimeoutNextStepId: pending.decisionTimeoutNextStepId,
          timeoutFlowStarted: pending.timeoutFlowStarted,
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
          decisionTimeoutMode: pending.decisionTimeoutMode,
          decisionTimeoutNextStepId: pending.decisionTimeoutNextStepId,
          timeoutFlowStarted: pending.timeoutFlowStarted,
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
        decisionTimeoutMode: pending.decisionTimeoutMode,
        decisionTimeoutNextStepId: pending.decisionTimeoutNextStepId,
        timeoutFlowStarted: pending.timeoutFlowStarted,
      },
      {
        links: pending.completionLinks,
        fileIds: pending.completionFileIds,
        contactCards: contactCardsFromSettings(pending),
        contactCard: contactCardFromSettings(pending),
        contactCardSendMode: pending.contactCardSendMode,
        contactCardPlacement: pending.contactCardPlacement,
        contactCardIntroText: pending.contactCardIntroText,
        contactCardWaitForConfirmation: pending.contactCardWaitForConfirmation,
        contactCardConfirmationTimeoutMinutes: pending.contactCardConfirmationTimeoutMinutes,
      },
    );
    return;
  }

  if (message.isReaction) return;
  if (!message.body?.trim()) return;

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
  const campaignResult = storage.recordCampaignTrigger(trigger.campaignId, senderPhone, pushname, trigger.referralCode);
  if (trigger.referralCode && campaignResult.referredByCode) {
    storage.recordCampaignEvent({
      campaignId: campaign.id,
      campaignResultId: campaignResult.id,
      phone: senderPhone,
      type: 'referral_attributed',
      label: campaignResult.referredByName || campaignResult.referredByCode,
    });
  }

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
        contactCards: settings.contactCards,
        contactCardSendMode: settings.contactCardSendMode,
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
        preNamePromptTimeoutMinutes: timeoutMinutes,
        askNameText: settings.askNameText,
        decisionTimeoutMinutes: settings.decisionTimeoutMinutes,
        decisionTimeoutText: settings.decisionTimeoutText,
        decisionTimeoutMode: settings.decisionTimeoutMode,
        decisionTimeoutNextStepId: settings.decisionTimeoutNextStepId,
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
        decisionTimeoutMode: settings.decisionTimeoutMode,
        decisionTimeoutNextStepId: settings.decisionTimeoutNextStepId,
      },
      {
        links: settings.completionLinks,
        fileIds: settings.completionFileIds,
        contactCards: contactCardsFromSettings(settings),
        contactCard: contactCardFromSettings(settings),
        contactCardSendMode: settings.contactCardSendMode,
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
            decisionTimeoutMode: settings.decisionTimeoutMode,
            decisionTimeoutNextStepId: settings.decisionTimeoutNextStepId,
          },
          {
            links: settings.completionLinks,
            fileIds: settings.completionFileIds,
        contactCards: contactCardsFromSettings(settings),
            contactCard: contactCardFromSettings(settings),
            contactCardSendMode: settings.contactCardSendMode,
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
    contactCards: settings.contactCards,
    contactCardSendMode: settings.contactCardSendMode,
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
    decisionTimeoutMode: settings.decisionTimeoutMode,
    decisionTimeoutNextStepId: settings.decisionTimeoutNextStepId,
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
            contactCards: state.contactCards,
            contactCardSendMode: state.contactCardSendMode,
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
  const flowHasContactCard = decisionFlow.some((step) => step.kind === 'contact_card');
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
    const contactCards = contactCardsFromCompletion(completion);
    await runReplyStep(label, async () => {
      await sendCompletionContactCards(transport, storage, senderJid, contactCards, campaignId, campaignResultId, senderPhone, completion.contactCardSendMode);
    });
    if (!contactCards.length || !completion.contactCardWaitForConfirmation) return false;
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

  if (!flowHasContactCard) {
    if (contactCardPlacement === 'before_questions') {
      if (await sendContactCardAndMaybeWait('contact card before follow-up')) return;
    } else {
      if (await sendContactCardAndMaybeWait('contact card')) return;
    }
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
  contactIndex = 1,
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

function contactCardsFromSettings(settings: {
  sendContactCard?: boolean;
  contactCards?: CompletionContactCard[];
  contactCardSendMode?: 'separate' | 'combined';
  contactCardName?: string;
  contactCardPhone?: string;
  contactCardEmail?: string;
  contactCardOrganization?: string;
  contactCardIntroText?: string;
}): CompletionContactCard[] {
  if (!settings.sendContactCard) return [];
  const source = Array.isArray(settings.contactCards) && settings.contactCards.length
    ? settings.contactCards
    : [{
        name: settings.contactCardName,
        phone: settings.contactCardPhone,
        email: settings.contactCardEmail,
        organization: settings.contactCardOrganization,
      }];
  return uniqueContactCards(source
    .map((card) => ({
      enabled: true,
      name: card.name,
      phone: card.phone,
      email: card.email,
      organization: card.organization,
    }))
    .filter((card) => card.name || card.phone || card.email || card.organization))
    .slice(0, 2);
}

function contactCardFromSettings(settings: Parameters<typeof contactCardsFromSettings>[0]): CompletionContactCard | undefined {
  return contactCardsFromSettings(settings)[0];
}

function contactCardsFromCompletion(completion: CompletionDelivery): CompletionContactCard[] {
  const cards = Array.isArray(completion.contactCards) && completion.contactCards.length
    ? completion.contactCards
    : (completion.contactCard ? [completion.contactCard] : []);
  return uniqueContactCards(cards.filter((card) => card?.enabled && (card.name || card.phone || card.email || card.organization))).slice(0, 2);
}

function uniqueContactCards(cards: CompletionContactCard[]): CompletionContactCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = [card.name || '', card.phone || '', card.email || '', card.organization || '']
      .map((part) => part.trim().toLowerCase())
      .join('|');
    if (!key.replace(/\|/g, '')) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

async function sendCompletionContactCards(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  contactCards: CompletionContactCard[] | undefined,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  _sendMode: 'separate' | 'combined' = 'separate',
): Promise<void> {
  const cards = uniqueContactCards(contactCards ?? []).slice(0, 2);
  if (!cards.length) return;

  if (_sendMode === 'combined' && cards.length > 1 && transport.sendContactCards) {
    const combinedContacts = cards
      .filter((contactCard) => contactCard.enabled)
      .map((contactCard) => {
        const name = (contactCard.name || 'Contact').trim();
        const phone = normalizeVCardPhone((contactCard.phone || '').trim());
        const email = (contactCard.email || '').trim();
        const organization = (contactCard.organization || '').trim();
        if (!name && !phone && !email) return null;
        return {
          displayName: name || phone || email || 'Contact',
          vcard: buildVCard({ name, phone, email, organization }),
        };
      })
      .filter((contact): contact is { displayName: string; vcard: string } => Boolean(contact));
    if (combinedContacts.length > 1) {
      try {
        await waitBeforeBotReply();
        await transport.sendContactCards(senderJid, combinedContacts, combinedContacts.map((contact) => contact.displayName).join(', '));
        console.log('   Combined native contact card sent.');
        for (const contact of combinedContacts) {
          recordContactCardEvent(storage, campaignId, campaignResultId, senderPhone, `contact card: ${contact.displayName}`);
        }
        return;
      } catch (err) {
        console.warn('   Combined contact card failed, falling back to separate cards:', err);
      }
    }
  }

  for (const [index, contactCard] of cards.entries()) {
    await sendCompletionContactCard(transport, storage, senderJid, contactCard, campaignId, campaignResultId, senderPhone, index + 1);
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
  contactIndex = 1,
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
    String(contactIndex),
    name || phone || email || 'contact',
  ].join('-').replace(/[^a-z0-9.-]+/gi, '-').slice(0, 120) + '.vcf';
  const filePath = path.join(config.UPLOADS_PATH, safeFileName);
  const vcard = buildVCard({ name, phone, email, organization });
  fs.writeFileSync(filePath, vcard, 'utf8');

  const displayName = name || phone || email || 'Contact';
  const displayFileName = `${(displayName).replace(/[\/:*?"<>|]+/g, '-').slice(0, 80)}.vcf`;
  if (transport.sendContactCard) {
    try {
      await waitBeforeBotReply();
      await transport.sendContactCard(senderJid, vcard, displayName);
      console.log('   Native contact card sent.');
    } catch (err) {
      console.warn('   Native contact card failed, falling back to vCard file:', err);
      await sendFileWithRetry(transport, senderJid, filePath, undefined, {}, displayFileName);
      console.log('   Contact card file sent.');
    }
  } else {
    await sendFileWithRetry(transport, senderJid, filePath, undefined, {}, displayFileName);
    console.log('   Contact card file sent.');
  }
  recordContactCardEvent(storage, campaignId, campaignResultId, senderPhone, `contact card: ${name}`);
}

function recordContactCardEvent(
  storage: Storage,
  campaignId: string | undefined,
  campaignResultId: string | undefined,
  senderPhone: string | undefined,
  label: string,
): void {
  if (!campaignId) return;
  storage.recordCampaignEvent({
    campaignId,
    campaignResultId,
    phone: senderPhone,
    type: 'completion_file_sent',
    label: label.slice(0, 120),
  });
}

function buildVCard(contact: { name: string; phone: string; email: string; organization: string }): string {
  const displayName = contact.name || contact.phone || contact.email || 'Contact';
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeVCardValue(displayName)}`,
    `N:${escapeVCardValue(displayName)};;;;`,
  ];
  if (contact.phone) lines.push(`TEL;TYPE=CELL,VOICE:${escapeVCardValue(contact.phone)}`);
  if (contact.email) lines.push(`EMAIL:${escapeVCardValue(contact.email)}`);
  if (contact.organization) lines.push(`ORG:${escapeVCardValue(contact.organization)}`);
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
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
  if (campaignId && option.raffleEntry) {
    try {
      const stepNumber = flow.findIndex((item) => item.id === step.id) + 1;
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'raffle_entry',
        label: `\u05d6\u05db\u05d0\u05d5\u05ea \u05dc\u05d4\u05d2\u05e8\u05dc\u05d4 \u05e2\u05dc \u05e9\u05d9\u05ea\u05d5\u05e3 \u05e9\u05dc\u05d1 ${stepNumber}: ${option.text}`,
      });
    } catch (err) {
      // Eligibility reporting must never interrupt the participant's conversation.
      console.error('[RAFFLE] Could not record raffle entry:', err);
    }
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
  const first = flow.find(isSendableDecisionStep);
  if (!first) return;
  await sendDecisionStep(transport, storage, senderJid, flow, first.id, campaignId, campaignResultId, senderPhone, humanHandoff);
}

function isSendableDecisionStep(step: DecisionFlowStep | undefined): step is DecisionFlowStep {
  if (!step) return false;
  if (step.text.trim()) return true;
  if (step.kind === 'contact_card') return true;
  if (step.kind === 'message' && step.fileId) return true;
  return false;
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
  if (!step || !isSendableDecisionStep(step)) return;
  const stepDelayMs = Number.isFinite(step.delayMs) ? Math.max(0, step.delayMs ?? BOT_REPLY_DELAY_MS) : BOT_REPLY_DELAY_MS;

  if (step.kind === 'score_result') {
    await handleScoreResultStep(transport, storage, senderJid, flow, step, campaignId, campaignResultId, senderPhone, humanHandoff);
    return;
  }

  if (step.kind === 'wait_reply') {
    await sendBotMessage(transport, senderJid, step.text.trim(), stepDelayMs);
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
          await sendDecisionTimeoutAction(transport, storage, senderJid, step, humanHandoff.decisionTimeoutText, campaignId, campaignResultId, senderPhone, flow, humanHandoff);
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
      decisionTimeoutMode: humanHandoff.decisionTimeoutMode,
      decisionTimeoutNextStepId: humanHandoff.decisionTimeoutNextStepId,
      timeoutFlowStarted: humanHandoff.timeoutFlowStarted,
      timestamp: Date.now(),
      timeoutHandle,
    });
    return;
  }

  if (step.kind === 'referral_share') {
    await sendReferralShareStep(transport, storage, senderJid, flow, step, campaignId, campaignResultId, senderPhone, humanHandoff);
    return;
  }

  if (step.kind === 'contact_card') {
    let failed = false;
    try {
      const introText = step.text.trim();
      if (introText) {
        await sendBotMessage(transport, senderJid, introText, stepDelayMs);
        console.log('   Contact-card intro step sent.');
        if (campaignId) {
          storage.recordCampaignEvent({
            campaignId,
            campaignResultId,
            phone: senderPhone,
            type: 'step_sent',
            label: step.text.slice(0, 120),
          });
        }
      } else {
        await waitBeforeBotReply(stepDelayMs);
      }
      const campaign = campaignId ? storage.getCampaigns().find((item) => item.id === campaignId) : undefined;
      const settings = campaign ? storage.getCampaignConversationSettings(campaign) : storage.getAdminSettings();
      await sendCompletionContactCards(transport, storage, senderJid, contactCardsFromSettings(settings), campaignId, campaignResultId, senderPhone, settings.contactCardSendMode);
    } catch (err) {
      failed = true;
      console.error('   Contact-card step failed, continuing to next step after delay:', err);
      if (campaignId) {
        storage.recordCampaignEvent({
          campaignId,
          campaignResultId,
          phone: senderPhone,
          type: 'file_failed',
          label: step.text.slice(0, 120),
        });
      }
    }
    if (step.nextStepId) {
      await sleep(failed ? FLOW_STEP_FAILURE_CONTINUE_DELAY_MS : CONTACT_CARD_NEXT_STEP_DELAY_MS);
      await sendDecisionStep(transport, storage, senderJid, flow, step.nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
    } else if (campaignId) {
      storage.recordCampaignEvent({
        campaignId,
        campaignResultId,
        phone: senderPhone,
        type: 'completed',
        label: '\u05e1\u05d9\u05d5\u05dd \u05ea\u05d4\u05dc\u05d9\u05da',
      });
      keepHumanHandoffOpen(senderJid, campaignId, campaignResultId, senderPhone, humanHandoff);
    }
    return;
  }
  if (step.kind === 'message') {
    let failed = false;
    try {
      if (step.fileId) {
        const stepFile = storage.getUploadedFile(step.fileId);
        // Videos, images and documents support a caption. Only stickers must be sent without one.
        const sendTextSeparately = Boolean(step.fileAsSticker);
        if (sendTextSeparately && step.text.trim()) {
          await sendBotMessage(transport, senderJid, step.text.trim(), stepDelayMs);
        } else {
          await waitBeforeBotReply(stepDelayMs);
        }
        const fileSent = await sendDecisionFile(
          transport,
          storage,
          senderJid,
          step.fileId,
          sendTextSeparately ? undefined : step.text.trim(),
          step.fileAsSticker,
          campaignId,
          campaignResultId,
          senderPhone,
        );
        if (!fileSent) failed = true;
      } else {
        await sendBotMessage(transport, senderJid, step.text.trim(), stepDelayMs);
      }
      if (!failed) {
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
      }
    } catch (err) {
      failed = true;
      console.error('   Decision message failed, continuing to next step after delay:', err);
      if (campaignId) {
        storage.recordCampaignEvent({
          campaignId,
          campaignResultId,
          phone: senderPhone,
          type: 'file_failed',
          label: step.text.slice(0, 120),
        });
      }
    }
    if (step.nextStepId) {
      if (failed) await sleep(FLOW_STEP_FAILURE_CONTINUE_DELAY_MS);
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
  const hasLongOptions = (step.options ?? []).some((option) => Array.from(option.text.trim()).length > (presentation === 'list' ? 24 : 20));
  let sentInteractive = false;
  if (!hasLongOptions && presentation === 'list' && transport.sendInteractiveList && step.options?.length) {
    try {
      await waitBeforeBotReply(stepDelayMs);
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
  if (!hasLongOptions && presentation === 'buttons' && transport.sendInteractiveButtons && step.options?.length) {
    try {
      await waitBeforeBotReply(stepDelayMs);
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
    await sendBotMessage(transport, senderJid, formatQuestion(step), stepDelayMs);
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
        await sendDecisionTimeoutAction(transport, storage, senderJid, step, humanHandoff.decisionTimeoutText, campaignId, campaignResultId, senderPhone, flow, humanHandoff);
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
    decisionTimeoutMode: humanHandoff.decisionTimeoutMode,
    decisionTimeoutNextStepId: humanHandoff.decisionTimeoutNextStepId,
    timeoutFlowStarted: humanHandoff.timeoutFlowStarted,
    timestamp: Date.now(),
    timeoutHandle,
  });
}

async function handleScoreResultStep(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  flow: DecisionFlowStep[],
  step: DecisionFlowStep,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  const answers = storage.getCampaignScoreAnswers(campaignResultId);
  const matchedRule = evaluateScoreResultRule(step.resultRules ?? [], answers);
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'step_sent',
      label: matchedRule?.label || matchedRule?.type || step.text.slice(0, 120),
    });
  }
  await runScoreResultAction(
    matchedRule,
    step,
    transport,
    storage,
    senderJid,
    flow,
    campaignId,
    campaignResultId,
    senderPhone,
    humanHandoff,
  );
}

function evaluateScoreResultRule(rules: ScoreResultRule[], answers: CampaignScoreAnswer[]): ScoreResultRule | null {
  const scores = answers
    .map((answer) => answer.score)
    .filter((score) => Number.isFinite(score));
  const total = scores.reduce((sum, score) => sum + score, 0);
  const counts = new Map<number, number>();
  for (const score of scores) counts.set(score, (counts.get(score) ?? 0) + 1);
  const maxCount = Math.max(0, ...counts.values());
  const majorityValues = [...counts.entries()]
    .filter(([, count]) => count === maxCount && count > 0)
    .map(([score]) => score);

  for (const rule of rules) {
    if (rule.type === 'majority') {
      if (majorityValues.length === 1 && majorityValues[0] === rule.value) return rule;
      continue;
    }
    if (rule.type === 'sum_range') {
      const min = typeof rule.min === 'number' ? rule.min : Number.NEGATIVE_INFINITY;
      const max = typeof rule.max === 'number' ? rule.max : Number.POSITIVE_INFINITY;
      if (total >= min && total <= max) return rule;
    }
  }
  return null;
}

async function runScoreResultAction(
  rule: ScoreResultRule | null,
  step: DecisionFlowStep,
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  flow: DecisionFlowStep[],
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  const endText = rule?.endText?.trim() || step.fallbackText?.trim();
  const nextStepId = rule?.nextStepId || step.fallbackNextStepId;
  if (rule?.fileId) {
    await sendDecisionFile(
      transport,
      storage,
      senderJid,
      rule.fileId,
      endText,
      rule.fileAsSticker,
      campaignId,
      campaignResultId,
      senderPhone,
    );
  } else if (endText) {
    await sendBotMessage(transport, senderJid, endText);
  }

  if (nextStepId) {
    await sendDecisionStep(transport, storage, senderJid, flow, nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
  } else if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'completed',
      label: '\u05e1\u05d9\u05d5\u05dd \u05ea\u05d4\u05dc\u05d9\u05da',
    });
    keepHumanHandoffOpen(senderJid, campaignId, campaignResultId, senderPhone, humanHandoff);
  }
}

async function sendReferralShareStep(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  flow: DecisionFlowStep[],
  step: DecisionFlowStep,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  if (!campaignId || !campaignResultId) return;
  const campaign = storage.getCampaigns().find((item) => item.id === campaignId);
  if (!campaign) return;
  const code = storage.ensureCampaignResultReferralCode(campaignResultId) || senderPhone || '';
  const link = buildReferralShareLink(storage, campaign.triggerPhrase, code);
  const message = formatReferralShareMessage(step.text, link, code);
  const delayMs = Number.isFinite(step.delayMs) ? Math.max(0, step.delayMs ?? BOT_REPLY_DELAY_MS) : BOT_REPLY_DELAY_MS;
  if (step.fileId) {
    await waitBeforeBotReply(delayMs);
    await sendDecisionFile(
      transport,
      storage,
      senderJid,
      step.fileId,
      message,
      step.fileAsSticker,
      campaignId,
      campaignResultId,
      senderPhone,
    );
  } else {
    await sendBotMessage(transport, senderJid, message, delayMs);
  }
  storage.recordCampaignEvent({ campaignId, campaignResultId, phone: senderPhone, type: 'referral_link_sent', label: code });
  if (step.nextStepId) {
    await sendDecisionStep(transport, storage, senderJid, flow, step.nextStepId, campaignId, campaignResultId, senderPhone, humanHandoff);
  } else {
    storage.recordCampaignEvent({ campaignId, campaignResultId, phone: senderPhone, type: 'completed', label: 'referral share' });
    keepHumanHandoffOpen(senderJid, campaignId, campaignResultId, senderPhone, humanHandoff);
  }
}

function buildReferralShareLink(storage: Storage, triggerPhrase: string, code: string): string {
  const profilePhone = storage.getClientProfile().whatsappPhone;
  const rawPhone = config.META_DISPLAY_PHONE_NUMBER || config.TWILIO_FROM || profilePhone;
  const phone = rawPhone.replace(/^whatsapp:/i, '').replace(/[^\d]/g, '');
  const text = (triggerPhrase + ' ref:' + code).trim();
  return phone ? 'https://wa.me/' + phone + '?text=' + encodeReadableWhatsappText(text) : text;
}

function encodeReadableWhatsappText(text: string): string {
  return text
    .replace(/%/g, '%25')
    .replace(/&/g, '%26')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
    .replace(/=/g, '%3D')
    .replace(/\+/g, '%2B')
    .trim()
    .replace(/\s+/g, '+');
}

function formatReferralShareMessage(template: string, link: string, code: string): string {
  const base = template.trim();
  const withPlaceholders = base.split('{referral_link}').join(link).split('{referral_code}').join(code);
  return withPlaceholders.includes(link) ? withPlaceholders : withPlaceholders + '\n' + link;
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

async function handleDecisionTimeout(
  transport: WhatsAppTransport,
  storage: Storage,
  senderJid: string,
  step: DecisionFlowStep,
  defaultTimeoutText?: string,
  campaignId?: string,
  campaignResultId?: string,
  senderPhone?: string,
  source: 'decision' | 'wait-reply' = 'decision',
  flow: DecisionFlowStep[] = [],
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  await sendDecisionTimeoutAction(transport, storage, senderJid, step, defaultTimeoutText, campaignId, campaignResultId, senderPhone, flow, humanHandoff);
  if (campaignId) {
    storage.recordCampaignEvent({
      campaignId,
      campaignResultId,
      phone: senderPhone,
      type: 'decision_timeout_sent',
      label: (step.timeoutText?.trim() || defaultTimeoutText?.trim() || step.timeoutFileId || source).slice(0, 120),
    });
  }
  console.log(`   ${source} timeout handled for ${senderJid}.`);
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
  flow: DecisionFlowStep[] = [],
  humanHandoff: CampaignReplyBehavior = {},
): Promise<void> {
  const continuationStepId = humanHandoff.decisionTimeoutNextStepId;
  if (humanHandoff.decisionTimeoutMode === 'flow' && !humanHandoff.timeoutFlowStarted && continuationStepId && flow.some((item) => item.id === continuationStepId)) {
    if (campaignId) {
      storage.recordCampaignEvent({ campaignId, campaignResultId, phone: senderPhone, type: 'timeout_flow_started', label: step.text.slice(0, 120) });
    }
    await sendDecisionStep(transport, storage, senderJid, flow, continuationStepId, campaignId, campaignResultId, senderPhone, {
      ...humanHandoff,
      decisionTimeoutMode: 'message',
      decisionTimeoutNextStepId: '',
      timeoutFlowStarted: true,
    });
    console.log('   Inactivity continuation flow started.');
    return;
  }
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
): Promise<boolean> {
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
      return true;
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
      return await sendFileFallback(transport, senderJid, caption);
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
    const fallbackSent = await sendFileFallback(transport, senderJid, caption);
    console.warn(`   Decision file unavailable: ${fileId}`);
    return fallbackSent;
  }
}

async function sendFileFallback(
  transport: WhatsAppTransport,
  senderJid: string,
  caption?: string,
): Promise<boolean> {
  try {
    await sendBotMessage(
      transport,
      senderJid,
      formatFileFailureFallback(caption),
    );
    return true;
  } catch (err) {
    console.error('   Failed to send file fallback text:', err);
    return false;
  }
}

function formatFileFailureFallback(caption?: string): string {
  const failureText = '\u05d4\u05e7\u05d5\u05d1\u05e5 \u05dc\u05d0 \u05e0\u05e9\u05dc\u05d7 \u05db\u05e8\u05d2\u05e2, \u05d0\u05d6 \u05d0\u05e0\u05d9 \u05de\u05de\u05e9\u05d9\u05da \u05e2\u05dd \u05d4\u05d8\u05e7\u05e1\u05d8 \u05d1\u05dc\u05d1\u05d3.';
  const cleanCaption = caption?.trim();
  return cleanCaption || failureText;
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
  if (!cleanPhone) return base.replace(/\n?\[[^\]]*WhatsApp[^\]]*\]/g, '').trim();
  const link = `https://wa.me/${cleanPhone}`;
  const textWithLink = base.replace(/\[[^\]]*WhatsApp[^\]]*\]/g, link).trim();
  return textWithLink === base ? `${base}\n${link}` : textWithLink;
}

function normalizeHumanHandoffPhone(phone?: string): string {
  const raw = String(phone || '').replace(/[^\d+]/g, '');
  if (!raw) return '';
  if (raw.startsWith('+')) return raw.slice(1);
  if (raw.startsWith('00')) return raw.slice(2);
  if (raw.startsWith('0') && raw.length >= 9) return `972${raw.slice(1)}`;
  return raw;
}
