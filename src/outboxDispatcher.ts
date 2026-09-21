import { isLatestResultForSender, participantStillInThisRun } from './runMembership';
import { Storage, OutboxMessage } from './storage';
import { WhatsAppSendResult, WhatsAppTransport } from './types/whatsapp';
import { conversationState } from './conversationState';
import { runCampaignWork, assertCampaignWorkActive, CampaignWorkCancelledError } from './campaignWork';
import { classifySendError, ProviderSendError } from './sendOutcome';
import { runWithSendAttempt } from './sendAttempt';
import { notifySystemAlert } from './systemAlerts';

type TransportResolver = () => WhatsAppTransport | null | undefined;

const OUTBOX_POLL_MS = 15_000;
const OUTBOX_RETRY_MS = 60_000;
const OUTBOX_MAX_ATTEMPTS = 3;

function providerMessageId(result: void | WhatsAppSendResult): string | undefined {
  return result && typeof result === 'object' && typeof result.messageId === 'string'
    ? result.messageId
    : undefined;
}

const OUTBOX_RETRY_MAX_MS = 10 * 60_000;

/** Retry no sooner than the fixed backoff, honouring a provider Retry-After (bounded). */
function nextRetryIso(retryAfterMs?: number): string {
  const delay = Math.min(Math.max(retryAfterMs ?? 0, OUTBOX_RETRY_MS), OUTBOX_RETRY_MAX_MS);
  return new Date(Date.now() + delay).toISOString();
}

/**
 * A needs_review hold blocks outbound sends to the recipient - except the hold that exists BECAUSE of this very
 * message (delivery recovery): that hold must not stop the message's own bounded retry.
 */
function holdBlocks(message: OutboxMessage): boolean {
  const hold = conversationState.getNeedsReview(message.to);
  if (!hold) return false;
  return hold.recovery?.outboxId !== message.id;
}

function alertUncertain(message: OutboxMessage, reason: string): void {
  notifySystemAlert({
    key: `outbox-uncertain-${message.id}`,
    severity: 'critical',
    title: 'Outbox message with unknown delivery outcome',
    message: `A ${message.kind} message could not be confirmed as sent or not sent. It waits for delivery evidence and, if none arrives within the recovery window, is retried once (a duplicate is possible); after that it ends as recoverable_failed and stops blocking the recipient.`,
    details: { outboxId: message.id, kind: message.kind, campaignId: message.campaignId, attempts: message.attempts, reason },
  });
}

async function dispatchMessage(storage: Storage, transport: WhatsAppTransport, message: OutboxMessage): Promise<void> {
  if (message.attempts >= OUTBOX_MAX_ATTEMPTS) {
    // A message that went through delivery recovery ends as recoverable_failed (not blocking, not success).
    if (message.recovery) storage.markOutboxRecoverableFailed(message.id, message.lastError || 'Outbox retry limit reached.');
    else storage.markOutboxFailed(message.id, message.lastError || 'Outbox retry limit reached.');
    await storage.flush();
    return;
  }

  // A retry granted by delivery recovery is only sent while the participant is still in the run the message belongs to
  // (no newer run, no other step). Otherwise it would put an old run's message into the participant's current conversation.
  if (message.recovery) {
    const descriptor = storage.getUnitContinuation(message.id)?.descriptor;
    const ownHold = conversationState.getNeedsReview(message.to)?.recovery?.outboxId === message.id;
    if (descriptor && !(isLatestResultForSender(storage, descriptor) && participantStillInThisRun(descriptor, ownHold))) {
      storage.markOutboxRecoverableFailed(message.id, 'The participant left the run this message belonged to; not retried.');
      storage.finishContinuation(message.id, 'skipped');
      await storage.flush();
      console.warn(`[RETRY_SUPPRESSED_RUN_MOVED_ON] outbox=${message.id}`);
      return;
    }
  }

  // R4, re-checked right before the claim: a hold placed after this message was selected must
  // leave it queued, untouched and without a consumed attempt.
  if (holdBlocks(message)) return;

  const claimed = storage.claimOutboxMessage(message.id);
  if (!claimed) return;
  await storage.flush();
  let result: void | WhatsAppSendResult;
  try {
    assertCampaignWorkActive();
    result = claimed.attemptId
      ? await runWithSendAttempt({ attemptId: claimed.attemptId, outboxId: claimed.id }, () => sendOutboxMessage(transport, claimed))
      : await sendOutboxMessage(transport, claimed);
  } catch (err) {
    // Classification comes first: only a provider REJECTION (or a never-connected
    // failure) may be retried. A timeout/dropped connection may have been accepted.
    if (err instanceof CampaignWorkCancelledError) {
      storage.markOutboxFailed(claimed.id, err);
    } else {
      const outcome = classifySendError(err);
      if (outcome.outcome === 'uncertain') {
        // Delivery evidence that arrived during the send settles it as sent: nothing is uncertain then.
        if (!storage.markOutboxUncertain(claimed.id, err)) alertUncertain(claimed, err instanceof Error ? err.message : String(err));
      } else if (outcome.outcome === 'rejected_permanent' || claimed.attempts >= OUTBOX_MAX_ATTEMPTS) {
        storage.markOutboxFailed(claimed.id, err);
      } else {
        storage.markOutboxRetry(claimed.id, err, nextRetryIso(outcome.retryAfterMs));
      }
    }
    await storage.flush();
    return;
  }
  // Persistence failure after acceptance must not turn into a second send.
  storage.markOutboxSent(claimed.id, providerMessageId(result));
  await storage.flush();
}

