#!/usr/bin/env node
/**
 * Backup / verify / restore / freshness tool (stage A). Operational tool - it
 * is NOT part of the running app and never touches production unless it is
 * given a config that points at production.
 *
 *   node scripts/ops/backup.js inventory --config c.json
 *   node scripts/ops/backup.js backup    --config c.json [--kind db|files|all] [--target id] [--quiesced] [--dry-run]
 *   node scripts/ops/backup.js verify    --config c.json --backup <dir>
 *   node scripts/ops/backup.js restore   --config c.json --backup <dir> --restore-dir <dir> [--restore-db-url-env VAR] [--dry-run]
 *   node scripts/ops/backup.js prune     --config c.json [--dry-run]
 *   node scripts/ops/backup.js freshness --config c.json      (run from an EXTERNAL monitor; exit 1 = stale/missing)
 *
 * Design rules (see docs/system-safety-speed-stage-abc-2026-09-20.md, section 5):
 *  - Creation, transfer to the destination and restore-verification are three
 *    separate statuses in the manifest; a failure in any is visible.
 *  - A new failure never deletes the last good backup (prune keeps it).
 *  - Manifest holds no secrets. DB passwords come from env vars, never argv.
 *  - Artifacts are AES-256-GCM encrypted before they reach the destination.
 *  - DB and files are taken at different moments unless the operator asserts a
 *    write barrier with --quiesced. The manifest says which; the tool never
 *    claims a multi-service atomic backup.
 *  - restore refuses the source database/dir and requires an explicit target.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAGIC = Buffer.from('FBBK1');
const KINDS = ['db', 'files'];

function fail(msg, code = 1) { const e = new Error(msg); e.exitCode = code; throw e; }
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
function loadConfig(file) {
  if (!file) fail('--config is required');
  return withDefaults(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function withDefaults(cfg) {
  if (!cfg.destination?.dir) fail('config.destination.dir is required');
  cfg.retention = { hourlyHours: 48, dailyDays: 14, weeklyWeeks: 8, ...(cfg.retention || {}) };
  cfg.schedule = { dbEveryMinutes: 60, filesEveryMinutes: 1440, graceFactor: 1.5, ...(cfg.schedule || {}) };
  cfg.expectedPgMajor = cfg.expectedPgMajor ?? 18;
  return cfg;
}
function getKey(cfg) {
  const envName = cfg.encryptionKeyEnv || 'BACKUP_ENCRYPTION_KEY';
  let raw = process.env[envName];
  if (!raw && cfg.encryptionKeyCommand?.command) {
    const r = run(cfg.encryptionKeyCommand.command, cfg.encryptionKeyCommand.args || [], {}, cfg.encryptionKeyCommand.cwd);
    if (!r.ok) fail(`encryption key command failed (exit ${r.status}): ${r.err.split('\n').slice(-2).join('\n')}`);
    raw = r.out.trim();
  }
  if (!raw) fail(`encryption key env ${envName} is not set; provision a persistent key via env or encryptionKeyCommand before running backups`);
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) fail('encryption key must be 32 bytes (64 hex chars or base64)');
  return key;
}
function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function encryptFile(src, dst, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const inFd = fs.openSync(src, 'r'); const outFd = fs.openSync(dst, 'w');
  try {
    fs.writeSync(outFd, MAGIC); fs.writeSync(outFd, iv);
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(inFd, buf, 0, buf.length, null)) > 0;) fs.writeSync(outFd, c.update(buf.subarray(0, n)));
    fs.writeSync(outFd, c.final()); fs.writeSync(outFd, c.getAuthTag());
  } finally { fs.closeSync(inFd); fs.closeSync(outFd); }
}
function decryptFile(src, dst, key) {
  const size = fs.statSync(src).size;
  if (size < MAGIC.length + 12 + 16) fail(`encrypted artifact too small: ${src}`);
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(MAGIC.length + 12); fs.readSync(fd, head, 0, head.length, 0);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) { fs.closeSync(fd); fail(`not a backup artifact: ${src}`); }
  const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length)); d.setAuthTag(tag);
  const outFd = fs.openSync(dst, 'w');
  try {
    let pos = head.length; const end = size - 16; const buf = Buffer.alloc(1 << 20);
    while (pos < end) { const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos); fs.writeSync(outFd, d.update(buf.subarray(0, n))); pos += n; }
    fs.writeSync(outFd, d.final());
  } catch (e) { fs.closeSync(fd); fs.closeSync(outFd); fs.rmSync(dst, { force: true }); fail(`decrypt/authentication failed for ${path.basename(src)} (wrong key or corrupted artifact)`); }
  fs.closeSync(fd); fs.closeSync(outFd);
}
function run(bin, args, env, cwd) {
  // A .js "binary" is run with node (used by tests and by wrapper scripts; also avoids Windows .cmd spawn limits).
  const [cmd, argv] = /\.js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  const r = spawnSync(cmd, argv, { env: { ...process.env, ...env }, cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) return { ok: false, status: null, out: '', err: String(r.error.message) };
  return { ok: r.status === 0, status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function runRaw(bin, args, env, cwd) {
  const [cmd, argv] = /\.js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
  const r = spawnSync(cmd, argv, { env: { ...process.env, ...env }, cwd, encoding: null, maxBuffer: 1024 << 20 });
  if (r.error) return { ok: false, status: null, out: Buffer.alloc(0), err: String(r.error.message) };
  return { ok: r.status === 0, status: r.status, out: r.stdout || Buffer.alloc(0), err: (r.stderr || Buffer.alloc(0)).toString('utf8') };
}
function pgBin(name) { return process.env[`BACKUP_${name.toUpperCase()}_BIN`] || name; }
function pgEnv(db) {
  const pw = db.passwordEnv ? process.env[db.passwordEnv] : undefined;
  return { PGHOST: db.host, PGPORT: String(db.port || 5432), PGUSER: db.user, PGDATABASE: db.database, ...(pw ? { PGPASSWORD: pw } : {}) };
}
function pgMajor(bin) {
  const r = run(bin, ['--version']);
  const m = /(\d+)(?:\.\d+)?/.exec(r.out);
  return r.ok && m ? Number(m[1]) : null;
}
function tp(p) { return p.split('\\').join('/'); } // tar wants forward slashes on Windows
function stamp(d = new Date()) { return d.toISOString().replace(/[:.]/g, '-'); }
function dirSize(p) {
  const st = fs.statSync(p); if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((s, n) => s + dirSize(path.join(p, n)), 0);
}
function targetsOf(cfg, only) {
  const t = (cfg.targets || []).filter((x) => !only || x.id === only);
  if (!t.length) fail(only ? `unknown target ${only}` : 'no targets in config');
  return t;
}
function shQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }
function sshArgs(cfg, command) {
  const s = cfg.dockerSsh || cfg.ssh;
  if (!s?.host) fail('config.dockerSsh.host is required for remote Docker operations');
  const args = [];
  if (s.identityFile) args.push('-i', s.identityFile);
  if (s.strictHostKeyChecking) args.push('-o', `StrictHostKeyChecking=${s.strictHostKeyChecking}`);
  args.push(s.host, command);
  return args;
}
function sshBin(cfg) { return cfg.dockerSsh?.sshBin || cfg.ssh?.sshBin || 'ssh'; }
function remoteRun(cfg, command) { return run(sshBin(cfg), sshArgs(cfg, command)); }
function remoteRunRaw(cfg, command) { return runRaw(sshBin(cfg), sshArgs(cfg, command)); }
function serviceContainer(cfg, service) {
  const r = remoteRun(cfg, `docker ps --filter label=com.docker.swarm.service.name=${shQuote(service)} --format '{{.ID}}' | head -n1`);
  if (!r.ok) fail(`could not inspect docker service ${service}: ${r.err}`);
  const id = r.out.trim();
  if (!id) fail(`docker service ${service} has no running container`);
  return id;
}
function dockerExec(cfg, serviceOrContainer, command) {
  const container = /^[0-9a-f]{12,64}$/i.test(serviceOrContainer) ? serviceOrContainer : serviceContainer(cfg, serviceOrContainer);
  return remoteRun(cfg, `docker exec ${shQuote(container)} sh -lc ${shQuote(command)}`);
}
function dockerExecRaw(cfg, serviceOrContainer, command) {
  const container = /^[0-9a-f]{12,64}$/i.test(serviceOrContainer) ? serviceOrContainer : serviceContainer(cfg, serviceOrContainer);
  return remoteRunRaw(cfg, `docker exec ${shQuote(container)} sh -lc ${shQuote(command)}`);
}
function volumeSpec(target, name) {
  const v = target.volumes?.[name];
  if (typeof v === 'string') return { type: 'local', path: v };
  if (v?.dockerService || v?.service) return { type: 'docker', service: v.dockerService || v.service, path: v.path || v.containerPath || '/app/data' };
  return null;
}
function volumeExists(cfg, target, name) {
  const v = volumeSpec(target, name);
  if (!v) return false;
  if (v.type === 'local') return fs.existsSync(v.path);
  const r = dockerExec(cfg, v.service, `test -e ${shQuote(v.path)}`);
  return r.ok;
}
function volumeSize(cfg, v) {
  if (v.type === 'local') return dirSize(v.path);
  const r = dockerExec(cfg, v.service, `du -sb ${shQuote(v.path)} 2>/dev/null | awk '{print $1}'`);
  return r.ok ? Number(String(r.out).trim().split(/\s+/)[0]) || null : null;
}
function dockerServiceImage(cfg, service) {
  const r = remoteRun(cfg, `docker service ls --filter name=${shQuote(service)} --format '{{.Image}}' | head -n1`);
  return r.ok ? r.out.trim() || null : null;
}
function appVersion(cfg, target) {
  const service = target.appService || target.serviceId;
  if (!cfg.dockerSsh || !service) return target.appVersion || null;
  const r = dockerExec(cfg, service, `node -e "try{console.log(require('/app/package.json').version||'')}catch(e){process.exit(2)}"`);
  return r.ok ? r.out.trim() || null : null;
}
function remoteEnv(cfg, service, names) {
  const r = remoteRun(cfg, `cid=$(docker ps --filter label=com.docker.swarm.service.name=${shQuote(service)} --format '{{.ID}}' | head -n1); docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid"`);
  const out = {};
  if (!r.ok) return out;
  for (const line of r.out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i);
    if (names.includes(k)) out[k] = line.slice(i + 1);
  }
  return out;
}
function schemaVersion(cfg, target) {
  if (!cfg.dockerSsh || !target.db?.dockerService) return target.appSchemaVersion ?? null;
  const cols = dockerExec(cfg, target.db.dockerService, `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select column_name from information_schema.columns where table_schema='public' and table_name='schema_migrations' order by ordinal_position;"`);
  if (!cols.ok) return null;
  const names = cols.out.trim().split(/\r?\n/).filter(Boolean);
  const versionCol = names.includes('version') ? 'version' : names.includes('id') ? 'id' : names[0];
  if (!versionCol) return null;
  const order = names.includes('applied_at') ? 'applied_at desc' : `${versionCol} desc`;
  const r = dockerExec(cfg, target.db.dockerService, `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select coalesce(${versionCol}::text,'') from schema_migrations order by ${order} limit 1;"`);
  return r.ok ? r.out.trim() || null : null;
}
function dbMajor(cfg, target) {
  if (target.db?.dockerService) {
    const r = dockerExec(cfg, target.db.dockerService, 'pg_dump --version');
    const m = /(\d+)(?:\.\d+)?/.exec(r.out);
    return r.ok && m ? Number(m[1]) : null;
  }
  return pgMajor(pgBin('pg_dump'));
}
function dumpDb(cfg, target, rawPath) {
  if (target.db?.dockerService) {
    const r = dockerExecRaw(cfg, target.db.dockerService, 'pg_dump --format=custom --no-password --dbname "$POSTGRES_DB" --username "$POSTGRES_USER"');
    if (!r.ok) return { ok: false, status: r.status, err: r.err };
    fs.writeFileSync(rawPath, r.out);
    return { ok: true, status: 0, err: r.err };
  }
  const r = run(pgBin('pg_dump'), ['--format=custom', '--no-password', `--file=${rawPath}`], pgEnv(target.db));
  return r;
}
function tarVolume(cfg, v, tarPath, staging, name) {
  if (v.type === 'docker') {
    const r = dockerExecRaw(cfg, v.service, `tar -C ${shQuote(v.path)} -cf - .`);
    if (!r.ok) return r;
    fs.writeFileSync(tarPath, r.out);
    return { ok: true, status: 0, err: '' };
  }
  const st = fs.statSync(v.path);
  return st.isDirectory()
    ? run('tar', ['-cf', `${name}.tar`, '-C', tp(v.path), '.'], {}, staging)
    : run('tar', ['-cf', `${name}.tar`, '-C', tp(path.dirname(v.path)), path.basename(v.path)], {}, staging);
}

// ---------------------------------------------------------------- inventory
function inventory(cfg) {
  return {
    generatedAt: new Date().toISOString(),
    expectedPgMajor: cfg.expectedPgMajor,
    targets: (cfg.targets || []).map((t) => ({
      id: t.id, kind: t.kind, provider: t.provider || (t.appService && remoteEnv(cfg, t.appService, ['WHATSAPP_PROVIDER']).WHATSAPP_PROVIDER) || null,
      serviceId: t.serviceId || t.appService || null, appService: t.appService || null, dbService: t.db?.dockerService || null,
      appSchemaVersion: schemaVersion(cfg, t), configuredAppSchemaVersion: t.appSchemaVersion ?? null,
      appVersion: appVersion(cfg, t), appImage: (cfg.dockerSsh && (t.appService || t.serviceId)) ? dockerServiceImage(cfg, t.appService || t.serviceId) : null,
      dbImage: (cfg.dockerSsh && t.db?.dockerService) ? dockerServiceImage(cfg, t.db.dockerService) : null,
      db: t.db ? { host: t.db.host, port: t.db.port || 5432, database: t.db.database, user: t.db.user, dockerService: t.db.dockerService, passwordEnv: t.db.passwordEnv, passwordPresent: !!(t.db.passwordEnv && process.env[t.db.passwordEnv]) } : null,
      volumes: Object.fromEntries(Object.keys(t.volumes || {}).map((k) => {
        const v = volumeSpec(t, k);
        return [k, { type: v?.type, path: v?.path, service: v?.service, exists: volumeExists(cfg, t, k), sourceBytes: v ? volumeSize(cfg, v) : null }];
      })),
    })),
    note: 'Admin has its own inventory row; never point the gateway at a client database.',
  };
}

// ------------------------------------------------------------------- backup
function backupOne(cfg, target, kind, opts) {
  const key = getKey(cfg);
  const started = new Date();
  const id = `${stamp(started)}-${kind}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fbbk-'));
  const manifest = {
    format: 1, id, targetId: target.id, kind, targetKind: target.kind, provider: target.provider,
    appSchemaVersion: target.appSchemaVersion, startedAt: started.toISOString(),
    consistency: opts.quiesced ? 'write-barrier-asserted-by-operator' : 'independent-timestamps-not-atomic',
    status: { created: 'pending', transferred: 'pending', verified: 'not_run' }, artifacts: [],
  };
  try {
    if (kind === 'db') {
      if (!target.db) fail(`target ${target.id} has no db`);
      const major = dbMajor(cfg, target);
      if (major === null) fail(`pg_dump not runnable; install PostgreSQL ${cfg.expectedPgMajor} client tools or configure db.dockerService`);
      manifest.pgDumpMajor = major;
      if (major < cfg.expectedPgMajor) fail(`pg_dump ${major} is older than server ${cfg.expectedPgMajor}; refusing (would produce an unusable dump)`);
      const raw = path.join(staging, 'db.dump');
      const r = dumpDb(cfg, target, raw);
      manifest.dbDump = { exitCode: r.status, stderrTail: r.err.split('\n').slice(-5).join('\n').replace(/password[^\n]*/gi, '[redacted]') };
      if (!r.ok || !fs.existsSync(raw)) fail(`pg_dump failed (exit ${r.status}): ${manifest.dbDump.stderrTail}`);
      addArtifact(manifest, staging, raw, 'db.dump.enc', key);
    } else {
      const vols = target.volumes || {};
      const names = Object.keys(vols).filter((n) => volumeExists(cfg, target, n));
      manifest.missingVolumes = Object.keys(vols).filter((n) => !volumeExists(cfg, target, n));
      if (!names.length) fail(`target ${target.id}: none of the configured volumes exist`);
      for (const n of names) {
        const src = volumeSpec(target, n);
        const tar = path.join(staging, `${n}.tar`);
        const r = tarVolume(cfg, src, tar, staging, n);
        if (!r.ok) fail(`tar failed for volume ${n}: ${r.err}`);
        addArtifact(manifest, staging, tar, `${n}.tar.enc`, key, { volume: n, sourceType: src.type, sourcePath: src.path, sourceService: src.service, sourceBytes: volumeSize(cfg, src) });
      }
    }
    manifest.status.created = 'ok';
  } catch (e) {
    manifest.status.created = 'failed'; manifest.error = e.message;
  }
  manifest.finishedAt = new Date().toISOString();
  const destRoot = path.join(cfg.destination.dir, target.id);
  const destDir = path.join(destRoot, id);
  if (opts.dryRun) { fs.rmSync(staging, { recursive: true, force: true }); return { manifest, destDir, dryRun: true }; }
  if (manifest.status.created === 'ok') {
    try {
      fs.mkdirSync(destDir, { recursive: true });
      for (const a of manifest.artifacts) fs.copyFileSync(path.join(staging, a.file), path.join(destDir, a.file));
      // Read back what landed on the destination: a copy is only "transferred" when it hashes the same.
      for (const a of manifest.artifacts) if (sha256File(path.join(destDir, a.file)) !== a.encryptedSha256) fail(`destination copy of ${a.file} does not match`);
      manifest.status.transferred = 'ok';
    } catch (e) { manifest.status.transferred = 'failed'; manifest.transferError = e.message; }
  } else manifest.status.transferred = 'not_attempted';
  // Manifest is always written next to the local staging copy so a failure is visible even if the destination is down.
  const keepLocal = path.join(cfg.localFailureDir || path.join(os.tmpdir(), 'fbbk-failures'), target.id);
  const body = JSON.stringify(manifest, null, 2);
  try {
    fs.mkdirSync(destDir, { recursive: true }); fs.writeFileSync(path.join(destDir, 'manifest.json'), body);
  } catch { fs.mkdirSync(keepLocal, { recursive: true }); fs.writeFileSync(path.join(keepLocal, `${id}.manifest.json`), body); }
  fs.rmSync(staging, { recursive: true, force: true });
  return { manifest, destDir };
}
function addArtifact(manifest, staging, plainPath, encName, key, extra = {}) {
  const enc = path.join(staging, encName);
  encryptFile(plainPath, enc, key);
  manifest.artifacts.push({ file: encName, plainBytes: fs.statSync(plainPath).size, plainSha256: sha256File(plainPath), encryptedBytes: fs.statSync(enc).size, encryptedSha256: sha256File(enc), ...extra });
  fs.rmSync(plainPath, { force: true });
}

