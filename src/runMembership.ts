import { conversationState, PendingConversation } from './conversationState';
import { FlowUnitDescriptor } from './flowUnit';
import type { Storage } from './storage';

const digits = (value: string | undefined): string => String(value ?? '').replace(/\D/g, '');

/**
 * True when the run this flow unit belongs to is still the participant's CURRENT run: her latest result AND not replaced (a newer run of
 * hers, or a handover to another client, which marks the run `supersededAt` without creating a new result here). The one check shared by
 * delivery recovery and the outbox retry before they continue or resend anything on behalf of an old run.
 * (Name kept: scripts/mutation-stage-b.js matches it.)
 */
export function isLatestResultForSender(storage: Storage, d: FlowUnitDescriptor | undefined): boolean {
  if (!d?.campaignResultId) return true;
  const phone = digits(d.senderPhone || d.senderJid);
  return storage.getCurrentRun(phone)?.id === d.campaignResultId;
}

/** True when the participant is still in the run / step this flow unit was part of (a recovery hold on the message counts as "still in it"). */
export function participantStillInThisRun(d: FlowUnitDescriptor | undefined, ownHold: boolean): boolean {
  if (ownHold) return true;
  if (!d) return false;
  const state = conversationState.get(d.senderJid) as (PendingConversation & { campaignResultId?: string; stepId?: string }) | undefined;
  if (!state || state.kind === 'needs_review') return false;
  if (d.campaignResultId && state.campaignResultId !== d.campaignResultId) return false;
  return !(d.kind === 'decision_step' || d.kind === 'decision_reply' || d.kind === 'wait_reply') || !state.stepId || state.stepId === d.stepId;
}
