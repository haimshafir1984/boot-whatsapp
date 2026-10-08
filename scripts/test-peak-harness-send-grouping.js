'use strict';

/**
 * The peak harness's step grouping (scripts/lib/peak-send-grouping.js).
 *
 * Why this test exists: the harness modelled "one campaign step = one outbound message" and counted
 * any step with two sends as a duplicate. An AUDIO step breaks that - WhatsApp has no caption on
 * audio, so the product sends the step's text as its own message just before the clip, and both
 * sends carry the same [X#n] step marker. The result was that TWO guards reported a constant
 * failure on every run ("duplicate messages: 48", "audio clips sent as anything other than audio:
 * 48"), which meant a REAL duplicate or a REAL clip-sent-as-a-document could no longer be told
 * apart from the expected pair. The guards were blind on the feature they exist to protect.
 *
 * So the assertions below are in two halves, and the second half is the one that matters:
 *   1. the expected caption+clip pair is NOT reported, and
 *   2. every real failure mode IS still reported.
 */

const assert = require('node:assert/strict');
const { distinctStepCount, duplicateGroups, classifyAudioStepSends } = require('./lib/peak-send-grouping');

const results = [];
function scenario(name, fn) {
  try { fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 3).join(' | ')]); }
}

/** A send as onMetaSend() records it; only the fields the grouping reads are set. */
const send = (idx, type, t, extra = {}) => ({ idx, type, t, camp: 'Q', key: `972500000001|Q#${idx}`, attempt: 1, prev: null, lost: false, id: `wamid.${idx}.${t}`, ...extra });

// A quiz flow as the product now sends it: intro text, then the audio step's caption, then the
// clip, then the buttons question, then the result.
const quizFlow = [
  send(1, 'text', 0),
  send(2, 'text', 1000),            // the audio step's caption, as its own message
  send(2, 'audio', 3000),           // the clip itself
  send(3, 'interactive', 9000),
  send(4, 'text', 12000),
];

// ---------------------------------------------------------------- half 1: the expected pair is quiet
scenario('an audio step caption plus its clip is not a duplicate', () => {
  assert.deepEqual(duplicateGroups(quizFlow), [], 'the caption and the clip are one step in two kinds, not one message twice');
});

scenario('an audio step counts as ONE step for flow-completion checks', () => {
  assert.equal(distinctStepCount(quizFlow), 4, 'a 4-step quiz must read as 4 steps even though step 2 produced two sends');
});

scenario('the caption is reported as a caption, and the clip as audio', () => {
  const step2 = quizFlow.filter((s) => s.idx === 2);
  const split = classifyAudioStepSends(step2);
  assert.equal(split.sentAsAudio, 1, 'the clip went out as audio');
  assert.equal(split.sentAsSomethingElse, 0, 'nothing was mis-typed');
  assert.equal(split.captions.length, 1, 'the step text is counted as a caption, not as a mis-typed clip');
  assert.equal(split.clips.length, 1, 'exactly one clip');
});

// ---------------------------------------------------------------- half 2: real failures still caught
scenario('the SAME message sent twice is still a duplicate', () => {
  // The real one found in production-shaped load: a 429, then a retry that was accepted, then the
  // engine sent it AGAIN - two `interactive` sends of the same step.
  const withDup = [...quizFlow, send(3, 'interactive', 9181, { attempt: 2, prev: 'accepted' })];
  const groups = duplicateGroups(withDup);
  assert.equal(groups.length, 1, 'one duplicate group expected');
  assert.equal(groups[0].length, 2, 'two copies of step 3');
  assert.equal(groups[0][0].type, 'interactive');
  assert.ok(groups[0][0].t < groups[0][1].t, 'the group must be time-ordered so the second copy can be explained');
});

scenario('a clip sent twice is still a duplicate, even next to its caption', () => {
  const twoClips = [...quizFlow, send(2, 'audio', 4000)];
  const groups = duplicateGroups(twoClips);
  assert.equal(groups.length, 1, 'the two audio sends are a duplicate; the caption must not hide them');
  assert.equal(groups[0].every((s) => s.type === 'audio'), true);
});

scenario('a caption sent twice is still a duplicate', () => {
  const twoCaptions = [...quizFlow, send(2, 'text', 1100)];
  assert.equal(duplicateGroups(twoCaptions).length, 1, 'two caption messages for one step is one message twice');
});

scenario('a clip sent as a document is still reported', () => {
  // The silent failure the audio feature exists to prevent: the participant gets a file attachment
  // with a filename instead of a playable clip, and nothing errors.
  const asDoc = [send(2, 'text', 1000), send(2, 'document', 3000)];
  const split = classifyAudioStepSends(asDoc);
  assert.equal(split.sentAsSomethingElse, 1, 'a document send must be reported, not excused as a caption');
  assert.equal(split.sentAsAudio, 0);
  assert.equal(split.captions.length, 1, 'the caption is still recognised');
});

scenario('a clip sent BOTH as audio and as a document is reported by the type check', () => {
  // Two different types, so it is not a duplicate group - the type check is what must catch it.
  const both = [send(2, 'audio', 3000), send(2, 'document', 3200)];
  assert.deepEqual(duplicateGroups(both), [], 'different types are not a same-message duplicate');
  assert.equal(classifyAudioStepSends(both).sentAsSomethingElse, 1, 'the document send must still be reported');
});

scenario('steps of different campaigns with the same index are not confused', () => {
  // A participant who switches campaign reuses step indexes; those are different steps.
  const switched = [send(2, 'text', 0), { ...send(2, 'text', 500), camp: 'A' }];
  assert.deepEqual(duplicateGroups(switched), [], 'Q#2 and A#2 are different steps');
  assert.equal(distinctStepCount(switched), 2);
});

for (const [name, status, detail] of results) console.log(`${status}  ${name}${detail ? ' :: ' + detail : ''}`);
const failed = results.filter((r) => r[1] === 'FAIL').length;
console.log(`\npeak-harness-send-grouping: ${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
