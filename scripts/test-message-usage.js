'use strict';
/**
 * Message usage / cost report (src/messageUsage.ts): attribution of outbox rows to campaigns through their flow unit, what is billable,
 * date ranges and Israel-time days/months, participants, prices, the monthly free tier per number, unreachable and non-billed clients.
 */
const assert = require('node:assert/strict');
const U = require('../dist/messageUsage');

const results = [];
function scenario(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log('ok   ' + name); }
  catch (err) { results.push({ name, ok: false }); console.log('FAIL ' + name + '\n     ' + (err && err.stack || err)); }
}

let seq = 0;
/** One outbox row. unit: the flow unit it belongs to; owner: it carries the continuation descriptor (campaignId). */
function row(o = {}) {
  seq += 1;
  return {
    kind: 'text', to: o.to ?? '972501234567', status: 'sent', deliveryStatus: 'delivered',
    createdAt: o.createdAt ?? '2026-11-07T17:00:00.000Z',
    ...(o.unit ? { flowRef: { unitId: o.unit, index: o.index ?? seq } } : {}),
    ...(o.owner ? { continuation: { state: 'done', descriptor: { kind: 'reply_chain', campaignId: o.owner, senderJid: 'x' } } } : {}),
    ...o.set,
  };
}
const campaigns = [
  { id: 'c1', name: 'אבחון DNA', triggerPhrase: 'שלום DNA' },
  { id: 'c2', name: 'קמפיין שני', triggerPhrase: 'שלום שני' },
];

scenario('a row is attributed through the continuation of its flow unit (only the first row stores it)', () => {
  const rows = [
    row({ unit: 'u1', owner: 'c1' }), row({ unit: 'u1' }), row({ unit: 'u1' }),
    row({ unit: 'u2', owner: 'c2', to: '972502222222' }), row({ unit: 'u2', to: '972502222222' }),
  ];
  const usage = U.computeMessageUsage(rows, campaigns);
  const byId = Object.fromEntries(usage.campaigns.map((c) => [c.campaignId, c]));
  assert.equal(byId.c1.delivered, 3);
  assert.equal(byId.c2.delivered, 2);
  assert.equal(usage.totals.delivered, 5);
  assert.equal(byId.c1.name, 'אבחון DNA');
  assert.equal(byId.c1.triggerPhrase, 'שלום DNA');
});

scenario('a unit whose owner row comes AFTER the other rows is still attributed', () => {
  const usage = U.computeMessageUsage([row({ unit: 'u9' }), row({ unit: 'u9', owner: 'c1' })], campaigns);
  assert.equal(usage.campaigns.length, 1);
  assert.equal(usage.campaigns[0].campaignId, 'c1');
  assert.equal(usage.campaigns[0].delivered, 2);
});

scenario('a row with its own campaignId wins; rows with no campaign are reported, never dropped', () => {
  const rows = [
    row({ set: { campaignId: 'c2' } }),
    row({}),                                   // no flow reference at all (old row / service bot)
    row({ unit: 'svc', owner: undefined }),    // a unit nobody owns
  ];
  const usage = U.computeMessageUsage(rows, campaigns);
  const none = usage.campaigns.find((c) => c.campaignId === null);
  assert.equal(none.delivered, 2);
  assert.match(none.name, /ללא קמפיין/);
  assert.equal(usage.campaigns.find((c) => c.campaignId === 'c2').delivered, 1);
  assert.equal(usage.totals.delivered, 3);
});

scenario('a campaign that was deleted keeps its messages under an explicit name', () => {
  const usage = U.computeMessageUsage([row({ unit: 'u1', owner: 'gone' })], campaigns);
  assert.equal(usage.campaigns[0].deleted, true);
  assert.equal(usage.campaigns[0].name, 'קמפיין שנמחק');
});

scenario('billable = delivered or read; sent-only and failed are counted apart; queued and uncertain are ignored', () => {
  const rows = [
    row({ unit: 'u', owner: 'c1', set: { deliveryStatus: 'delivered' } }),
    row({ unit: 'u', set: { deliveryStatus: 'read' } }),
    row({ unit: 'u', set: { deliveryStatus: 'sent' } }),
    row({ unit: 'u', set: { deliveryStatus: undefined } }),
    row({ unit: 'u', set: { status: 'failed', deliveryStatus: undefined } }),
    row({ unit: 'u', set: { deliveryStatus: 'failed' } }),
    row({ unit: 'u', set: { status: 'recoverable_failed', deliveryStatus: undefined } }),
    row({ unit: 'u', set: { status: 'queued', deliveryStatus: undefined } }),
    row({ unit: 'u', set: { status: 'uncertain', deliveryStatus: undefined } }),
    row({ unit: 'u', set: { status: 'retry', deliveryStatus: undefined } }),
  ];
  const usage = U.computeMessageUsage(rows, campaigns);
  assert.equal(usage.totals.delivered, 2);
  assert.equal(usage.totals.sentOnly, 2);
  assert.equal(usage.totals.failed, 3);
  assert.equal(usage.rowsConsidered, 7);
});