async function sendOutboxMessage(transport: WhatsAppTransport, message: OutboxMessage): Promise<void | WhatsAppSendResult> {
  switch (message.kind) {
    case 'file':
      return await sendOutboxFile(transport, message);
    case 'interactive_buttons':
      if (!transport.sendInteractiveButtons) throw new ProviderSendError('WhatsApp transport does not support interactive buttons.', 'rejected_permanent');
      return await transport.sendInteractiveButtons(message.to, message.text || '', message.buttons ?? []);
    case 'interactive_list':
      if (!transport.sendInteractiveList) throw new ProviderSendError('WhatsApp transport does not support interactive lists.', 'rejected_permanent');
      return await transport.sendInteractiveList(message.to, message.text || '', message.buttonText || '', message.items ?? []);
    case 'contacts':
      if (transport.sendContactCards) {
        return await transport.sendContactCards(message.to, message.contacts ?? [], message.displayName || '');
      }
      if (transport.sendContactCard && message.contacts?.length === 1) {
        const contact = message.contacts[0];
        return await transport.sendContactCard(message.to, contact.vcard, contact.displayName);
      }
      throw new ProviderSendError('WhatsApp transport does not support contact cards.', 'rejected_permanent');
    case 'template':
      if (!transport.sendTemplateMessage) throw new ProviderSendError('WhatsApp transport does not support Meta templates.', 'rejected_permanent');
      return await transport.sendTemplateMessage(
        message.to,
        message.templateName || '',
        message.templateLanguageCode || 'he',
        message.templateBodyParameters ?? [],
      );
    case 'text':
    default:
      return await transport.sendMessage(message.to, message.text || '');
  }
}

async function sendOutboxFile(transport: WhatsAppTransport, message: OutboxMessage): Promise<void | WhatsAppSendResult> {
  if (!transport.sendFile) throw new ProviderSendError('WhatsApp transport does not support files.', 'rejected_permanent');
  if (!message.filePath) throw new ProviderSendError('Outbox file message is missing filePath.', 'rejected_permanent');
  return await transport.sendFile(message.to, message.filePath, message.caption, message.fileOptions);
}

