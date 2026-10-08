'use strict';

/**
 * Grouping the sends of ONE participant into steps, for the peak harness.
 *
 * The harness models a campaign step as one outbound message, and used to count a step with more
 * than one send as a duplicate. That stopped being true for an AUDIO step: WhatsApp has no caption
 * on an audio message, so the product sends the step's text as its own message just before the clip
 * (src/messageFlow.ts, sendDecisionFile). One step, two sends, both legitimately carrying the same
 * [X#n] step marker - the text from its own body, the clip from its file name (clip-Q2.mp3).
 *
 * Counting that pair as a duplicate did not just add noise: it made BOTH guards for the audio
 * feature report a constant failure, so a real duplicate or a real clip-sent-as-a-document could no
 * longer be told apart from the expected pair. These helpers restore the distinction:
 *
 *   - a duplicate is two sends of the SAME TYPE at the same step (the engine sent one message
 *     twice), not two sends of different types (one step's text plus its media),
 *   - at an audio step, a `text` send is the step's caption; anything else is the clip itself and
 *     must have gone out as `audio`.
 *
 * The two guards together still cover the clip being sent wrongly: a clip sent once as `audio` and
 * once as `document` has two different types, so duplicateGroups() stays quiet, but the `document`
 * send is not a caption, so classifyAudioStepSends() reports it under sentAsSomethingElse.
 *
 * A send is `{ t, type, idx, camp, key, attempt, prev, lost, id }` as onMetaSend() records it.
 */

/** Steps are identified by campaign + index: a participant who switches campaigns reuses indexes. */
function stepKeyOf(send) {
  return (send.camp || '?') + '#' + send.idx;
}

/**
 * Distinct steps this participant has actually been sent, for "has the flow finished" checks.
 * Collapses an audio step's caption+clip into the one step it is, so a quiz participant is not
 * counted as finished a step early just because that step produced two messages.
 */
function distinctStepCount(sends) {
  const seen = new Set();
  for (const sd of sends) if (sd.idx != null) seen.add(stepKeyOf(sd));
  return seen.size;
}

/**
 * Groups of sends at one step that are real duplicates: same step AND same message type, meaning
 * the same message went out more than once. Returns one group per (step, type) that has >1 send,
 * each sorted by time, so the caller can explain it.
 */
function duplicateGroups(sends) {
  const byStepAndType = new Map();
  for (const sd of sends) {
    if (sd.idx == null) continue;
    const k = stepKeyOf(sd) + '|' + (sd.type || '?');
    const g = byStepAndType.get(k);
    if (g) g.push(sd); else byStepAndType.set(k, [sd]);
  }
  const out = [];
  for (const g of byStepAndType.values()) {
    if (g.length < 2) continue;
    out.push(g.slice().sort((a, b) => a.t - b.t));
  }
  return out;
}

/**
 * Splits the sends of an audio step into the clip and its caption.
 *   clips             - the media sends; each one's `type` must be 'audio'
 *   captions          - `text` sends, i.e. the step text delivered as its own message (expected)
 *   sentAsAudio       - clips that went out correctly
 *   sentAsSomethingElse - clips that went out as a document/other: the silent failure mode, where
 *                       the participant gets a file attachment instead of a playable clip
 */
function classifyAudioStepSends(sends) {
  const clips = sends.filter((sd) => sd.type !== 'text');
  const captions = sends.filter((sd) => sd.type === 'text');
  let sentAsAudio = 0;
  let sentAsSomethingElse = 0;
  for (const c of clips) { if (c.type === 'audio') sentAsAudio += 1; else sentAsSomethingElse += 1; }
  return { clips, captions, sentAsAudio, sentAsSomethingElse };
}

module.exports = { stepKeyOf, distinctStepCount, duplicateGroups, classifyAudioStepSends };