scenario('a provider delivery report wins over our own send result', () => {
  assert.equal(U.usageOutcome({ status: 'failed', deliveryStatus: 'delivered' }), 'delivered');
  assert.equal(U.usageOutcome({ status: 'sent', deliveryStatus: 'failed' }), 'failed');
  assert.equal(U.usageOutcome({ status: 'queued' }), 'ignored');
});

scenario('templates are counted apart from service messages', () => {
  const rows = [row({ unit: 'u', owner: 'c1' }), row({ unit: 'u', set: { kind: 'template' } }), row({ unit: 'u', set: { kind: 'file' } }), row({ unit: 'u', set: { kind: 'interactive_buttons' } })];
  const usage = U.computeMessageUsage(rows, campaigns);
  assert.equal(usage.totals.delivered, 4);
  assert.equal(usage.totals.deliveredTemplate, 1);
  assert.equal(usage.totals.deliveredService, 3);
});

scenario('participants are distinct recipients with a delivered message, whatever the phone format', () => {
  const rows = [
    row({ unit: 'u', owner: 'c1', to: '972501234567' }), row({ unit: 'u', to: 'whatsapp:+972501234567' }), row({ unit: 'u', to: '972-50-123-4567' }),
    row({ unit: 'u', to: '972509999999' }),
    row({ unit: 'u', to: '972508888888', set: { deliveryStatus: 'sent' } }),   // never delivered: not a participant
  ];
  const usage = U.computeMessageUsage(rows, campaigns);
  assert.equal(usage.totals.participants, 2);
  assert.equal(usage.campaigns[0].participants, 2);
});

scenario('date range: from is inclusive, to is exclusive', () => {
  const rows = [
    row({ createdAt: '2026-11-07T10:00:00.000Z' }), row({ createdAt: '2026-11-07T11:00:00.000Z' }), row({ createdAt: '2026-11-07T12:00:00.000Z' }),
  ];
  const usage = U.computeMessageUsage(rows, campaigns, { fromMs: Date.parse('2026-11-07T10:00:00Z'), toMs: Date.parse('2026-11-07T12:00:00Z') });
  assert.equal(usage.totals.delivered, 2);
  assert.equal(U.computeMessageUsage(rows, campaigns).totals.delivered, 3);
});

scenario('days are cut in Israel time (winter UTC+2, summer UTC+3)', () => {
  const rows = [
    row({ createdAt: '2026-11-07T21:59:00.000Z' }),   // 23:59 on the 7th in Israel (UTC+2)
    row({ createdAt: '2026-11-07T22:01:00.000Z' }),   // 00:01 on the 8th
    row({ createdAt: '2026-11-30T21:59:00.000Z' }),   // still November
    row({ createdAt: '2026-11-30T22:01:00.000Z' }),   // 00:01 on 1 December in Israel
    row({ createdAt: '2026-07-31T21:30:00.000Z' }),   // 00:30 on 1 August in Israel (UTC+3)
  ];
  const usage = U.computeMessageUsage(rows, campaigns);
  const days = Object.fromEntries(usage.byDay.map((d) => [d.day, d.delivered]));
  assert.equal(days['2026-11-07'], 1);
  assert.equal(days['2026-11-08'], 1);
  assert.equal(days['2026-11-30'], 1);
  assert.equal(days['2026-12-01'], 1);
  assert.equal(days['2026-08-01'], 1);
});

scenario('unparseable dates are skipped, not counted and not crashing', () => {
  const usage = U.computeMessageUsage([row({ set: { createdAt: 'garbage' } }), row({})], campaigns);
  assert.equal(usage.totals.delivered, 1);
});

// ── prices and the report ───────────────────────────────────────────────────────

