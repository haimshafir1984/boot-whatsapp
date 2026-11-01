'use strict';
/**
 * Structural revision of a campaign (src/flowRev.ts): display text edits do not change it, anything that changes an action or a route does,
 * key order does not matter, an unknown future field does (strict by default), and it is stable run to run.
 */
const assert = require('node:assert/strict');
const { computeFlowRev, flowStructure, SCORE_RESULT_PLACEHOLDER } = require('../dist/flowRev');

const results = [];
function scenario(name, fn) {
  try { fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

const base = () => ({
  askNameEnabled: true, nameTimeoutMinutes: 5, preNamePromptText: 'welcome first', contactCardIntroText: 'save me', askNameText: 'name?', replyText: 'thanks', followupMessages: ['a', 'b'],
  invalidReplyText: 'invalid', flowRecoveryText: 'recover', humanHandoffText: 'human', decisionTimeoutText: 'timeout',
  humanHandoffEnabled: true, humanHandoffPhone: '972500000001', decisionTimeoutMinutes: 30, decisionTimeoutMode: 'message', decisionTimeoutNextStepId: '',
  groupJoinManagerPhone: '972500000002', groupJoinMetaTemplateName: 'tpl', groupJoinMetaTemplateLanguage: 'he', groupJoinParticipantConfirmationText: 'ok', groupJoinParticipantFailureText: 'fail',
  completionFileIds: ['f1'], completionLinks: [{ label: 'site', url: 'https://example.com' }],
  decisionFlow: [
    { id: 's1', kind: 'question', presentation: 'buttons', text: 'Q1?', listButtonText: 'choose', timeoutText: 'timed out', fallbackText: 'fallback', emailInvalidText: 'bad email', timeoutMinutes: 30, options: [
      { id: 'o1', text: 'yes', buttonLabel: 'Yes!', nextStepId: 's2', raffleEntry: true, repeatable: true, endText: 'bye' },
      { id: 'o2', text: 'no', nextStepId: 's3', score: 1 },
      { id: 'o3', text: 'join', action: 'request_group_join', referralLeaderboardEmptyText: 'nobody yet' },
    ] },
    { id: 's2', kind: 'message', text: 'see https://wa.me/1', fileId: 'f2', delayMs: 3000, nextStepId: 's3' },
    { id: 's3', kind: 'score_result', text: SCORE_RESULT_PLACEHOLDER, resultRules: [{ id: 'r1', type: 'majority', value: 1, label: 'Winners', nextStepId: 's4', endText: 'win', fileId: 'f3' }] },
    { id: 's4', kind: 'message', text: 'end' },
  ],
});
const rev = (mutate) => { const c = base(); if (mutate) mutate(c); return computeFlowRev(c); };
const R0 = rev();

scenario('stable: same input, same revision; 8 base64url characters; key order does not matter', () => {
  assert.equal(R0, rev());
  assert.match(R0, /^[A-Za-z0-9_-]{8}$/);
  const c = base(); const reordered = {};
  for (const key of Object.keys(c).reverse()) reordered[key] = c[key];
  reordered.decisionFlow = c.decisionFlow.map((s) => { const o = {}; for (const k of Object.keys(s).reverse()) o[k] = s[k]; return o; });
  assert.equal(computeFlowRev(reordered), R0);
  assert.equal(computeFlowRev(undefined), computeFlowRev({}), 'no conversation is the empty structure');
});

scenario('display text edits do NOT change the revision (every display-only field)', () => {
  const edits = [
    (c) => { c.askNameText = 'a different name question'; }, (c) => { c.replyText = 'x'; }, 
    (c) => { c.invalidReplyText = 'x'; }, (c) => { c.flowRecoveryText = 'x'; }, (c) => { c.humanHandoffText = 'x'; }, (c) => { c.decisionTimeoutText = 'x'; },
    (c) => { c.groupJoinParticipantConfirmationText = 'x'; }, (c) => { c.groupJoinParticipantFailureText = 'x'; }, (c) => { c.preNamePromptText = 'x'; }, (c) => { c.contactCardIntroText = 'x'; },
    (c) => { c.decisionFlow[0].text = 'Q1 reworded?'; }, (c) => { c.decisionFlow[0].listButtonText = 'pick'; },
    (c) => { c.decisionFlow[0].options[0].text = 'definitely'; }, (c) => { c.decisionFlow[0].options[0].buttonLabel = 'Go'; }, (c) => { c.decisionFlow[0].options[0].endText = 'see you'; },
    (c) => { c.decisionFlow[0].timeoutText = 'x'; }, (c) => { c.decisionFlow[0].fallbackText = 'x'; }, (c) => { c.decisionFlow[0].emailInvalidText = 'x'; },
    (c) => { c.decisionFlow[1].text = 'see https://wa.me/2 now'; },
    (c) => { c.decisionFlow[2].resultRules[0].label = 'Champions'; }, (c) => { c.decisionFlow[2].resultRules[0].endText = 'you won'; },
    (c) => { c.decisionFlow[0].options[2].referralLeaderboardEmptyText = 'nobody yet again'; },
    (c) => { c.followupMessages = ['a reworded', 'b reworded']; },
    (c) => { c.decisionFlow[0].options[0].endText = 'a different goodbye'; },
  ];
  edits.forEach((mutate, i) => assert.equal(rev(mutate), R0, `display edit #${i} changed the revision`));
});

scenario('anything that changes an action or a route DOES change the revision', () => {
  const edits = {
    'option next step': (c) => { c.decisionFlow[0].options[1].nextStepId = 's4'; },
    'option score': (c) => { c.decisionFlow[0].options[1].score = 2; },
    'option raffle flag': (c) => { c.decisionFlow[0].options[0].raffleEntry = false; },
    'option repeatable flag': (c) => { delete c.decisionFlow[0].options[0].repeatable; },
    'option action': (c) => { c.decisionFlow[0].options[2].action = 'referral_link'; },
    'option file': (c) => { c.decisionFlow[0].options[0].fileId = 'f9'; },
    'option removed': (c) => { c.decisionFlow[0].options.pop(); },
    'option id': (c) => { c.decisionFlow[0].options[0].id = 'o1b'; },
    'leaderboard seed data (it changes the ranking shown)': (c) => { c.decisionFlow[0].options[2].referralLeaderboardSeeds = [{ name: 'A', invited: 3 }]; },
    'leaderboard seed value 3 -> 300': (c) => { c.decisionFlow[0].options[2].referralLeaderboardSeeds = [{ name: 'A', invited: 300 }]; },
    'option end message added where there was none': (c) => { delete c.decisionFlow[0].options[1].endText; c.decisionFlow[0].options[1].endText = 'new message'; },
    'option end message removed': (c) => { c.decisionFlow[0].options[0].endText = ''; },
    'score rule end message removed': (c) => { c.decisionFlow[2].resultRules[0].endText = ''; },
    'score rule end message added where there was none': (c) => { c.decisionFlow[2].resultRules.push({ id: 'r2', type: 'majority', value: 2, endText: 'x' }); },
    'pre-name prompt removed (it is no longer sent)': (c) => { c.preNamePromptText = ''; },
    'contact card intro removed': (c) => { c.contactCardIntroText = ''; },
    'follow-up message removed': (c) => { c.followupMessages = ['a']; },
    'follow-up message added': (c) => { c.followupMessages = ['a', 'b', 'c']; },
    'follow-up order of present / empty messages': (c) => { c.followupMessages = ['', 'a']; },
    'completion reply removed': (c) => { c.replyText = ''; },
    'step timeout message removed': (c) => { c.decisionFlow[0].timeoutText = ''; },
    'step fallback message removed': (c) => { c.decisionFlow[0].fallbackText = ''; },
    'step email-invalid message removed': (c) => { c.decisionFlow[0].emailInvalidText = ''; },
    'step next': (c) => { c.decisionFlow[1].nextStepId = 's4'; },
    'step file': (c) => { c.decisionFlow[1].fileId = 'f9'; },
    'step delay': (c) => { c.decisionFlow[1].delayMs = 60000; },
    'step timeout': (c) => { c.decisionFlow[0].timeoutMinutes = 5; },
    'step timeout mode / target': (c) => { c.decisionFlow[0].timeoutMode = 'continue'; c.decisionFlow[0].timeoutNextStepId = 's2'; },
    'step kind': (c) => { c.decisionFlow[1].kind = 'wait_reply'; },
    'step presentation': (c) => { c.decisionFlow[0].presentation = 'list'; },
    'step text emptied (whether there is text is behaviour)': (c) => { c.decisionFlow[1].text = '   '; },
    'step removed': (c) => { c.decisionFlow.pop(); },
    'steps reordered': (c) => { c.decisionFlow.reverse(); },
    'score rule value': (c) => { c.decisionFlow[2].resultRules[0].value = 2; },
    'score rule target': (c) => { c.decisionFlow[2].resultRules[0].nextStepId = 's1'; },
    'score rule file': (c) => { c.decisionFlow[2].resultRules[0].fileId = 'f9'; },
    'score result placeholder text (the code compares against it)': (c) => { c.decisionFlow[2].text = 'a real preface'; },
    'completion file': (c) => { c.completionFileIds = ['f9']; },
    'completion link target': (c) => { c.completionLinks[0].url = 'https://example.org'; },
    'human handoff phone': (c) => { c.humanHandoffPhone = '972500000009'; },
    'human handoff switch': (c) => { c.humanHandoffEnabled = false; },
    'group join manager': (c) => { c.groupJoinManagerPhone = '972500000009'; },
    'group join template': (c) => { c.groupJoinMetaTemplateName = 'other'; },
    'decision timeout minutes': (c) => { c.decisionTimeoutMinutes = 60; },
    'decision timeout mode': (c) => { c.decisionTimeoutMode = 'flow'; },
    'decision timeout next step': (c) => { c.decisionTimeoutNextStepId = 's2'; },
    'contact card number': (c) => { c.contactCardPhone = '972500000007'; },
    'a field nobody has heard of yet (strict by default)': (c) => { c.someFutureSwitch = true; },
    'a future field on a step': (c) => { c.decisionFlow[0].futureField = 1; },
    'a future field on an option': (c) => { c.decisionFlow[0].options[0].futureField = 1; },
  };
  const seen = new Map();
  for (const [label, mutate] of Object.entries(edits)) {
    const r = rev(mutate);
    assert.notEqual(r, R0, `${label} did NOT change the revision`);
    if (seen.has(r)) assert.fail(`${label} collides with ${seen.get(r)}`);
    seen.set(r, label);
  }
});

scenario('the structure itself carries no display text', () => {
  const structure = JSON.stringify(flowStructure(base()));
  for (const text of ['Q1?', 'yes', 'Yes!', 'name?', 'thanks', 'recover', 'bye', 'Winners', 'win']) assert.ok(!structure.includes(`"${text}"`), `${text} leaked into the structure`);
  assert.ok(structure.includes('"textIsPlaceholder":true'));
});

let failed = 0;
for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nFlow revision tests passed (${results.length} scenarios).`);
process.exit(failed ? 1 : 0);
