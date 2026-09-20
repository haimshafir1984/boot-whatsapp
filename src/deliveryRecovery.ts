import { deliveryRecoveryBus } from './deliveryRecoveryBus';
import { isLatestResultForSender, participantStillInThisRun } from './runMembership';
import { conversationState, HeldIncomingMessage, PendingConversation } from './conversationState';
import { runCampaignWork, guardCampaignTransport, CampaignWorkCancelledError } from './campaignWork';
import { Storage, OutboxMessage } from './storage';
import { WhatsAppTransport } from './types/whatsapp';
import { isUncertainSendError } from './sendOutcome';
import { withReplayOf, FlowUnitDescriptor } from './flowUnit';
import { replayServiceBotUnit } from './serviceBot';
import { completionFromSettings, handleDecisionReply, handleDecisionTimeout, handleWaitReply, queueAndReply, replyBehaviorFromSettings, runSerializedForSender, sendDecisionStep, withDurableMessaging, replayHeldMessages } from './messageFlow';

/**
 * Delivery recovery controller (stage B2, step 3).
 *
 * The state machine itself lives in Storage (uncertain -> sent by evidence | retry after the window | recoverable_failed).
 * This controller does what must follow a resolution, exactly once:
 *   - release the hold that exists BECAUSE of that message (and no other hold);
 *   - replay the flow unit the message belonged to, so the participant moves on (delivered sends are skipped);
 *   - hand the inbound messages that were held meanwhile back to the inbox (via `deliveryRecoveryBus`).
 * It refuses to act when the participant is no longer in that run: a late resolution never revives an old run
 * and never sends something new on its behalf.
 */
export interface DeliveryRecoveryRelease {
  jid: string;
  phone?: string;
  outboxId: string;
  outcome: 'continued' | 'skipped' | 'no_continuation';
  heldMessages: HeldIncomingMessage[];
}

/** adminServer listens on this to requeue the inbox items that were held while the delivery was unresolved. */
export { deliveryRecoveryBus };

const digits = (value: string | undefined): string => String(value || '').replace(/\D/g, '');
const TERMINAL: Array<OutboxMessage['status']> = ['sent', 'failed', 'recoverable_failed'];

async function runContinuation(storage: Storage, transport: WhatsAppTransport, row: OutboxMessage, d: FlowUnitDescriptor): Promise<void> {
  const unitId = row.flowRef?.unitId;
  if (!unitId) throw new Error('continuation without a flow position');
  const guarded = guardCampaignTransport(transport);
  if (d.kind === 'service_bot' || d.kind === 'service_bot_followup') {
    await withDurableMessaging(storage, () => runCampaignWork(d.senderJid, () => withReplayOf(unitId, () => replayServiceBotUnit(storage, guarded, d))));
    return;
  }
  const campaign = storage.getCampaigns().find((item) => item.id === d.campaignId);
  if (!campaign) throw new Error(`campaign ${d.campaignId} no longer exists`);
  const settings = storage.getCampaignConversationSettings(campaign);
  const humanHandoff = replyBehaviorFromSettings(settings);
  await withDurableMessaging(storage, () => runCampaignWork(d.senderJid, () => withReplayOf(unitId, () => {
    const stepId = d.stepId as string;
    switch (d.kind) {
      case 'decision_step':
        return sendDecisionStep(guarded, storage, d.senderJid, settings.decisionFlow, stepId, d.campaignId, d.campaignResultId, d.senderPhone, humanHandoff);
      case 'decision_reply':
        return handleDecisionReply(d.answer ?? '', settings.decisionFlow, stepId, d.senderJid, storage, guarded, d.campaignId, d.campaignResultId, d.senderPhone, humanHandoff);
      case 'wait_reply':
        return handleWaitReply(d.answer ?? '', settings.decisionFlow, stepId, d.senderJid, storage, guarded, d.campaignId, d.campaignResultId, d.senderPhone, humanHandoff);
      case 'decision_timeout': {
        const step = settings.decisionFlow.find((item) => item.id === stepId);
        if (!step) throw new Error(`step ${stepId} no longer exists`);
        return handleDecisionTimeout(guarded, storage, d.senderJid, step, d.timeout?.defaultTimeoutText, d.campaignId, d.campaignResultId, d.senderPhone,
          d.timeout?.source ?? 'decision', settings.decisionFlow, { ...humanHandoff, timeoutFlowStarted: d.timeout?.timeoutFlowStarted });
      }
      default:
        // reply_chain: the arguments are derived again from the campaign (the contact name is only used by the contact-save a replay skips).
        return queueAndReply(guarded, storage, d.senderJid, d.senderPhone ?? '', '', d.campaignResultId,
          settings.replyText, settings.followupMessages, settings.decisionFlow, d.campaignId, humanHandoff, completionFromSettings(settings));
    }
  })));
}