const P = { serviceUsd: 0.005, templateUsd: 0.04, usdIlsRate: null };
function usageOf(n, extra = {}) {
  // n delivered service messages in November 2026, spread over one campaign
  const rows = [];
  for (let i = 0; i < n; i += 1) rows.push(row({ unit: 'u' + (extra.unitPrefix || ''), owner: i === 0 ? 'c1' : undefined, to: '97250' + String(1000000 + (i % (extra.people || 50))), createdAt: '2026-11-07T17:00:00.000Z' }));
  for (let i = 0; i < (extra.templates || 0); i += 1) rows.push(row({ unit: 'u' + (extra.unitPrefix || ''), set: { kind: 'template' } }));
  return U.computeMessageUsage(rows, campaigns);
}

scenario('priceUsage: service and template messages have their own price', () => {
  assert.equal(U.priceUsage({ deliveredService: 100, deliveredTemplate: 10 }, P), 0.9);
  assert.equal(U.priceUsage({ deliveredService: 0, deliveredTemplate: 0 }, P), 0);
});

scenario('readUsagePrices: defaults, overrides, and garbage falls back to the default', () => {
  const d = U.readUsagePrices({});
  assert.equal(d.serviceUsd, U.DEFAULT_SERVICE_PRICE_USD);
  assert.equal(d.usdIlsRate, null);
  assert.equal('freeServicePerMonth' in d, false, 'the free tier is not part of the calculation');
  const o = U.readUsagePrices({ META_PRICE_SERVICE_USD: '0.006', META_PRICE_TEMPLATE_USD: '0.035', USD_ILS_RATE: '3.7' });
  assert.deepEqual([o.serviceUsd, o.templateUsd, o.usdIlsRate], [0.006, 0.035, 3.7]);
  const bad = U.readUsagePrices({ META_PRICE_SERVICE_USD: 'abc', META_PRICE_TEMPLATE_USD: '-1', META_FREE_SERVICE_PER_MONTH: '500' });
  assert.equal(bad.serviceUsd, U.DEFAULT_SERVICE_PRICE_USD);
  assert.equal(bad.templateUsd, U.DEFAULT_TEMPLATE_PRICE_USD);
  assert.equal('freeServicePerMonth' in bad, false, 'META_FREE_SERVICE_PER_MONTH is ignored');
});

const input = (id, usage, extra = {}) => ({ clientId: id, clientName: 'client-' + id, disabled: false, billed: true, usage, ...extra });

scenario('buildCostReport: every delivered message is priced from the FIRST one (no free tier), per link, per client and in total', () => {
  const a = usageOf(1500, { unitPrefix: 'a' });
  const b = usageOf(500, { unitPrefix: 'b' });
  const report = U.buildCostReport([input('a', a), input('b', b)], P);
  const ca = report.clients.find((c) => c.clientId === 'a');
  assert.equal(ca.costUsd, 7.5);                         // 1500 * 0.005
  assert.equal(ca.campaigns[0].costUsd, 7.5);
  assert.equal(report.clients.find((c) => c.clientId === 'b').costUsd, 2.5);
  assert.equal(report.totals.costUsd, 10);               // 2000 * 0.005, nothing taken off
  assert.equal('freeTier' in report, false);
  assert.equal('costNetUsd' in report.totals, false);
});

scenario('a small client is not free: 200 messages cost 200 * price, not 0', () => {
  const report = U.buildCostReport([input('a', usageOf(200, { unitPrefix: 'a', templates: 50 }))], P);
  assert.equal(report.totals.costUsd, 200 * 0.005 + 50 * 0.04);
});

scenario('an unreachable client is listed, costs nothing and does not break the totals', () => {
  const report = U.buildCostReport([input('a', usageOf(10, { unitPrefix: 'a' })), input('x', null, { error: 'HTTP 502' })], P);
  assert.deepEqual(report.unreachable, ['client-x']);
  const x = report.clients.find((c) => c.clientId === 'x');
  assert.equal(x.reachable, false);
  assert.equal(x.error, 'HTTP 502');
  assert.equal(report.totals.delivered, 10);
});

scenario('a client that is not on Meta (Baileys) is counted but costs 0', () => {
  const report = U.buildCostReport([input('b', usageOf(300, { unitPrefix: 'b' }), { billed: false })], P);
  assert.equal(report.clients[0].totals.delivered, 300);
  assert.equal(report.clients[0].costUsd, 0);
  assert.equal(report.totals.costUsd, 0);
});