export interface OutboxDispatcherOptions {
  /** Distinct recipients sent in parallel. Default OUTBOX_CONCURRENCY env or 20; bounded to 1..100. */
  concurrency?: number;
  /** How long stop() waits for in-flight sends before giving up. Default OUTBOX_SHUTDOWN_WAIT_MS env or 30s. */
  shutdownWaitMs?: number;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const recipientKey = (to: string): string => to.replace(/\D/g, '');

/**
 * Worker pool: a slot is refilled the moment any send finishes (no batch barrier), so a slow
 * or hung send occupies one slot instead of holding back every recipient in its batch.
 * A recipient is never in two slots (its head message is `processing` while in flight, and
 * later messages are not heads), so per-recipient order stays serial.
 * Wake-ups: after an enqueue / retry-schedule (storage event) and when a retry becomes due;
 * the poll interval is only a backstop. Nothing spins while everything is blocked or waiting.
 */
export function startOutboxDispatcher(
  storage: Storage,
  getTransport: TransportResolver,
  intervalMs = OUTBOX_POLL_MS,
  options: OutboxDispatcherOptions = {},
): { stop: () => Promise<void>; wake: () => void } {
  const concurrency = boundedInt(options.concurrency ?? process.env.OUTBOX_CONCURRENCY, 20, 1, 100);
  const shutdownWaitMs = boundedInt(options.shutdownWaitMs ?? process.env.OUTBOX_SHUTDOWN_WAIT_MS, 30_000, 0, 10 * 60_000);
  let stopping = false;
  let filling = false;
  let refillRequested = false;
  let wakeTimer: NodeJS.Timeout | null = null;
  const inFlight = new Set<Promise<void>>();
  // A dispatch that ended without changing its message (claimed elsewhere, superseded, held
  // at claim time) must not be re-selected in a tight loop: give the recipient a short pause.
  const cooldownUntil = new Map<string, number>();
  const COOLDOWN_MS = 1_000;

  const isBlocked = (recipient: string, message: OutboxMessage): boolean => {
    if (holdBlocks(message)) return true;
    const until = cooldownUntil.get(recipientKey(recipient));
    if (until === undefined) return false;
    if (until <= Date.now()) { cooldownUntil.delete(recipientKey(recipient)); return false; }
    return true;
  };

  const recoverOrphans = async (): Promise<void> => {
    // Rows left `processing` by a crashed process are not proof of "not sent": park them as uncertain.
    const orphans = storage.recoverOrphanedOutboxProcessing();
    if (!orphans.length) return;
    await storage.flush();
    for (const orphan of orphans) alertUncertain(orphan, 'process ended while sending');
  };

  const scheduleWake = (): void => {
    if (stopping) return;
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
    const now = Date.now();
    let next = storage.getNextOutboxDueAtMs(new Date(now));
    for (const until of cooldownUntil.values()) if (until > now && (next === undefined || until < next)) next = until;
    if (next === undefined) return; // the poll interval is the backstop
    wakeTimer = setTimeout(() => { wakeTimer = null; void fill(); }, Math.min(Math.max(next - now, 25), intervalMs));
  };

  const start = (transport: WhatsAppTransport, message: OutboxMessage): void => {
    const work: Promise<void> = runCampaignWork(message.to, () => dispatchMessage(storage, transport, message))
      .catch((err) => { if (!(err instanceof CampaignWorkCancelledError)) console.warn('Outbox dispatch failed:', err); })
      .then(() => {
        const after = storage.getOutboxMessage(message.id);
        // No progress (still claimable with the same attempt count): pause this recipient briefly.
        if (after && (after.status === 'queued' || after.status === 'retry') && after.attempts === message.attempts) {
          cooldownUntil.set(recipientKey(message.to), Date.now() + COOLDOWN_MS);
        }
      })
      .finally(() => {
        inFlight.delete(work);
        void fill();
      });
    inFlight.add(work);
  };

  const fill = async (): Promise<void> => {
    if (filling) { refillRequested = true; return; }
    filling = true;
    try {
      do {
        refillRequested = false;
        if (stopping) return;
        const transport = getTransport();
        if (!transport) break;
        // Delivery recovery: uncertain messages whose window ended without evidence get their bounded retry
        // (or their terminal state) before we look for work.
        if (storage.advanceUncertainRecovery().length) await storage.flush();
        const free = concurrency - inFlight.size;
        if (free <= 0) break;
        // Eligibility (held / cooling down) is applied inside the query, before the limit (6.1).
        const pending = storage.getPendingOutboxMessages(free, new Date(), undefined, isBlocked);
        for (const message of pending) start(transport, message);
      } while (refillRequested);
    } catch (err) {
      console.warn('Outbox dispatcher failed:', err);
    } finally {
      filling = false;
      scheduleWake();
    }
  };

  const poll = async (): Promise<void> => {
    try { if (!stopping && getTransport()) await recoverOrphans(); } catch (err) { console.warn('Outbox orphan recovery failed:', err); }
    await fill();
  };

  const handle = setInterval(() => { void poll(); }, intervalMs);
  const unsubscribe = storage.onOutboxWake(() => { void fill(); });
  void poll();

  return {
    wake: () => { void fill(); },
    stop: async () => {
      stopping = true;
      clearInterval(handle);
      unsubscribe();
      if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
      // Stop taking work, then wait (bounded) for sends already in flight so no dispatchMessage()
      // write races storage.close(). A send still running after the budget stays `processing`
      // and is parked as `uncertain` by the next process's orphan recovery - never resent.
      if (inFlight.size) {
        let timer: NodeJS.Timeout | undefined;
        const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, shutdownWaitMs); });
        await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), budget]);
        if (timer) clearTimeout(timer);
        if (inFlight.size) console.warn(`[OUTBOX_SHUTDOWN_TIMEOUT] ${inFlight.size} send(s) still in flight after ${shutdownWaitMs}ms`);
      }
    },
  };
}
