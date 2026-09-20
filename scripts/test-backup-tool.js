/**
 * Tests for scripts/ops/backup.js (stage A).
 *
 * IMPORTANT - what is and is not proven here:
 *  - File volumes, encryption, manifest, checksums, retention, freshness, restore
 *    guards: tested for real (real files, real tar, real AES-GCM).
 *  - The DB *plumbing* (argv/env handling, version guard, exit codes) is tested
 *    with a FAKE pg_dump/pg_restore. That proves the wrapper, NOT PostgreSQL
 *    backup/restore. Those are labelled "fake-binary".
 *  - The real dump -> restore -> compare round trip needs PostgreSQL client tools
 *    plus a disposable PostgreSQL server/cluster owned by this test. When they
 *    are missing it reports BLOCKED and the process exits with code 3. It is
 *    never a silent skip and never counted as a pass.
 *
 * Exit: 0 all pass, 1 any failure, 3 no failure but at least one BLOCKED.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const B = require('./ops/backup.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-tool-test-'));
const KEY = crypto.randomBytes(32).toString('hex');
process.env.BACKUP_ENCRYPTION_KEY = KEY;
const results = [];
function t(name, fn, tag = '') { try { fn(); results.push({ name, tag, status: 'PASS' }); } catch (e) { results.push({ name, tag, status: 'FAIL', error: e.stack.split('\n').slice(0, 3).join(' | ') }); } }
function blocked(name, why) { results.push({ name, tag: 'real-postgres', status: 'BLOCKED', error: why }); }

function fakeBin(name, body) { const js = path.join(root, `${name}.js`); fs.writeFileSync(js, body); return js; } // run via node by backup.js
const LOG = path.join(root, 'fake.log');
const fakeDump = fakeBin('pg_dump', `
const fs=require('fs');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('pg_dump (PostgreSQL) '+(process.env.FAKE_MAJOR||'18.0'));process.exit(0);}
fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify({argv:a,pw:process.env.PGPASSWORD||null})+'\\n');
if(process.env.FAKE_EXPECT_PW&&process.env.PGPASSWORD!==process.env.FAKE_EXPECT_PW){console.error('FATAL: password authentication failed');process.exit(1);}
const f=a.find(x=>x.startsWith('--file=')).slice(7);fs.writeFileSync(f,'FAKE-DUMP-CONTENT-'+process.env.PGDATABASE);
`);
const fakeRestore = fakeBin('pg_restore', `
const fs=require('fs');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify({restore:a,host:process.env.PGHOST})+'\\n');
const f=a[a.length-1];process.stdout.write(fs.readFileSync(f,'utf8').startsWith('FAKE-DUMP')?'':'');
`);
process.env.BACKUP_PG_DUMP_BIN = fakeDump;
process.env.BACKUP_PG_RESTORE_BIN = fakeRestore;

function mkSource() {
  const src = path.join(root, `src-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(path.join(src, 'uploads/sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'contacts.json'), JSON.stringify({ campaigns: [{ id: 'c1' }], results: [1, 2, 3] }));
  fs.writeFileSync(path.join(src, 'conversation-state.json'), '{"states":{"972500000001":{"kind":"decision"}}}');
  fs.writeFileSync(path.join(src, 'uploads/sub/a.bin'), crypto.randomBytes(200_000));
  fs.writeFileSync(path.join(src, 'uploads/b.txt'), 'hello');
  return src;
}
function mkCfg(over = {}) {
  const src = mkSource();
  const dest = path.join(root, `dest-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dest, { recursive: true });
  return { src, dest, cfg: B.withDefaults({
    destination: { dir: dest }, expectedPgMajor: 18, localFailureDir: path.join(root, 'failures'),
    targets: [{ id: 'client-a', kind: 'client', provider: 'META_CLOUD_API', appSchemaVersion: 7,
      db: { host: 'db.internal', port: 5432, database: 'clienta', user: 'app', passwordEnv: 'TEST_DB_PW' },
      volumes: { storage: path.join(src, 'contacts.json'), state: path.join(src, 'conversation-state.json'), uploads: path.join(src, 'uploads'), session: path.join(src, 'no-such-session') } }],
    ...over }) };
}
process.env.TEST_DB_PW = 'S3cret-PW-value';

function tree(dir) { const o = {}; (function w(d, rel) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) w(p, rel + n + '/'); else o[rel + n] = B.sha256File(p); } })(dir, ''); return o; }

// ---- files: backup -> verify -> restore -> byte-for-byte compare
const A = mkCfg(); const tgt = A.cfg.targets[0];
const fb = B.backupOne(A.cfg, tgt, 'files', {});
t('files backup: created+transferred ok, missing volume reported not silently dropped', () => {
  assert.equal(fb.manifest.status.created, 'ok'); assert.equal(fb.manifest.status.transferred, 'ok');
  assert.deepEqual(fb.manifest.missingVolumes, ['session']);
  assert.equal(fb.manifest.consistency, 'independent-timestamps-not-atomic');
  assert.equal(fb.manifest.artifacts.length, 3);
});
t('files backup: quiesced flag is recorded, never implied', () => {
  const q = B.backupOne(A.cfg, tgt, 'files', { quiesced: true });
  assert.equal(q.manifest.consistency, 'write-barrier-asserted-by-operator');
});
t('artifacts at destination are ciphertext (plaintext marker absent)', () => {
  for (const a of fb.manifest.artifacts) assert.ok(!fs.readFileSync(path.join(fb.destDir, a.file)).includes('campaigns'));
});
t('manifest contains no secrets', () => {
  const body = fs.readFileSync(path.join(fb.destDir, 'manifest.json'), 'utf8');
  assert.ok(!body.includes(KEY) && !body.includes(process.env.TEST_DB_PW));
});
t('verify passes on an intact backup', () => assert.equal(B.verify(A.cfg, fb.destDir).ok, true));
t('verify writes verified=ok back to the manifest', () => {
  const m = JSON.parse(fs.readFileSync(path.join(fb.destDir, 'manifest.json'), 'utf8'));
  assert.equal(m.status.verified, 'ok');
  assert.ok(m.verifiedAt);
});
t('restore round trip: restored files are byte-identical to the source', () => {
  const out = path.join(root, 'restore-out-1');
  const r = B.restore(A.cfg, fb.destDir, { restoreDir: out });
  assert.equal(r.ok, true);
  assert.equal(B.sha256File(path.join(out, 'storage/contacts.json')), B.sha256File(path.join(A.src, 'contacts.json')));
  assert.deepEqual(tree(path.join(out, 'uploads')), tree(path.join(A.src, 'uploads')));
  assert.equal(B.sha256File(path.join(out, 'state/conversation-state.json')), B.sha256File(path.join(A.src, 'conversation-state.json')));
});
t('restore --dry-run changes nothing', () => {
  const out = path.join(root, 'restore-dry');
  const r = B.restore(A.cfg, fb.destDir, { restoreDir: out, dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(fs.existsSync(out), false);
});
t('restore refuses a target overlapping the source volume', () => {
  assert.throws(() => B.restore(A.cfg, fb.destDir, { restoreDir: path.join(A.src, 'uploads') }), /overlaps the source/);
  assert.throws(() => B.restore(A.cfg, fb.destDir, { restoreDir: A.src }), /overlaps the source/);
});
t('restore requires an explicit target', () => assert.throws(() => B.restore(A.cfg, fb.destDir, {}), /--restore-dir is required/));

// ---- corruption / wrong key / missing parts
t('tampered artifact -> verify fails and restore refuses', () => {
  const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'files', {});
  const f = path.join(b.destDir, b.manifest.artifacts[0].file); const buf = fs.readFileSync(f); buf[buf.length >> 1] ^= 0xff; fs.writeFileSync(f, buf);
  const v = B.verify(c.cfg, b.destDir); assert.equal(v.ok, false); assert.match(v.problems.join(), /checksum mismatch/);
  assert.throws(() => B.restore(c.cfg, b.destDir, { restoreDir: path.join(root, 'r-tamper') }), /unverified/);
});
t('missing artifact -> verify fails', () => {
  const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'files', {});
  fs.rmSync(path.join(b.destDir, b.manifest.artifacts[1].file));
  assert.match(B.verify(c.cfg, b.destDir).problems.join(), /missing artifact/);
});
t('missing manifest -> verify throws clearly', () => {
  const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'files', {});
  fs.rmSync(path.join(b.destDir, 'manifest.json')); assert.throws(() => B.verify(c.cfg, b.destDir), /missing manifest/);
});
t('wrong key -> verify reports authentication failure, no plaintext produced', () => {
  const v = B.verify(A.cfg, fb.destDir); assert.ok(v.ok);
  const saved = process.env.BACKUP_ENCRYPTION_KEY; process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  try { const bad = B.verify(A.cfg, fb.destDir); assert.equal(bad.ok, false); assert.match(bad.problems.join(), /authentication failed/); } finally { process.env.BACKUP_ENCRYPTION_KEY = saved; }
});
t('missing encryption key -> backup refuses to run unencrypted', () => {
  const saved = process.env.BACKUP_ENCRYPTION_KEY; delete process.env.BACKUP_ENCRYPTION_KEY;
  try { assert.throws(() => B.backupOne(A.cfg, tgt, 'files', {}), /encryption key/); } finally { process.env.BACKUP_ENCRYPTION_KEY = saved; }
});

// ---- destination failures: created ok, transferred failed, visibly; last good kept
t('unavailable destination: created=ok, transferred=failed, failure manifest kept locally, no crash', () => {
  const c = mkCfg(); const blockedDest = path.join(root, 'dest-is-a-file'); fs.writeFileSync(blockedDest, 'x'); c.cfg.destination.dir = blockedDest;
  const b = B.backupOne(c.cfg, c.cfg.targets[0], 'files', {});
  assert.equal(b.manifest.status.created, 'ok'); assert.equal(b.manifest.status.transferred, 'failed'); assert.ok(b.manifest.transferError);
  assert.ok(fs.readdirSync(path.join(root, 'failures', 'client-a')).some((n) => n.endsWith('.manifest.json')));
});
t('retention never deletes the last good backup, even after newer failures', () => {
  const c = mkCfg(); const g = B.backupOne(c.cfg, c.cfg.targets[0], 'files', {});
  const old = JSON.parse(fs.readFileSync(path.join(g.destDir, 'manifest.json'), 'utf8')); old.startedAt = new Date(Date.now() - 400 * 864e5).toISOString(); old.finishedAt = old.startedAt;
  fs.writeFileSync(path.join(g.destDir, 'manifest.json'), JSON.stringify(old));
  for (let i = 1; i <= 3; i++) { // three newer FAILED backups (manifest only)
    const d = path.join(c.dest, 'client-a', `fail-${i}-files`); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: `fail-${i}`, kind: 'files', startedAt: new Date(Date.now() - i * 864e5 * 8).toISOString(), finishedAt: new Date().toISOString(), status: { created: 'failed', transferred: 'not_attempted' }, artifacts: [] }));
  }
  B.pruneTarget(c.cfg, c.cfg.targets[0], false);
  assert.ok(fs.existsSync(g.destDir), 'the only good backup (400 days old) must survive');
});
t('retention thins hourly -> daily buckets but keeps newest good backups', () => {
  const c = mkCfg(); const tg = c.cfg.targets[0]; const now = new Date();
  const mk = (ageH, name) => { const d = path.join(c.dest, 'client-a', name); fs.mkdirSync(d, { recursive: true }); const s = new Date(now - ageH * 36e5).toISOString(); fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id: name, kind: 'files', startedAt: s, finishedAt: s, status: { created: 'ok', transferred: 'ok' }, artifacts: [] })); return d; };
  const recent = mk(1, 'r1'); const dupHour = mk(1.2, 'r1b'); const dayA = mk(60, 'd1'); const dayA2 = mk(62, 'd1b');
  const removed = B.pruneTarget(c.cfg, tg, false, now);
  assert.ok(fs.existsSync(recent)); assert.ok(fs.existsSync(dayA));
  assert.ok(removed.some((x) => x.endsWith('r1b') || x.endsWith('d1b')) || !fs.existsSync(dupHour) || !fs.existsSync(dayA2));
});

// ---- freshness (runs outside the backup process, must detect "scheduler never ran")
t('freshness: no backups at all -> not ok (scheduler may not be running)', () => {
  const c = mkCfg(); const f = B.freshness(c.cfg); assert.equal(f.ok, false); assert.ok(f.problems.length >= 2);
});
t('freshness: fresh backups ok; stale ones flagged', () => {
  const c = mkCfg(); B.backupOne(c.cfg, c.cfg.targets[0], 'files', {}); B.backupOne(c.cfg, c.cfg.targets[0], 'db', {});
  assert.equal(B.freshness(c.cfg).ok, true);
  const later = new Date(Date.now() + 3 * 864e5); const f = B.freshness(c.cfg, later);
  assert.equal(f.ok, false); assert.equal(f.problems.length, 2);
});

// ---- DB plumbing with the FAKE binary (not a PostgreSQL proof)
t('fake-binary: db backup passes password via env, never argv/manifest/log', () => {
  fs.rmSync(LOG, { force: true });
  const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'db', {});
  assert.equal(b.manifest.status.created, 'ok'); assert.equal(b.manifest.pgDumpMajor, 18);
  const log = JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n')[0]);
  assert.equal(log.pw, process.env.TEST_DB_PW); assert.ok(!log.argv.join(' ').includes(process.env.TEST_DB_PW));
  assert.ok(!fs.readFileSync(path.join(b.destDir, 'manifest.json'), 'utf8').includes(process.env.TEST_DB_PW));
}, 'fake-binary');
t('fake-binary: wrong DB password -> created=failed, nothing transferred, error has no password', () => {
  process.env.FAKE_EXPECT_PW = 'different'; try {
    const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'db', {});
    assert.equal(b.manifest.status.created, 'failed'); assert.equal(b.manifest.status.transferred, 'not_attempted');
    assert.ok(!JSON.stringify(b.manifest).includes(process.env.TEST_DB_PW));
    assert.equal(B.freshness(c.cfg).ok, false);
  } finally { delete process.env.FAKE_EXPECT_PW; }
}, 'fake-binary');
t('fake-binary: pg_dump older than the server major is refused', () => {
  process.env.FAKE_MAJOR = '16.2'; try { const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'db', {}); assert.equal(b.manifest.status.created, 'failed'); assert.match(b.manifest.error, /older than server/); } finally { delete process.env.FAKE_MAJOR; }
}, 'fake-binary');
t('fake-binary: missing pg_dump gives an actionable error, not a crash', () => {
  const saved = process.env.BACKUP_PG_DUMP_BIN; process.env.BACKUP_PG_DUMP_BIN = path.join(root, 'nope'); try { const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'db', {}); assert.match(b.manifest.error, /install PostgreSQL/); } finally { process.env.BACKUP_PG_DUMP_BIN = saved; }
}, 'fake-binary');
t('fake-binary: db restore refuses the SOURCE database and requires an explicit env URL', () => {
  const c = mkCfg(); const b = B.backupOne(c.cfg, c.cfg.targets[0], 'db', {});
  assert.throws(() => B.restore(c.cfg, b.destDir, {}), /required/);
  process.env.T_SRC_URL = 'postgres://app:x@db.internal:5432/clienta';
  assert.throws(() => B.restore(c.cfg, b.destDir, { restoreDbUrlEnv: 'T_SRC_URL' }), /SOURCE database/);
  process.env.T_ISO_URL = 'postgres://app:x@127.0.0.1:55432/restore_check';
  fs.rmSync(LOG, { force: true });
  assert.equal(B.restore(c.cfg, b.destDir, { restoreDbUrlEnv: 'T_ISO_URL' }).ok, true);
  assert.match(fs.readFileSync(LOG, 'utf8'), /--clean/);
  assert.equal(B.restore(c.cfg, b.destDir, { restoreDbUrlEnv: 'T_ISO_URL', dryRun: true }).dryRun, true);
}, 'fake-binary');

// ---- remote Docker-over-SSH operations (fake SSH, real tool path)
t('remote-docker: inventory discovers provider, image, schema version, app version and remote volume size', () => {
  const remoteRoot = mkSource();
  fs.writeFileSync(path.join(remoteRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const fakeSsh = fakeBin('ssh', `
const fs=require('fs');const cp=require('child_process');const path=require('path');
const cmd=process.argv[process.argv.length-1];const root=${JSON.stringify(remoteRoot)};
function out(s){process.stdout.write(s);}
if(cmd.includes('docker inspect')&&cmd.includes('.Config.Env')) out('WHATSAPP_PROVIDER=META_CLOUD_API\\nPOSTGRES_DB=postgres\\nPOSTGRES_USER=postgres\\n');
else if(cmd.includes('service.name=')&&cmd.includes('remote-app')) out('appcid\\n');
else if(cmd.includes('service.name=')&&cmd.includes('remote-db')) out('dbcid\\n');
else if(cmd.includes('docker service ls')&&cmd.includes('remote-app')) out('app-image:abc\\n');
else if(cmd.includes('docker service ls')&&cmd.includes('remote-db')) out('postgres:18\\n');
else if(cmd.includes('docker exec')&&cmd.includes('test -e')) process.exit(0);
else if(cmd.includes('docker exec')&&cmd.includes('du -sb')) out(String(fs.statSync(root).isDirectory()?dirSize(root):fs.statSync(root).size)+'\\t/app/data\\n');
else if(cmd.includes('docker exec')&&cmd.includes('package.json')) out('9.8.7\\n');
else if(cmd.includes('docker exec')&&cmd.includes('information_schema.columns')&&cmd.includes('schema_migrations')) out('id\\napplied_at\\n');
else if(cmd.includes('docker exec')&&cmd.includes('schema_migrations')) out('004_service_bot_state\\n');
else if(cmd.includes('docker exec')&&cmd.includes('pg_dump --version')) out('pg_dump (PostgreSQL) 18.6\\n');
else if(cmd.includes('docker exec')&&cmd.includes('pg_dump --format=custom')) process.stdout.write(Buffer.from('REMOTE-DB-DUMP'));
else if(cmd.includes('docker exec')&&cmd.includes('tar -C')) { const r=cp.spawnSync('tar',['-cf','-','-C',root,'.'],{encoding:null}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status||0); }
else { console.error('unexpected fake ssh command: '+cmd); process.exit(9); }
function dirSize(p){const st=fs.statSync(p); if(!st.isDirectory()) return st.size; return fs.readdirSync(p).reduce((s,n)=>s+dirSize(path.join(p,n)),0);}
`);
  const c = B.withDefaults({
    destination: { dir: path.join(root, `remote-dest-${crypto.randomBytes(3).toString('hex')}`) },
    dockerSsh: { host: 'root@example.invalid', sshBin: fakeSsh },
    targets: [{
      id: 'remote-client', kind: 'client', appService: 'remote-app', provider: null,
      db: { dockerService: 'remote-db' },
      volumes: { appData: { dockerService: 'remote-app', path: '/app/data' } },
    }],
  });
  const inv = B.inventory(c);
  assert.equal(inv.targets[0].provider, 'META_CLOUD_API');
  assert.equal(inv.targets[0].appVersion, '9.8.7');
  assert.equal(inv.targets[0].appSchemaVersion, '004_service_bot_state');
  assert.equal(inv.targets[0].appImage, 'app-image:abc');
  assert.equal(inv.targets[0].dbImage, 'postgres:18');
  assert.equal(inv.targets[0].volumes.appData.exists, true);
  assert.ok(inv.targets[0].volumes.appData.sourceBytes > 0);
  const files = B.backupOne(c, c.targets[0], 'files', {});
  assert.equal(files.manifest.status.created, 'ok');
  assert.equal(files.manifest.artifacts[0].sourceType, 'docker');
  const out = path.join(root, 'remote-restore');
  assert.equal(B.restore(c, files.destDir, { restoreDir: out }).ok, true);
  assert.deepEqual(tree(path.join(out, 'appData')), tree(remoteRoot));
  const db = B.backupOne(c, c.targets[0], 'db', {});
  assert.equal(db.manifest.status.created, 'ok');
  assert.equal(db.manifest.pgDumpMajor, 18);
}, 'remote-docker');

// ---- real PostgreSQL round trip: BLOCKED unless a disposable test cluster is available.
// Do not point this at the shared TEST_DATABASE_URL; backup/restore verification
// must own its scratch database so destructive restore checks cannot collide with
// other agents.
const realDump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
if (realDump.error || realDump.status !== 0 || !process.env.BACKUP_TEST_PG_SCRATCH_URL) {
  blocked('real PostgreSQL dump -> encrypted upload -> restore into a fresh DB -> compare row counts/relations/sample campaign/result/context/held rows',
    'pg_dump/pg_restore (PostgreSQL 18 client tools) and a disposable scratch server are not available to this test process. Start a dedicated temporary PostgreSQL 18 cluster and set BACKUP_TEST_PG_SCRATCH_URL to a local scratch database owned by this test; do not use TEST_DATABASE_URL.');
} else {
  blocked('real PostgreSQL round trip', 'scratch server was provided but the seeded round-trip test is not implemented yet');
}

// ---- report
const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
for (const r of results) { counts[r.status]++; console.log(`${r.status.padEnd(7)} ${r.tag ? '[' + r.tag + '] ' : ''}${r.name}${r.error ? '\n          ' + r.error : ''}`); }
console.log(`\npass=${counts.PASS} fail=${counts.FAIL} blocked=${counts.BLOCKED} skip=0`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(counts.FAIL ? 1 : counts.BLOCKED ? 3 : 0);
