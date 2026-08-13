import { deliverServiceBotFollowUp } from './serviceBot';
import { Storage } from './storage';
import { WhatsAppTransport } from './types/whatsapp';

type TransportResolver = () => WhatsAppTransport | null | undefined;

const SERVICE_BOT_FOLLOW_UP_POLL_MS = 5_000;

export function startServiceBotFollowUpDispatcher(
  storage: Storage,
  getTransport: TransportResolver,
  intervalMs = SERVICE_BOT_FOLLOW_UP_POLL_MS,
): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const transport = getTransport();
      if (!transport) return;
      for (const due of storage.getDueServiceBotFollowUps()) {
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
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  return handle;
}
