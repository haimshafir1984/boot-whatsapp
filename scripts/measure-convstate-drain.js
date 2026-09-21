// Design-time measurement (stage E, section E): the SECOND synchronous cost of a conversation change in PostgreSQL mode -
// database.ts cloneSnapshotForTables() re-clones the ENTIRE conversationStateSnapshot on every drain cycle (it is not in the
// row-tracked list). Run ONE N per process: N=1200 OUT=out.json node scripts/measure-convstate-drain.js
const { cloneSnapshotForTables } = require('../dist/database');
const { emptyStorageData } = require('../dist/storage');
const N = Number(process.env.N || 1200);
const perc = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const conversations = {};
for (let i = 0; i < N; i++) { const jid = 'whatsapp:9725' + String(i).padStart(8, '0'); conversations[jid] = { kind: 'expired-decision', senderJid: jid, senderPhone: jid.slice(9), campaignId: 'c1', campaignResultId: 'r' + i, stepId: 'step1', timestamp: Date.now() }; }
const data = { ...emptyStorageData(), conversationStateSnapshot: { version: 1, savedAt: new Date().toISOString(), conversations } };
const previous = cloneSnapshotForTables(null, data, 'all');
const samples = [];
for (let r = 0; r < 40; r++) {
  const jid = 'whatsapp:9725' + String(r % N).padStart(8, '0');
  data.conversationStateSnapshot.conversations[jid] = { ...data.conversationStateSnapshot.conversations[jid], timestamp: Date.now() + r };
  const t0 = process.hrtime.bigint();
  cloneSnapshotForTables(previous, data, new Set(['conversationStateSnapshot']), { conversationStateSnapshot: new Set([jid]) });
  samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const row = { N, cloneSnapshotForTablesMs: { median: +perc(samples, 50).toFixed(2), p95: +perc(samples, 95).toFixed(2), max: +Math.max(...samples).toFixed(2) } };
console.log(JSON.stringify(row));
if (process.env.OUT) require('node:fs').writeFileSync(process.env.OUT, JSON.stringify(row));
