const assert = require('node:assert/strict');
const {
  DEFAULT_META_CAMPAIGN_DURATION_MS,
  defaultMetaCampaignEndAt,
  metaCampaignReservesTrigger,
  normalizeMetaTrigger,
  selectMetaRouteCandidate,
} = require('../dist/metaCampaignRouting');

assert.equal(normalizeMetaTrigger('  טסט\u200f   חדש  '), 'טסט חדש');

const now = Date.parse('2026-07-13T00:00:00.000Z');
assert.equal(
  Date.parse(defaultMetaCampaignEndAt(undefined, now)) - now,
  DEFAULT_META_CAMPAIGN_DURATION_MS,
);
const futureStart = '2026-08-01T00:00:00.000Z';
assert.equal(
  Date.parse(defaultMetaCampaignEndAt(futureStart, now)) - Date.parse(futureStart),
  DEFAULT_META_CAMPAIGN_DURATION_MS,
);

assert.equal(metaCampaignReservesTrigger({ active: true, runtimeStatus: 'active' }), true);
assert.equal(metaCampaignReservesTrigger({ active: true, runtimeStatus: 'scheduled' }), true);
assert.equal(metaCampaignReservesTrigger({ active: true, runtimeStatus: 'ended' }), false);
assert.equal(metaCampaignReservesTrigger({ active: false, runtimeStatus: 'disabled' }), false);

const campaign = (id) => ({ id, name: id, triggerType: 1, triggerPhrase: id, suffix: '', active: true });
const longest = selectMetaRouteCandidate([
  { client: 'a', clientId: 'a', campaign: campaign('short'), triggerText: 'טסט' },
  { client: 'b', clientId: 'b', campaign: campaign('long'), triggerText: 'טסט חדש' },
]);
assert.equal(longest.best.clientId, 'b');
assert.equal(longest.ambiguous, false);

const crossClientCollision = selectMetaRouteCandidate([
  { client: 'a', clientId: 'a', campaign: campaign('a1'), triggerText: 'טריגר' },
  { client: 'a', clientId: 'a', campaign: campaign('a2'), triggerText: 'טריגר' },
  { client: 'b', clientId: 'b', campaign: campaign('b1'), triggerText: 'טריגר' },
]);
assert.equal(crossClientCollision.ambiguous, true);

console.log('Meta campaign routing tests passed.');
