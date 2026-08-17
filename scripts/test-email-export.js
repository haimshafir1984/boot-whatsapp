'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = String(32000 + Math.floor(Math.random() * 5000));
process.env.CLIENT_ACCESS_TOKEN = 'email-export-test-token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { Storage } = require('../dist/storage');
const { startAdminServer } = require('../dist/adminServer');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-export-'));
  try {
    const storage = new Storage(path.join(dir, 'storage.json'));
    const campaign = storage.addCampaign({
      name: 'Email export',
      triggerType: 1,
      triggerPhrase: 'email-export',
      suffix: '',
      active: true,
    });
    const result = storage.recordCampaignTrigger(campaign.id, '972500000004', 'Participant');
    storage.recordCampaignEmail(result.id, 'person@example.com');
    storage.recordCampaignEvent({
      campaignId: campaign.id,
      campaignResultId: result.id,
      phone: result.phone,
      type: 'email_captured',
      label: 'person@example.com',
    });

    startAdminServer(storage);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const login = await fetch(`http://127.0.0.1:${process.env.PORT}/auth/client/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessCode: process.env.CLIENT_ACCESS_TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie);
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/campaign-results/${campaign.id}/export.xls`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));

    const emailSheet = workbook.getWorksheet('כתובות מייל');
    assert.ok(emailSheet, 'email worksheet should exist');
    assert.deepEqual(emailSheet.getRow(1).values.slice(1, 7), ['שם', 'טלפון', 'מייל', 'מועד קליטה', 'ניקוד', 'קמפיין']);
    assert.equal(emailSheet.getRow(2).getCell(3).value, 'person@example.com');

    const peopleSheet = workbook.getWorksheet('משתתפים ושלבים');
    assert.ok(peopleSheet, 'people worksheet should exist');
    assert.equal(peopleSheet.getRow(1).getCell(3).value, 'מייל');
    assert.equal(peopleSheet.getRow(2).getCell(3).value, 'person@example.com');

    const detailsSheet = workbook.getWorksheet('נתונים מלאים');
    assert.ok(detailsSheet, 'full details worksheet should exist');
    assert.equal(detailsSheet.getRow(1).getCell(4).value, 'מייל');
    assert.equal(detailsSheet.getRow(2).getCell(4).value, 'person@example.com');

    console.log('Email export tests passed.');
    process.exitCode = 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    setImmediate(() => process.exit(process.exitCode || 0));
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  process.exit(1);
});