export function startDeliveryRecovery(storage: Storage, getTransport: () => WhatsAppTransport | null | undefined): { stop: () => Promise<void>; kick: () => void } {
  let stopping = false;
  const inFlight = new Set<Promise<void>>();

  const handle = async (id: string): Promise<void> => {
    const first = storage.getOutboxMessage(id);
    if (!first || !TERMINAL.includes(first.status)) return;
    const hold0 = conversationState.getNeedsReview(first.to);
    const ownHold0 = hold0?.recovery?.outboxId === id;
    const unit0 = storage.getUnitContinuation(id);
    if (!ownHold0 && unit0?.state !== 'pending') return;
    const transport = getTransport();
    if (first.status === 'sent' && unit0?.state === 'pending' && !transport) return;   // provider not ready: try again later
    // Baileys messages held meanwhile can only be processed again through a live transport: wait for it rather than drop them.
    if (ownHold0 && !transport && (hold0?.heldMessages ?? []).some((entry) => entry.source === 'baileys')) return;
    let toReplay: HeldIncomingMessage[] = [];

    await runSerializedForSender(first.to, 'delivery-recovery', async () => {
      const row = storage.getOutboxMessage(id);
      if (!row || !TERMINAL.includes(row.status)) return;
      const hold = conversationState.getNeedsReview(row.to);
      const ownHold = hold?.recovery?.outboxId === id ? hold : undefined;
      const held = ownHold?.heldMessages ?? [];
      const unit = storage.getUnitContinuation(id);
      const descriptor = unit?.descriptor;
      const jid = ownHold?.senderJid ?? descriptor?.senderJid ?? row.to;
      let outcome: DeliveryRecoveryRelease['outcome'] = 'no_continuation';

      if (unit?.state === 'pending' && descriptor) {
        const eligible = row.status === 'sent' && transport && participantStillInThisRun(descriptor, Boolean(ownHold)) && isLatestResultForSender(storage, descriptor);
        if (!eligible) {
          storage.finishContinuation(id, 'skipped');   // resolved too late / participant moved on / not delivered: nothing is revived
          outcome = 'skipped';
        } else if (storage.claimContinuation(id)) {
          if (ownHold) { conversationState.remove(ownHold.senderJid); await storage.flush(); }
          try {
            await runContinuation(storage, transport!, row, descriptor);
            storage.finishContinuation(id, 'done');
            outcome = 'continued';
          } catch (err) {
            storage.finishContinuation(id, 'skipped');
            if (err instanceof CampaignWorkCancelledError) {
              outcome = 'skipped';                                   // a newer inbound superseded the run
            } else {
              // The replay itself failed. Never guess: hold the participant again (tied to the new unknown message if that is what failed).
              const outboxId = (err as { outboxId?: string })?.outboxId;
              conversationState.set(jid, {
                kind: 'needs_review', senderJid: jid, senderPhone: descriptor.senderPhone,
                campaignId: descriptor.campaignId, campaignResultId: descriptor.campaignResultId,
                reason: `delivery recovery continuation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
                timestamp: Date.now(), heldMessages: held,
                ...(isUncertainSendError(err) && outboxId ? { recovery: { outboxId } } : {}),
              } as PendingConversation);
              await storage.flush();
              console.warn('[DELIVERY_RECOVERY_CONTINUATION_FAILED]', id, err);
              return;   // still held: nothing is released
            }
          }
        } else return;   // someone else already owns the continuation
      }
      if (ownHold && conversationState.getNeedsReview(row.to)?.recovery?.outboxId === id) conversationState.remove(ownHold.senderJid);
      await storage.flush();
      if (ownHold) {
        const event: DeliveryRecoveryRelease = { jid: ownHold.senderJid, phone: ownHold.senderPhone, outboxId: id, outcome, heldMessages: held };
        deliveryRecoveryBus.emit('released', event);
        console.log(`[DELIVERY_RECOVERY_RELEASED] outbox=${id} status=${row.status} outcome=${outcome} held=${held.length}`);
        toReplay = held.filter((entry) => entry.source === 'baileys');
      }
    });
    // Outside the per-sender serialization (replaying an inbound message takes it again).
    if (toReplay.length && transport) await replayBaileysHeld(toReplay, transport);
  };

  const replayBaileysHeld = async (entries: HeldIncomingMessage[], transport: WhatsAppTransport): Promise<void> => {
    const r = await replayHeldMessages(entries, storage, transport);
    console.log(`[HELD_MESSAGES_REPLAYED] replayed=${r.replayed} notReplayable=${r.notReplayable}`);
  };
  // The admin "requeue" action for a Baileys sender (no inbox queue exists for it) goes through the same replay.
  const onReplayRequested = (entries: HeldIncomingMessage[]): void => {
    const transport = getTransport();
    if (!transport) { console.error(`[HELD_REPLAY_NO_TRANSPORT] ${entries.length} held message(s) could not be replayed: provider not ready`); return; }
    void replayBaileysHeld(entries, transport).catch((err) => console.error('[HELD_REPLAY_FAILED]', err));
  };
  deliveryRecoveryBus.on('replayHeld', onReplayRequested);

  const schedule = (id: string): void => {
    if (stopping) return;
    const work: Promise<void> = handle(id).catch((err) => console.warn('[DELIVERY_RECOVERY_FAILED]', id, err)).finally(() => { inFlight.delete(work); });
    inFlight.add(work);
  };

  /** Work that is already resolved but not yet acted on (startup, provider not ready earlier, missed event). */
  const scan = (): void => {
    for (const { state } of conversationState.listNeedsReview()) if (state.recovery) schedule(state.recovery.outboxId);
    for (const row of storage.getOutboxMessagesWithPendingContinuation()) schedule(row.id);
  };

  storage.resetRunningContinuations();
  const unsubscribe = storage.onOutboxTransition((event) => {
    if (event.type === 'sent_after_recovery' || event.type === 'recoverable_failed') schedule(event.id);
  });
  const timer = setInterval(scan, 5_000);
  scan();

  return {
    kick: scan,
    stop: async () => {
      stopping = true; clearInterval(timer); unsubscribe(); deliveryRecoveryBus.off('replayHeld', onReplayRequested);
      await Promise.allSettled([...inFlight]);
    },
  };
}
