/**
 * Combined export: several campaigns (links) of one client -> one Excel and one contacts (VCF) file, in addition to the per-campaign ones.
 * Also the descriptive download names for the contacts (VCF) and results (CSV) files.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'combined-export-'));
process.env.NODE_ENV = 'test';
process.env.PORT = String(34000 + Math.floor(Math.random() * 3000));
process.env.CLIENT_ACCESS_TOKEN = 'combined-export-test-token';
process.env.STORAGE_PATH = path.join(dir, 'storage.json');

const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { Storage } = require('../dist/storage');
const { startAdminServer } = require('../dist/adminServer');

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.stack || String(e)).split('\n').slice(0, 5).join(' | ')]); }
}

const flow = [
  { id: 's1', kind: 'message', text: 'Welcome to the activity', nextStepId: 's2' },
  { id: 's2', kind: 'question', presentation: 'buttons', text: 'Want to enter the raffle?', options: [{ id: 'yes', text: 'Yes please', raffleEntry: true }, { id: 'no', text: 'No thanks' }] },
];
const mkCampaign = (storage, name, phrase, conversation) => storage.addCampaign({
  name, triggerType: 1, triggerPhrase: phrase, suffix: ' - (Bot)', active: true,
  conversation: { askNameEnabled: false, nameTimeoutMinutes: 5, askNameText: '', replyText: 'hi', followupMessages: [], decisionFlow: conversation ?? flow },
});

(async () => {
  const storage = new Storage(path.join(dir, 'storage.json'));
  const A = mkCampaign(storage, 'Link A / Dudi', 'link-a');
  const B = mkCampaign(storage, 'Link B', 'link-b');
  const C = mkCampaign(storage, 'Link C', 'link-c');
  const phones = { p1: '972500500001', p2: '972500500002', p3: '972500500003', p4: '972500500004', p5: '972500500005' };
  const enter = (campaign, phone, name) => storage.recordCampaignTrigger(campaign.id, phone, name);
  const ev = (campaign, result, type, label, dedupeKey) => storage.recordCampaignEvent({ campaignId: campaign.id, campaignResultId: result.id, phone: result.phone, type, label, dedupeKey });
  const rA1 = enter(A, phones.p1, 'Person One');
  const rA2 = enter(A, phones.p2, 'Person Two');
  const rB2 = enter(B, phones.p2, 'Person Two');   // the same woman entered through a second link
  const rB3 = enter(B, phones.p3, 'Person Three');
  const rC4 = enter(C, phones.p4, 'Person Four');
  const rC5 = enter(C, phones.p5, 'Person Five');
  for (const [c, r] of [[A, rA1], [A, rA2], [B, rB2], [B, rB3], [C, rC4], [C, rC5]]) ev(c, r, 'step_sent', 'Welcome to the activity');
  ev(A, rA1, 'raffle_entry', 'x', 'raffle_entry:s2:yes');
  ev(B, rB2, 'raffle_entry', 'x', 'raffle_entry:s2:yes');
  ev(C, rC4, 'raffle_entry', 'x', 'raffle_entry:s2:yes');
  ev(A, rA2, 'raffle_entry', 'x', 'raffle_entry:s2:yes');   // p2 also entered the raffle in A (counted once overall)
  storage.recordCampaignEmail(rC4.id, 'four@example.com');
  ev(C, rC4, 'email_captured', 'four@example.com', 'email_captured:s9');
  await storage.flush();

  startAdminServer(storage);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const base = `http://127.0.0.1:${process.env.PORT}`;
  const login = await fetch(`${base}/auth/client/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: process.env.CLIENT_ACCESS_TOKEN }) });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const get = (p, auth = true) => fetch(`${base}${p}`, { headers: auth ? { cookie } : {} });
  const ids = (...cs) => cs.map((c) => c.id).join(',');
  const disposition = (res) => {
    const header = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(header);
    return { header, utf8: m ? decodeURIComponent(m[1]) : null, ascii: (/filename="([^"]+)"/.exec(header) || [])[1] };
  };
  const loadXlsx = async (res) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer())); return wb; };

  await scenario('access: the combined routes need a login; "combined" is not read as a campaign id', async () => {
    assert.equal((await get(`/api/campaign-results/combined/export.xls?ids=${ids(A, B)}`, false)).status, 401);
    assert.equal((await get(`/api/campaign-results/combined/export.vcf?ids=${ids(A, B)}`, false)).status, 401);
  });

  await scenario('validation: fewer than two ids -> 400, unknown id -> 404 with the id, more than 30 -> 400; duplicates are collapsed', async () => {
    const one = await get(`/api/campaign-results/combined/export.xls?ids=${A.id}`);
    assert.equal(one.status, 400);
    assert.match((await one.json()).error, /שני קמפיינים/);
    assert.equal((await get('/api/campaign-results/combined/export.xls')).status, 400);
    const missing = await get(`/api/campaign-results/combined/export.vcf?ids=${A.id},nope123`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /nope123/);
    const many = Array.from({ length: 31 }, (_v, i) => `c${i}`).join(',');
    assert.equal((await get(`/api/campaign-results/combined/export.xls?ids=${many}`)).status, 400);
    assert.equal((await get(`/api/campaign-results/combined/export.xls?ids=${A.id},${A.id}`)).status, 400, 'the same id twice is one campaign, not two');
  });

  await scenario('combined Excel: unified sheets, each phone once, raffle counted once, emails, technical tabs keep the campaign name', async () => {
    const res = await get(`/api/campaign-results/combined/export.xls?ids=${ids(A, B, C)}`);
    assert.equal(res.status, 200);
    const d = disposition(res);
    assert.match(d.utf8, /^קמפיינים מאוחדים \(3\) - \d{4}-\d{2}-\d{2}\.xlsx$/);
    assert.match(d.ascii, /^campaign-combined-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = await loadXlsx(res);
    const names = wb.worksheets.map((w) => w.name);
    for (const n of ['תמונת מצב', 'הגרלות', 'משתתפות', 'כתובות מייל', 'משפך', 'הסברים', 'טכני - אירועים מלאים', 'טכני - נתונים מלאים']) assert.ok(names.includes(n), `sheet ${n}`);
    const overview = {};
    wb.getWorksheet('תמונת מצב').eachRow((row) => { const k = row.getCell(1).value; if (typeof k === 'string') overview[k] = row.getCell(2).value; });
    assert.equal(overview['נכנסו לקמפיין'], 5, '6 entries, 5 different phones');
    assert.equal(wb.getWorksheet('משתתפות').rowCount, 1 + 5);
    assert.equal(wb.getWorksheet('הגרלות').rowCount, 3 + 3, 'raffle sheet: title block (3 rows) + 3 distinct entrants (p1, p2, p4; p2 entered in two links)');
    const raffleMetric = Object.entries(overview).find(([k]) => /^הגרלה\s+\S/.test(k));
    assert.equal(raffleMetric[1], 3, 'p1, p2 and p4 entered; p2 entered twice but counts once');
    const mailRow = wb.getWorksheet('כתובות מייל').getRow(2);
    assert.equal(mailRow.getCell(4).value, 'four@example.com');
    assert.match(String(wb.getWorksheet('תמונת מצב').getCell('A1').value), /קמפיינים מאוחדים \(3\)/);
    let noteFound = false;
    wb.getWorksheet('תמונת מצב').eachRow((row) => { if (/אוחדו 3 קמפיינים/.test(String(row.getCell(1).value ?? ''))) noteFound = true; });
    assert.ok(noteFound, 'the sheet says which campaigns were merged');
    const eventNames = new Set();
    wb.getWorksheet('טכני - אירועים מלאים').eachRow((row, n) => { if (n > 1) eventNames.add(row.getCell(1).value); });
    assert.deepEqual([...eventNames].sort(), ['Link A / Dudi', 'Link B', 'Link C'], 'technical rows keep the real campaign');
  });

  await scenario('combined VCF: one contact per phone across all links, descriptive Hebrew name', async () => {
    const res = await get(`/api/campaign-results/combined/export.vcf?ids=${ids(C, A, B)}`);   // order of ids does not matter
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/vcard/);
    const d = disposition(res);
    assert.match(d.utf8, /^קמפיינים מאוחדים \(3\) - אנשי קשר - \d{4}-\d{2}-\d{2}\.vcf$/);
    assert.match(d.ascii, /^campaign-combined-\d{4}-\d{2}-\d{2}-contacts\.vcf$/);
    const text = await res.text();
    assert.equal((text.match(/BEGIN:VCARD/g) || []).length, 5, 'five distinct phones, p2 only once');
    for (const phone of Object.values(phones)) assert.equal((text.match(new RegExp(phone.replace(/\D/g, '').slice(-9), 'g')) || []).length, 1, `phone ${phone} exactly once`);
  });

  await scenario('per-campaign downloads still work and now carry descriptive names (VCF and CSV); the Excel name is unchanged', async () => {
    const vcf = await get(`/api/campaign-results/${A.id}/export.vcf`);
    assert.equal(vcf.status, 200);
    const dv = disposition(vcf);
    assert.match(dv.utf8, /^Link A - Dudi - אנשי קשר - \d{4}-\d{2}-\d{2}\.vcf$/, 'the slash in the campaign name is made safe');
    assert.equal(dv.ascii, `campaign-${A.id}-contacts.vcf`);
    assert.equal(((await vcf.text()).match(/BEGIN:VCARD/g) || []).length, 2);
    const csv = await get(`/api/campaign-results/${B.id}/export`);
    assert.equal(csv.status, 200);
    const dc = disposition(csv);
    assert.match(dc.utf8, /^Link B - תוצאות - \d{4}-\d{2}-\d{2}\.csv$/);
    const xls = await get(`/api/campaign-results/${C.id}/export.xls`);
    assert.equal(xls.status, 200);
    assert.match(disposition(xls).utf8, /^Link C - \d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = await loadXlsx(xls);
    assert.ok(wb.worksheets.map((w) => w.name).includes('תמונת מצב'));
    assert.equal(wb.getWorksheet('משתתפות').rowCount, 1 + 2, 'a single campaign still reports only its own people');
    assert.equal((await get('/api/campaign-results/nope/export.vcf')).status, 404);
  });

  const metricRow = (wb, label) => {
    let found;
    wb.getWorksheet('טכני - מדדים').eachRow((row) => { if (row.getCell(1).value === label) found = { people: row.getCell(2).value, events: row.getCell(3).value, percent: row.getCell(4).value }; });
    return found;
  };

  await scenario('technical metrics tab counts PEOPLE (by phone) in a merge, like the friendly sheets: a woman who came through two links is one', async () => {
    const res = await get(`/api/campaign-results/combined/export.xls?ids=${ids(A, B, C)}`);
    const wb = await loadXlsx(res);
    const started = metricRow(wb, 'התחילו קמפיין');
    assert.equal(started.people, 5, '6 entries but 5 different phones');
    const reached = metricRow(wb, 'קיבלו שלב או הודעה');
    assert.equal(reached.people, 5, 'unique people, not 6');
    assert.equal(reached.events, 6, 'events are still every event');
    assert.equal(reached.percent, '100%', 'share of all participants stays within 100%');
    const raffle = metricRow(wb, 'נכנסו להגרלה');
    assert.equal(raffle.people, 3, 'p1, p2, p4 - p2 entered in two links');
    assert.equal(wb.getWorksheet('טכני - נתונים מלאים').rowCount >= 1 + 6, true, 'the detail tab keeps one row per entry (with its campaign)');
  });

  await scenario('different step ids but the same questions: each event is placed through ITS OWN campaign (funnel counts both, not only the first campaign)', async () => {
    const mk = (idA, idB) => [
      { id: idA, kind: 'message', text: 'Same opening text', nextStepId: idB },
      { id: idB, kind: 'question', presentation: 'buttons', text: 'Same question text', options: [{ id: 'yes', text: 'Yes', raffleEntry: true }] },
    ];
    const F1 = mkCampaign(storage, 'Flow one', 'flow-one', mk('x1', 'x2'));
    const F2 = mkCampaign(storage, 'Flow two', 'flow-two', mk('y1', 'y2'));
    const r1 = enter(F1, '972500500021', 'One'); const r2 = enter(F2, '972500500022', 'Two');
    ev(F1, r1, 'step_sent', 'Same opening text'); ev(F2, r2, 'step_sent', 'Same opening text');
    ev(F1, r1, 'step_answered', 'Yes', 'step_answered:x2:yes'); ev(F2, r2, 'step_answered', 'Yes', 'step_answered:y2:yes');
    ev(F1, r1, 'raffle_entry', 'x', 'raffle_entry:x2:yes'); ev(F2, r2, 'raffle_entry', 'x', 'raffle_entry:y2:yes');
    await storage.flush();
    const wb = await loadXlsx(await get(`/api/campaign-results/combined/export.xls?ids=${ids(F1, F2)}`));
    const rows = {};
    wb.getWorksheet('משפך').eachRow((row, n) => { if (n >= 4) rows[String(row.getCell(1).value)] = row.getCell(2).value; });
    assert.equal(rows['נכנסו לקמפיין'], 2);
    assert.equal(rows['שלב 2 – ענו או לחצו'], 2, 'the answer of the SECOND campaign (step id y2) is placed too');
    const raffleLabel = Object.keys(rows).find((k) => k.startsWith('נכנסו להגרלה'));
    assert.equal(rows[raffleLabel], 2);
    let note = '';
    wb.getWorksheet('תמונת מצב').eachRow((row) => { if (/אוחדו 2 קמפיינים/.test(String(row.getCell(1).value ?? ''))) note = String(row.getCell(1).value); });
    assert.ok(!/אין להם מקביל/.test(note), 'every step has a counterpart - no warning about unplaced steps');
  });

  await scenario('campaigns with different flows: the merge still works and the sheet warns that the funnel follows the first campaign', async () => {
    const other = mkCampaign(storage, 'Other flow', 'other-flow', [{ id: 'o1', kind: 'message', text: 'A totally different opening' }]);
    const r = enter(other, '972500500009', 'Different');
    ev(other, r, 'step_sent', 'A totally different opening');
    await storage.flush();
    const res = await get(`/api/campaign-results/combined/export.xls?ids=${ids(A, other)}`);
    assert.equal(res.status, 200);
    const wb = await loadXlsx(res);
    let warned = false;
    wb.getWorksheet('תמונת מצב').eachRow((row) => { if (/הזרימות אינן זהות/.test(String(row.getCell(1).value ?? ''))) warned = true; });
    assert.ok(warned);
    let note = '';
    wb.getWorksheet('תמונת מצב').eachRow((row) => { if (/אוחדו 2 קמפיינים/.test(String(row.getCell(1).value ?? ''))) note = String(row.getCell(1).value); });
    assert.match(note, /אין להם מקביל/, 'steps with no counterpart are called out');
    assert.equal(wb.getWorksheet('משתתפות').rowCount, 1 + 3);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  let failed = 0;
  for (const [name, status, detail] of results) { console.log(`${status}  ${name}${detail ? '\n      ' + detail : ''}`); if (status !== 'PASS') failed += 1; }
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nCombined export tests passed (${results.length} scenarios).`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
