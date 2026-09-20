import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

/**
 * A "flow unit" is a piece of the campaign engine that sends a fixed sequence of messages and then
 * does something with the outcome: one decision-flow step, or the reply chain that follows a trigger.
 * Every outbox row created inside a unit remembers (unitId, index) and the unit's continuation
 * descriptor. That makes recovery a deterministic REPLAY of the unit: the i-th send of the replay is
 * matched to the i-th send of the original run and skipped when it was already delivered, so only the
 * missing sends happen and the unit's tail (arming the wait, moving to the next step) runs exactly once.
 * Normal runs only add metadata - they behave exactly as before.
 */
export type FlowUnitKind = 'decision_step' | 'reply_chain' | 'decision_reply' | 'wait_reply' | 'decision_timeout' | 'service_bot' | 'service_bot_followup';

export interface FlowUnitDescriptor {
  kind: FlowUnitKind;
  campaignId?: string;
  campaignResultId?: string;
  senderJid: string;
  senderPhone?: string;
  /** decision_step */
  stepId?: string;
  /** decision_reply / wait_reply: what the participant answered (a button id or short text). */
  answer?: string;
  /** decision_timeout */
  timeout?: { source: 'decision' | 'wait-reply'; defaultTimeoutText?: string; timeoutFlowStarted?: boolean };
  /** service_bot / service_bot_followup: the input and the session BEFORE the handler ran, so a replay starts from the same place. */
  serviceBot?: { body?: string; inbound?: unknown; followUp?: unknown; sessionBefore: { nodeId: string; path: string[]; variables: Record<string, string>; botId: string } | null };
  // reply_chain: nothing else is stored. Its arguments (reply text, follow-ups, completion, hand-off) are derived
  // again from the campaign settings on replay, so outbox rows do not carry them.
}

export interface FlowUnitScope {
  unitId: string;
  descriptor: FlowUnitDescriptor;
  counter: number;
  /** When set, this run replays that earlier unit: matching sends already delivered are skipped. */
  replayOf?: string;
  /** The unit's continuation descriptor is stored ONCE, on the first row the unit creates (not on every row). */
  continuationAttached?: boolean;
}

const scope = new AsyncLocalStorage<FlowUnitScope | undefined>();
const pendingReplay = new AsyncLocalStorage<{ unitId: string } | undefined>();

export function newFlowUnitId(): string {
  return 'fu_' + randomBytes(8).toString('hex');
}

export function currentFlowUnit(): FlowUnitScope | undefined {
  return scope.getStore();
}

/** Enters a unit. If a replay was requested for the enclosing call it is consumed here (nested units are new, not replays). */
export function runFlowUnit<T>(descriptor: FlowUnitDescriptor, action: () => Promise<T>): Promise<T> {
  const replay = pendingReplay.getStore();
  const unit: FlowUnitScope = { unitId: newFlowUnitId(), descriptor, counter: 0, replayOf: replay?.unitId };
  return pendingReplay.run(undefined, () => scope.run(unit, action));
}

/** Requests that the NEXT unit entered replays `unitId`. */
export function withReplayOf<T>(unitId: string, action: () => Promise<T>): Promise<T> {
  return pendingReplay.run({ unitId }, action);
}

/** Position of the next send inside the current unit (1-based), or undefined outside any unit. */
export function nextFlowSendIndex(): { unit: FlowUnitScope; index: number } | undefined {
  const unit = scope.getStore();
  if (!unit) return undefined;
  unit.counter += 1;
  return { unit, index: unit.counter };
}
