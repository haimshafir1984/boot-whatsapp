import type { DecisionFlowStep } from './storage';

/**
 * Steps that move on by themselves: a message or a contact card sends and then immediately sends whatever
 * `nextStepId` points at, without waiting for the participant. If those links ever form a circle the bot sends
 * the same messages forever (it ends only when Meta rate-limits the number, and even then it resumes).
 * Questions, wait_reply and email_capture wait for the participant, so a "back to the menu" link from them is a
 * legitimate loop and is not considered here.
 */
const AUTO_ADVANCE_KINDS = new Set(['message', 'contact_card']);

/** Ids of the steps that sit on a circle made only of auto-advancing steps. */
export function findAutoAdvanceCycleStepIds(flow: readonly Pick<DecisionFlowStep, 'id' | 'kind' | 'nextStepId'>[] | undefined): Set<string> {
  const onCycle = new Set<string>();
  if (!Array.isArray(flow)) return onCycle;
  const byId = new Map(flow.map((step) => [step.id, step]));
  for (const start of flow) {
    if (!AUTO_ADVANCE_KINDS.has(start.kind)) continue;
    const seen = new Set<string>();
    let current: typeof start | undefined = start;
    while (current && AUTO_ADVANCE_KINDS.has(current.kind) && current.nextStepId) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      const next = byId.get(current.nextStepId);
      if (next && next.id === start.id) { onCycle.add(start.id); break; }
      current = next;
    }
  }
  return onCycle;
}
