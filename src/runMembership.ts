import { conversationState, PendingConversation } from './conversationState';
import { FlowUnitDescriptor } from './flowUnit';
import type { Storage } from './storage';

const digits = (value: string | undefined): string => String(value ?? '').replace(/\D/g, '');

/** True when the participant's newest campaign result is the one this flow unit belongs to (no newer run was started). */
export function isLatestResultForSender(storage: Storage, d: FlowUnitDescriptor | undefined): boolean {
  if (!d?.campaignResultId) return true;
  const phone = digits(d.senderPhone || d.senderJid);
  const results = storage.getCampaignResults().filter((r) => digits(r.phone) === phone);
  if (!results.length) return false;
  const latest = results.reduce((a, b) => (Date.parse(b.triggeredAt) > Date.parse(a.triggeredAt) ? b : a));
  return latest.id === d.campaignResultId;
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
