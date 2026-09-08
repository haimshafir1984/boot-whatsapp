import { AsyncLocalStorage } from 'async_hooks';

export class CampaignWorkCancelledError extends Error {}
type Work = { controller: AbortController; done: Promise<void>; finished?: boolean };
const scope = new AsyncLocalStorage<Work>();
const active = new Map<string, Set<Work>>();
const stopping = new Map<string, Promise<void>>();
const key = (sender: string) => sender.replace(/\D/g, '');

export function hasCampaignWork(sender: string): boolean {
  return Boolean(active.get(key(sender))?.size || stopping.has(key(sender)));
}

export function assertCampaignWorkActive(): void {
  if (scope.getStore()?.controller.signal.aborted) throw new CampaignWorkCancelledError('Campaign superseded by another campaign.');
}

export async function campaignWorkSleep(ms: number): Promise<void> {
  assertCampaignWorkActive();
  const signal = scope.getStore()?.controller.signal;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(new CampaignWorkCancelledError('Campaign superseded during wait.')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
  assertCampaignWorkActive();
}

export async function runCampaignWork<T>(sender: string, action: () => Promise<T>): Promise<T> {
  const parent = scope.getStore();
  if (parent) assertCampaignWorkActive();
  // Timers inherit AsyncLocalStorage even after their originating inbound has
  // finished. Such a callback needs a NEW registered run, not a dead parent.
  if (parent && !parent.finished) return action();
  const id = key(sender);
  if (stopping.has(id)) throw new CampaignWorkCancelledError('Campaign switch in progress.');
  let finish!: () => void;
  const work: Work = { controller: new AbortController(), done: new Promise<void>(resolve => { finish = resolve; }) };
  const set = active.get(id) ?? new Set<Work>();
  active.set(id, set);
  set.add(work);
  try { return await scope.run(work, action); }
  finally { work.finished = true; set.delete(work); if (!set.size) active.delete(id); finish(); }
}

export function guardCampaignTransport<T extends object>(transport: T): T {
  return new Proxy(transport, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (String(property).startsWith('send')) assertCampaignWorkActive();
        return value.apply(target, args);
      };
    },
  });
}

// Stop waiting work immediately, but wait for provider calls already in flight
// to settle before acknowledging a cross-client handover. Never report success
// while an old send is still running.
export async function stopCampaignWork(sender: string, cleanup: () => Promise<void>): Promise<void> {
  const id = key(sender);
  const existing = stopping.get(id);
  if (existing) return existing;
  const operation = (async () => {
    await Promise.resolve(); // publish the gate before cancellation callbacks run
    const runs = [...(active.get(id) ?? [])];
    for (const work of runs) work.controller.abort();
    await Promise.all(runs.map(work => work.done));
    await cleanup();
  })();
  stopping.set(id, operation);
  try { await operation; } finally { stopping.delete(id); }
}