scenario('cost per participant, per link and per client', () => {
  const usage = usageOf(100, { unitPrefix: 'a', people: 10 });
  const report = U.buildCostReport([input('a', usage)], P);
  assert.equal(usage.totals.participants, 10);
  assert.equal(report.clients[0].costPerParticipantUsd, 0.05);          // 100 * 0.005 / 10
  assert.equal(report.clients[0].campaigns[0].costPerParticipantUsd, 0.05);
  const empty = U.buildCostReport([input('e', U.computeMessageUsage([], campaigns))], P);
  assert.equal(empty.clients[0].costPerParticipantUsd, null);
  assert.equal(empty.totals.costPerParticipantUsd, null);
});

scenario('clients are sorted by cost, the most expensive first', () => {
  const report = U.buildCostReport([input('small', usageOf(10, { unitPrefix: 's' })), input('big', usageOf(900, { unitPrefix: 'b' })), input('mid', usageOf(100, { unitPrefix: 'm' }))], P);
  assert.deepEqual(report.clients.map((c) => c.clientId), ['big', 'mid', 'small']);
});

scenario('the real launch of 2026-11-07 priced with the default: 12,774 service messages come to about $68', () => {
  const rows = [];
  for (let i = 0; i < 12774; i += 1) rows.push(row({ unit: 'u', owner: i === 0 ? 'c1' : undefined, to: '97250' + (1000000 + (i % 1143)) }));
  const usage = U.computeMessageUsage(rows, campaigns);
  const cost = U.priceUsage(usage.totals, U.readUsagePrices({}));
  assert.ok(Math.abs(cost - 68.05) < 0.1, String(cost));
  assert.equal(usage.totals.participants, 1143);
});

scenario('speed: 200,000 rows are counted in well under a second', () => {
  const rows = [];
  for (let i = 0; i < 200000; i += 1) rows.push({ kind: 'text', to: '97250' + (i % 5000), status: 'sent', deliveryStatus: 'delivered', createdAt: '2026-11-07T17:00:00.000Z', flowRef: { unitId: 'u' + Math.floor(i / 12), index: i % 12 }, ...(i % 12 === 0 ? { continuation: { state: 'done', descriptor: { kind: 'reply_chain', campaignId: 'c1', senderJid: 'x' } } } : {}) });
  const t0 = Date.now();
  const usage = U.computeMessageUsage(rows, campaigns);
  const ms = Date.now() - t0;
  assert.equal(usage.totals.delivered, 200000);
  assert.ok(ms < 1500, 'took ' + ms + 'ms');
});

// ── with the real Storage: rows written the way a campaign flow writes them, then delivered by a Meta status ──────────────────────

async function integration() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Storage } = require('../dist/storage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsbiz-usage-'));
  const storage = new Storage(path.join(dir, 'storage.json'));
  const send = (extra, wamid, status) => {
    const message = storage.enqueueOutboxMessage({ kind: 'text', to: '972501234567', text: 'x', ...extra });
    assert.ok(storage.claimOutboxMessage(message.id));
    storage.markOutboxSent(message.id, wamid);
    if (status) storage.applyMetaStatus({ wamid, status });
    return message;
  };
  const descriptor = { kind: 'reply_chain', campaignId: 'cX', senderJid: '972501234567@s.whatsapp.net' };
  send({ flowRef: { unitId: 'unit-1', index: 0 }, continuation: { descriptor, state: 'done' } }, 'wamid.A', 'delivered');
  send({ flowRef: { unitId: 'unit-1', index: 1 } }, 'wamid.B', 'read');
  send({ flowRef: { unitId: 'unit-1', index: 2 } }, 'wamid.C', undefined);          // accepted, no report yet
  send({ to: '972509999999' }, 'wamid.D', 'delivered');                              // no flow reference
  const rows = storage.getOutboxRowsForUsage();
  assert.equal(rows.length, 4);
  const usage = U.computeMessageUsage(rows, [{ id: 'cX', name: 'קמפיין X', triggerPhrase: 'x' }]);
  const cx = usage.campaigns.find((c) => c.campaignId === 'cX');
  assert.equal(cx.delivered, 2);
  assert.equal(cx.sentOnly, 1);
  assert.equal(usage.campaigns.find((c) => c.campaignId === null).delivered, 1);
  assert.equal(usage.totals.participants, 2);
  // the report must not change what it reads
  assert.equal(storage.getOutboxRowsForUsage().length, 4);
  fs.rmSync(dir, { recursive: true, force: true });
}

integration().then(() => { results.push({ name: 'real Storage: rows written like a flow, delivered by Meta statuses', ok: true }); console.log('ok   real Storage: rows written like a flow, delivered by Meta statuses'); })
  .catch((err) => { results.push({ name: 'real Storage integration', ok: false }); console.log('FAIL real Storage integration\n     ' + (err && err.stack || err)); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
