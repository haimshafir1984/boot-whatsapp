import { AsyncLocalStorage } from 'async_hooks';

/**
 * An inbound message can end in a way that is NOT "processed" although the handler returns normally. Today the only such
 * outcome is an expired trigger: the campaign is deliberately not run (policy unchanged), but the inbox must not record it as
 * `completed` - it must surface as review work with the payload kept. The handler reports it here; the drainer reads it.
 * Outside a drainer scope reporting is a no-op, so nothing else changes.
 */
export type InboundOutcome = { kind: 'stale_trigger'; ageMs: number; campaignName?: string };

const scope = new AsyncLocalStorage<{ outcome?: InboundOutcome }>();

export function reportInboundOutcome(outcome: InboundOutcome): void {
  const store = scope.getStore();
  if (store) store.outcome = outcome;
}

export async function runWithInboundOutcome<T>(fn: () => Promise<T>): Promise<{ result: T; outcome?: InboundOutcome }> {
  const store: { outcome?: InboundOutcome } = {};
  const result = await scope.run(store, fn);
  return { result, outcome: store.outcome };
}