// ------------------------------------------------------------------- verify
function readManifest(dir) {
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) fail(`missing manifest.json in ${dir}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function verify(cfg, dir) {
  const m = readManifest(dir); const key = getKey(cfg); const problems = [];
  if (m.status.created !== 'ok') problems.push(`backup was not created successfully: ${m.error || m.status.created}`);
  for (const a of m.artifacts) {
    const f = path.join(dir, a.file);
    if (!fs.existsSync(f)) { problems.push(`missing artifact ${a.file}`); continue; }
    if (sha256File(f) !== a.encryptedSha256) { problems.push(`checksum mismatch ${a.file}`); continue; }
    const tmp = path.join(os.tmpdir(), `fbbk-v-${process.pid}-${a.file}`);
    try { decryptFile(f, tmp, key); if (sha256File(tmp) !== a.plainSha256) problems.push(`plaintext checksum mismatch ${a.file}`); }
    catch (e) { problems.push(e.message); } finally { fs.rmSync(tmp, { force: true }); }
  }
  if (!m.artifacts.length) problems.push('manifest lists no artifacts');
  m.status = { ...(m.status || {}), verified: problems.length === 0 ? 'ok' : 'failed' };
  m.verifiedAt = new Date().toISOString();
  if (problems.length) m.verifyProblems = problems; else delete m.verifyProblems;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return { ok: problems.length === 0, problems, manifest: m };
}

// ------------------------------------------------------------------ restore
function restore(cfg, dir, opts) {
  const m = readManifest(dir); const key = getKey(cfg);
  const v = verify(cfg, dir);
  if (!v.ok) fail(`refusing to restore an unverified backup: ${v.problems.join('; ')}`);
  const target = (cfg.targets || []).find((t) => t.id === m.targetId);
  const plan = { backup: m.id, kind: m.kind, steps: [] };
  const t0 = Date.now();
  if (m.kind === 'files') {
    if (!opts.restoreDir) fail('--restore-dir is required for a files restore');
    const dest = path.resolve(opts.restoreDir);
    for (const name of Object.keys(target?.volumes || {})) {
      const src = volumeSpec(target, name);
      if (!src || src.type !== 'local') continue;
      const s = path.resolve(src.path);
      if (dest === s || dest.startsWith(s + path.sep) || s.startsWith(dest + path.sep)) fail(`restore target ${dest} overlaps the source volume ${s}; refusing`);
    }
    for (const a of m.artifacts) plan.steps.push(`extract ${a.file} -> ${path.join(dest, a.volume)}`);
    if (opts.dryRun) return { ok: true, dryRun: true, plan };
    for (const a of m.artifacts) {
      const tmp = path.join(os.tmpdir(), `fbbk-r-${process.pid}-${a.volume}.tar`);
      decryptFile(path.join(dir, a.file), tmp, key);
      const out = path.join(dest, a.volume); fs.mkdirSync(out, { recursive: true });
      const r = run('tar', ['-xf', path.basename(tmp), '-C', tp(out)], {}, path.dirname(tmp)); fs.rmSync(tmp, { force: true });
      if (!r.ok) fail(`tar extract failed: ${r.err}`);
    }
  } else {
    const urlEnv = opts.restoreDbUrlEnv; const url = urlEnv && process.env[urlEnv];
    if (!url) fail('--restore-db-url-env <ENVVAR> naming an explicit, isolated target database URL is required');
    const u = new URL(url);
    const src = target?.db;
    if (src && u.hostname === src.host && String(u.port || 5432) === String(src.port || 5432) && u.pathname.slice(1) === src.database) fail('restore target is the SOURCE database; refusing');
    plan.steps.push(`pg_restore --clean --if-exists into ${u.hostname}:${u.port || 5432}${u.pathname}`);
    if (opts.dryRun) return { ok: true, dryRun: true, plan };
    const bin = pgBin('pg_restore');
    const tmp = path.join(os.tmpdir(), `fbbk-r-${process.pid}.dump`);
    decryptFile(path.join(dir, m.artifacts[0].file), tmp, key);
    const r2 = run(bin, ['--no-password', '--exit-on-error', '--clean', '--if-exists', '--dbname', u.pathname.slice(1), tmp], { PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), ...(u.password ? { PGPASSWORD: decodeURIComponent(u.password) } : {}) });
    fs.rmSync(tmp, { force: true });
    if (!r2.ok) fail(`pg_restore failed (exit ${r2.status}): ${r2.err.slice(-300)}`);
  }
  return { ok: true, plan, restoreSeconds: Math.round((Date.now() - t0) / 100) / 10 };
}

// --------------------------------------------------------- prune / freshness
function listBackups(cfg, targetId) {
  const root = path.join(cfg.destination.dir, targetId);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((n) => path.join(root, n)).filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
    .map((d) => { try { return { dir: d, m: readManifest(d) }; } catch { return null; } }).filter(Boolean)
    .sort((a, b) => a.m.startedAt.localeCompare(b.m.startedAt));
}
// A backup whose verify step ran and found a problem (checksum mismatch, corrupt archive) is not "good" just
// because the upload succeeded - created/transferred only prove the bytes moved, not that they are restorable.
// A backup that simply has not been verified yet ('not_run'/absent - verify() is a separate step, not part of
// backupOne()) is NOT excluded: it is still the newest thing that actually landed, and restore() re-verifies
// for real at restore time regardless of this stored flag, so nothing here is ever trusted blind.
const isGood = (b) => b.m.status.created === 'ok' && b.m.status.transferred === 'ok' && b.m.status.verified !== 'failed';
function pruneTarget(cfg, target, dryRun, now = new Date()) {
  const r = cfg.retention; const removed = [];
  for (const kind of KINDS) {
    const all = listBackups(cfg, target.id).filter((b) => b.m.kind === kind);
    const good = all.filter(isGood);
    const keep = new Set();
    if (good.length) keep.add(good[good.length - 1].dir);             // the last good backup is never deleted
    const bucket = new Set();
    for (const b of [...good].reverse()) {                           // newest first
      const ageH = (now - new Date(b.m.startedAt)) / 36e5; const t = new Date(b.m.startedAt);
      let k = null;
      if (ageH <= r.hourlyHours) k = `h${t.toISOString().slice(0, 13)}`;
      else if (ageH <= r.dailyDays * 24) k = `d${t.toISOString().slice(0, 10)}`;
      else if (ageH <= r.weeklyWeeks * 7 * 24) k = `w${Math.floor(t / (7 * 864e5))}`;
      if (k && !bucket.has(k)) { bucket.add(k); keep.add(b.dir); }
    }
    for (const b of all) {
      if (keep.has(b.dir)) continue;
      const ageH = (now - new Date(b.m.startedAt)) / 36e5;
      const failed = !isGood(b);
      if (failed && ageH < 24 * 7) continue;                          // keep recent failures for diagnosis
      removed.push(b.dir); if (!dryRun) fs.rmSync(b.dir, { recursive: true, force: true });
    }
  }
  return removed;
}
function freshness(cfg, now = new Date()) {
  const problems = [];
  for (const t of targetsOf(cfg)) {
    for (const kind of KINDS) {
      if (kind === 'db' && !t.db) continue;
      if (kind === 'files' && !Object.keys(t.volumes || {}).length) continue;
      const every = (kind === 'db' ? cfg.schedule.dbEveryMinutes : cfg.schedule.filesEveryMinutes) * cfg.schedule.graceFactor;
      const good = listBackups(cfg, t.id).filter((b) => b.m.kind === kind && isGood(b));
      if (!good.length) { problems.push({ target: t.id, kind, reason: 'no good backup exists' }); continue; }
      const ageMin = (now - new Date(good[good.length - 1].m.finishedAt)) / 6e4;
      if (ageMin > every) problems.push({ target: t.id, kind, reason: `last good backup is ${Math.round(ageMin)} min old; limit ${Math.round(every)} min` });
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { withDefaults, inventory, backupOne, verify, restore, pruneTarget, freshness, listBackups, encryptFile, decryptFile, sha256File, loadConfig, targetsOf };

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2)); const cmd = args._[0];
    const cfg = loadConfig(args.config);
    if (cmd === 'inventory') console.log(JSON.stringify(inventory(cfg), null, 2));
    else if (cmd === 'backup') {
      const kinds = !args.kind || args.kind === 'all' ? KINDS : [args.kind]; let bad = 0;
      for (const t of targetsOf(cfg, args.target)) for (const k of kinds) {
        if ((k === 'db' && !t.db) || (k === 'files' && !Object.keys(t.volumes || {}).length)) continue;
        const r = backupOne(cfg, t, k, { quiesced: !!args.quiesced, dryRun: !!args['dry-run'] });
        console.log(`${t.id} ${k}: created=${r.manifest.status.created} transferred=${r.manifest.status.transferred}${r.manifest.error ? ' error=' + r.manifest.error : ''}${r.manifest.transferError ? ' transferError=' + r.manifest.transferError : ''}`);
        if (r.manifest.status.created !== 'ok' || (!r.dryRun && r.manifest.status.transferred !== 'ok')) bad++;
      }
      process.exitCode = bad ? 1 : 0;
    } else if (cmd === 'verify') { const r = verify(cfg, args.backup); console.log(JSON.stringify({ ok: r.ok, problems: r.problems }, null, 2)); process.exitCode = r.ok ? 0 : 1; }
    else if (cmd === 'restore') console.log(JSON.stringify(restore(cfg, args.backup, { restoreDir: args['restore-dir'], restoreDbUrlEnv: args['restore-db-url-env'], dryRun: !!args['dry-run'] }), null, 2));
    else if (cmd === 'prune') { for (const t of targetsOf(cfg)) console.log(t.id, 'removed', JSON.stringify(pruneTarget(cfg, t, !!args['dry-run']))); }
    else if (cmd === 'freshness') { const r = freshness(cfg); console.log(JSON.stringify(r, null, 2)); process.exitCode = r.ok ? 0 : 1; }
    else fail('usage: backup.js inventory|backup|verify|restore|prune|freshness --config file');
  } catch (e) { console.error('ERROR:', e.message); process.exitCode = e.exitCode || 1; }
}
