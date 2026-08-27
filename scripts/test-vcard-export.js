const assert = require('assert');

const {
  buildContactsVCard,
  normalizeCampaignContactPhone,
  resolveCampaignContactName,
} = require('../dist/adminServer');

assert.strictEqual(normalizeCampaignContactPhone('+972-50-123-4567'), '972501234567');
assert.strictEqual(normalizeCampaignContactPhone('0501234567'), '972501234567');

const savedContacts = new Map([['972501234567', 'שם מאנשי הקשר']]);
assert.strictEqual(
  resolveCampaignContactName({ phone: '0501234567', fallbackName: 'שם מהקמפיין', whatsappName: 'שם WhatsApp' }, savedContacts),
  'שם מאנשי הקשר',
);
assert.strictEqual(
  resolveCampaignContactName({ phone: '972509876543', fallbackName: 'תהילה - (קמפיין)', whatsappName: 'תהילה' }, savedContacts),
  'תהילה - (קמפיין)',
);
assert.strictEqual(
  resolveCampaignContactName({ phone: '972505555555', whatsappName: 'נועה יצחקי' }, savedContacts),
  'נועה יצחקי',
);

const vcard = buildContactsVCard([
  { name: 'תהילה - (קמפיין)', phone: '972509876543' },
  { name: 'נועה יצחקי - (הניה בל)', phone: '+972501112222' },
]);
assert(vcard.includes('FN:תהילה - (קמפיין)'));
assert(vcard.includes('TEL;TYPE=CELL:+972509876543'));
assert(vcard.includes('FN:נועה יצחקי - (הניה בל)'));

console.log('Campaign VCF export regression test passed.');
