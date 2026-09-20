#!/usr/bin/env node
/**
 * Sequential regression runner with a manifest, per-test timeout, scrubbed env
 * and a JSON report. Requires `npm run build` first (tests run against dist/).
 *   node scripts/run-regression.js <out.json> [--group=all|<substring>] [--extra=a.js,b.js]
 * Exit 0: all pass. 1: a failure/timeout. 3: no failure but a BLOCKED (exit 3) or
 * a test that printed a skip marker - never reported as green.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MANIFEST = fs.readFileSync(path.join(__dirname, 'regression-manifest.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
// A manifest line may end with '# flaky-teardown': known Windows/Node libuv assertion at process exit AFTER the test finished.
const FLAKY = new Set(MANIFEST.filter((l) => /#\s*flaky/.test(l)).map((l) => l.split('#')[0].trim()));
for (let i = 0; i < MANIFEST.length; i++) MANIFEST[i] = MANIFEST[i].split('#')[0].trim();
const out = process.argv[2];
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const group = arg('group') || 'all';
const extra = (arg('extra') || '').split(',').filter(Boolean);
const list = [...MANIFEST.filter((s) => group === 'all' || s.includes(group)), ...extra];
const SCRUB = /^(DATABASE_URL|META_|DOKPLOY_|TWILIO_|GOOGLE_|SMTP_|ALERT_SMTP_|SYSTEM_ALERT_|OWNER_ACCESS_TOKEN|CLIENT_ACCESS_TOKEN|WHATSAPP_PROVIDER|STORAGE_PATH|SESSION_PATH|CONVERSATION_STATE_PATH|UPLOADS_PATH|OWNER_STORAGE_PATH)/;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.test(k)));
env.NODE_ENV = 'test';
const report = { startedAt: new Date().toISOString(), head: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), results: [] };
for (const script of list) {
  const cwd = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
  const t0 = Date.now();
  const attempts = [];
  let r, text;
  for (let a = 1; a <= (FLAKY.has(script) ? 3 : 1); a++) {
    r = spawnSync(process.execPath, [path.join('scripts', script)], { cwd, env: { ...env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 << 20 });
    text = (r.stdout || '') + (r.stderr || '');
    attempts.push(r.status);
    if (r.status === 0) break;
  }
  const skipMarker = /\b(SKIP(PED)?|BLOCKED)\b/.test(text);
  let status = r.error ? 'TIMEOUT/ERROR' : r.status === 0 ? (skipMarker ? 'SKIP-MARKER' : 'PASS') : r.status === 3 ? 'BLOCKED' : 'FAIL';
  const crashes = attempts.filter((x) => x !== 0).length;
  if (status === 'PASS' && crashes) status = 'PASS-FLAKY'; // reported, never silent
  report.results.push({ script, status, exit: r.status, attempts: attempts.length > 1 ? attempts : undefined, ms: Date.now() - t0, tail: status === 'PASS' ? undefined : text.split('\n').slice(-8).join('\n') });
  console.log(status.padEnd(12), script, `${Date.now() - t0}ms`);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
}
const c = (s) => report.results.filter((x) => x.status === s).length;
report.summary = { total: report.results.length, pass: c('PASS') + c('PASS-FLAKY'), flakyTeardown: c('PASS-FLAKY'), fail: c('FAIL') + c('TIMEOUT/ERROR'), blocked: c('BLOCKED'), skipMarker: c('SKIP-MARKER') };
console.log(JSON.stringify(report.summary));
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(report.summary.fail ? 1 : (report.summary.blocked || report.summary.skipMarker) ? 3 : 0);
