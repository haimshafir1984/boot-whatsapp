import { deliverServiceBotFollowUp } from './serviceBot';
import { Storage } from './storage';
import { WhatsAppTransport } from './types/whatsapp';
import { conversationState } from './conversationState';

type TransportResolver = () => WhatsAppTransport | null | undefined;

const SERVICE_BOT_FOLLOW_UP_POLL_MS = 5_000;

export function startServiceBotFollowUpDispatcher(
  storage: Storage,
  getTransport: TransportResolver,
  intervalMs = SERVICE_BOT_FOLLOW_UP_POLL_MS,
): { stop: () => Promise<void> } {
  let stopping = false;
  let inFlight: Promise<void> | null = null;

  const tick = async () => {
    const transport = getTransport();
    if (!transport) return;
    for (const due of storage.getDueServiceBotFollowUps()) {
      if (stopping) break;
      // R4: same guard as outboxDispatcher.ts - a sender blocked pending
      // admin review must not receive an automatic follow-up either. Leave
      // it unclaimed (still 'scheduled') so it is preserved and simply
      // retried on the next tick, rather than lost or sent while blocked.
      if (conversationState.isHeldForReview(due.to) || conversationState.isHeldForReview(due.phone)) continue;
      const claimed = storage.claimServiceBotFollowUp(due.id);
      if (!claimed) continue;
      try {
        await deliverServiceBotFollowUp(claimed, storage, transport);
        storage.completeServiceBotFollowUp(claimed.id);
        await storage.flush();
      } catch (err) {
        storage.failServiceBotFollowUp(claimed.id, err);
        await storage.flush();
        console.warn('[SERVICE_BOT_FOLLOW_UP_FAILED]', claimed.id, err);
      }
    }
  };

  const runTick = (): Promise<void> => {
    if (inFlight || stopping) return inFlight ?? Promise.resolve();
    inFlight = tick().finally(() => { inFlight = null; });
    return inFlight;
  };

  const handle = setInterval(() => { void runTick(); }, intervalMs);
  void runTick();

  return {
    stop: async () => {
      stopping = true;
      clearInterval(handle);
      // Let the current tick finish its claim → deliver → flush before storage closes.
      await (inFlight ?? Promise.resolve());
    },
  };
}
