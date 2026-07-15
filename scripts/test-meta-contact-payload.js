const assert = require('node:assert/strict');
const { buildMetaContactFromVCard } = require('../dist/providers/MetaCloudProvider');

const international = buildMetaContactFromVCard([
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Avia Barzani',
  'TEL;TYPE=CELL,VOICE:+972-50-123-4567',
  'END:VCARD',
].join('\r\n'), 'Fallback');

assert.deepEqual(international.phones, [{
  phone: '+972-50-123-4567',
  type: 'CELL',
  wa_id: '972501234567',
}]);

const local = buildMetaContactFromVCard([
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Hani Attias',
  'TEL;TYPE=CELL:050-765-4321',
  'END:VCARD',
].join('\r\n'), 'Fallback');

assert.deepEqual(local.phones, [{
  phone: '050-765-4321',
  type: 'CELL',
  wa_id: '972507654321',
}]);

console.log('Meta contact payload tests passed.');
