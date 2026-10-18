'use strict';
// The plain-language report sheets are derived from the flow definition + events, never from campaign-specific text.
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { addFriendlyReportSheets, israelWallClock, orderFlowSteps } = require('../dist/campaignFriendlyReport');

assert.equal(israelWallClock('2026-10-18T06:44:00Z').toISOString(), '2026-10-18T09:44:00.000Z', 'summer time is UTC+3');
assert.equal(israelWallClock('2026-12-01T06:44:00Z').toISOString(), '2026-12-01T08:44:00.000Z', 'winter time is UTC+2');
assert.equal(israelWallClock(''), null);

const flow = [
  { id: 'a', kind: 'message', text: 'welcome *friends*', nextStepId: 'q1' },
  { id: 'z', kind: 'message', text: 'unreachable' },
  { id: 'q1', kind: 'score_question', text: 'Question one?\nmore', options: [{ id: 'o', text: 'yes', nextStepId: 'c' }] },
  { id: 'c', kind: 'question', text: 'Join the raffle?', options: [{ id: 'r', text: 'yes', raffleEntry: true }, { id: 'r2', text: 'share', raffleEntry: true }] },
];
assert.deepEqual(orderFlowSteps(flow).map((s) => s.id), ['a', 'q1', 'c', 'z']);

const campaign = { id: 'camp', name: 'Camp', conversation: { decisionFlow: flow } };
const mk = (id, phone, status, extra = {}) => ({ id, phone, status, triggeredAt: '2026-10-18T06:44:00Z', updatedAt: '2026-10-18T06:50:00Z', ...extra });
const results = [mk('r1', '972500000001', 'saved', { scoreTotal: 4, email: 'a@b.co', emailCollectedAt: '2026-10-18T07:00:00Z' }),
  mk('r1b', '972500000001', 'saved'), mk('r2', '972500000002', 'saved'), mk('r3', '972500000003', 'pending')];
const ev = (n, phone, resultId, type, label, dedupeKey, at) => ({ id: `e${n}`, campaignId: 'camp', campaignResultId: resultId, phone, type, label, dedupeKey, createdAt: at });
const events = [
  ev(1, '972500000001', 'r1', 'step_sent', 'welcome *friends*', undefined, '2026-10-18T06:45:00Z'),
  ev(2, '972500000001', 'r1', 'step_sent', 'Question one?\nmore', undefined, '2026-10-18T06:46:00Z'),
  ev(3, '972500000001', 'r1', 'score_answered', 'yes', 'score_answered:q1:o', '2026-10-18T06:47:00Z'),
  ev(4, '972500000001', 'r1b', 'step_sent', 'Join the raffle?', undefined, '2026-10-18T06:48:00Z'),
  ev(5, '972500000001', 'r1', 'raffle_entry', 'Raffle A', 'raffle_entry:c:r', '2026-10-18T06:49:00Z'),
  ev(6, '972500000001', 'r1', 'raffle_entry', 'Raffle B', 'raffle_entry:c:r2', '2026-10-18T06:50:00Z'),
  ev(7, '972500000001', 'r1', 'completed', undefined, undefined, '2026-10-18T06:51:00Z'),
  ev(8, '972500000002', 'r2', 'step_sent', 'welcome *friends*', undefined, '2026-10-18T06:45:00Z'),
  ev(9, '972500000002', 'r2', 'raffle_entry', 'Raffle A', 'raffle_entry:c:r', '2026-10-18T06:55:00Z'),
];

(async () => {
  const wb = new ExcelJS.Workbook();
  addFriendlyReportSheets(wb, { campaign, results, events, displayName: (r) => `name-${r.phone}`, generatedAt: new Date('2026-10-18T07:30:00Z') });
  const roundTrip = new ExcelJS.Workbook(); await roundTrip.xlsx.load(await wb.xlsx.writeBuffer());
  assert.deepEqual(roundTrip.worksheets.map((w) => w.name), ['תמונת מצב', 'הגרלות', 'משתתפות', 'כתובות מייל', 'משפך', 'הסברים']);

  const overview = roundTrip.getWorksheet('תמונת מצב');
  const metrics = {}; overview.eachRow((row) => { const k = row.getCell(1).value; if (typeof k === 'string') metrics[k] = row.getCell(2).value; });
  assert.equal(metrics['נכנסו לקמפיין'], 3, 'phones are counted once');
  assert.equal(metrics['אנשי קשר שנשמרו'], 2);
  assert.equal(metrics['הגרלה א: yes'], 2);
  assert.equal(metrics['הגרלה ב: share'], 1);
  assert.equal(metrics['זכאים לפחות להגרלה אחת'], 2, 'union without duplicates');
  assert.equal(metrics['סיימו את כל התהליך'], 1);
  assert.equal(metrics['ענו על כל 1 שאלות הניקוד'], 1);
  assert.match(String(overview.getCell('A2').value), /18\.10\.2026 בשעה 10:30/);

  const raffles = roundTrip.getWorksheet('הגרלות');
  assert.equal(raffles.getRow(4).getCell(3).value, '972500000001');
  assert.equal(raffles.getRow(4).getCell(4).value, 'כן');
  assert.equal(raffles.getRow(5).getCell(6).value, 'לא');

  const people = roundTrip.getWorksheet('משתתפות');
  assert.equal(people.rowCount, 4, 'header + 3 people');
  assert.equal(people.getRow(2).getCell(5).value, 'סיימה את כל התהליך');
  assert.match(String(people.getRow(3).getCell(5).value), /^הגיעה לשלב 1: welcome friends$/);
  assert.equal(people.getRow(4).getCell(5).value, 'התחילה, לא התקדמה');
  assert.equal(people.getRow(2).getCell(4).value.toISOString(), '2026-10-18T09:44:00.000Z');

  const mails = roundTrip.getWorksheet('כתובות מייל');
  assert.equal(mails.getRow(2).getCell(4).value, 'a@b.co');

  const funnel = roundTrip.getWorksheet('משפך');
  const rows = []; funnel.eachRow((row, n) => { if (n >= 4) rows.push([row.getCell(1).value, row.getCell(2).value]); });
  assert.deepEqual(rows[0], ['נכנסו לקמפיין', 3]);
  assert.deepEqual(rows.find((r) => /שלב 2 – קיבלו/.test(r[0]))[1], 1);
  assert.equal(rows.find((r) => /שלב 2 – ענו/.test(r[0]))[1], 1);

  // a campaign with no raffles / no mails: sheets degrade without errors
  const bare = new ExcelJS.Workbook();
  addFriendlyReportSheets(bare, { campaign: { id: 'x', name: '=bad', conversation: { decisionFlow: [] } }, results: [], events: [], displayName: () => '' });
  assert.deepEqual(bare.worksheets.map((w) => w.name), ['תמונת מצב', 'משתתפות', 'כתובות מייל', 'משפך', 'הסברים']);
  assert.equal(bare.getWorksheet('תמונת מצב').getCell('A1').value, "תוצאות קמפיין – =bad");
  console.log('Friendly report tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
