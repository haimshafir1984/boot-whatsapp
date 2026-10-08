#!/usr/bin/env node
// Summarise a V8 .cpuprofile: top self-time functions and top "owner" files. node scripts/lib/summarize-cpuprofile.js <file> [topN]
const fs = require('node:fs');
const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const top = Number(process.argv[3] || 25);
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = prof.timeDeltas; const samples = prof.samples;
for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) || 0) + (dt[i] || 0));
const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
const fn = new Map(); const file = new Map();
for (const [id, us] of self) {
  const n = byId.get(id); const cf = n.callFrame; const f = (cf.url || '(native)').replace(/^file:\/\/\//, '').split(/[\/]/).slice(-2).join('/');
  const key = `${cf.functionName || '(anonymous)'}  ${f}:${cf.lineNumber + 1}`;
  fn.set(key, (fn.get(key) || 0) + us); file.set(f, (file.get(f) || 0) + us);
}
const show = (m, title) => { console.log(`\n== ${title} (total sampled ${(total / 1e6).toFixed(1)}s)`); for (const [k, us] of [...m].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(100 * us / total).toFixed(1).padStart(5)}%  ${(us / 1e6).toFixed(2).padStart(7)}s  ${k}`); };
show(fn, 'self time by function'); show(file, 'self time by file');
