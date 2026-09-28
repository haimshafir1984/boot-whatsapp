'use strict';
// The Meta media-id cache survives a restart, and files can be pre-uploaded so no participant waits on an upload.
// Each "process" below is a real, separate Node process running the real compiled MetaCloudProvider, so the
// in-memory cache genuinely starts empty - exactly what a container restart or a deploy does.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-media-persist-'));
const mediaFile = path.join(dir, 'campaign-image.jpeg');
fs.writeFileSync(mediaFile, Buffer.from('fake-jpeg'));
const cacheFile = path.join(dir, 'meta-media-cache.json');
const providerPath = path.resolve(__dirname, '..', 'dist', 'providers', 'MetaCloudProvider');

// Runs one isolated process: stubs Meta, performs `action`, prints {uploads, sends, result} as JSON.
function runProcess(action, extraEnv = {}) {
  const code = `
    let uploads = 0, sends = 0;
    global.fetch = async (url) => {
      const value = String(url);
      if (value.endsWith('/media')) { uploads += 1; return new Response(JSON.stringify({ id: 'media-' + Date.now() + '-' + uploads }), { status: 200 }); }
      if (value.endsWith('/messages')) { sends += 1; return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + sends }] }), { status: 200 }); }
      throw new Error('Unexpected Meta URL: ' + value);
    };
    const { MetaCloudProvider, prewarmMetaMedia } = require(${JSON.stringify(providerPath)});
    (async () => {
      let result = null;
      ${action}
      process.stdout.write('\\n__RESULT__' + JSON.stringify({ uploads, sends, result }) + '\\n');
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    META_ACCESS_TOKEN: 'test-token',
    META_PHONE_NUMBER_ID: 'test-phone-id',
    META_MEDIA_CACHE_PATH: cacheFile,
    ...extraEnv,
  };
  const out = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, `child process failed: ${out.stderr}`);
  const line = out.stdout.split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `child printed no result: ${out.stdout}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

const send = `await new MetaCloudProvider().sendFile('972500000001', ${JSON.stringify(mediaFile)}, 'hi');`;

try {
  // 1. First process uploads once; a brand-new process (restart) reuses the persisted id - zero uploads.
  const first = runProcess(send);
  assert.equal(first.uploads, 1, 'first send after a cold start uploads once');
  assert.ok(fs.existsSync(cacheFile), 'the media id is persisted to disk');
  const afterRestart = runProcess(send);
  assert.equal(afterRestart.uploads, 0, 'after a restart the persisted media id is reused - no upload delay');
  assert.equal(afterRestart.sends, 1);
  console.log('PASS 1: media id survives a restart; the first participant after it does not wait on an upload.');

  // 2. Pre-warm uploads a file ahead of time; a following send (new process) uploads nothing.
  fs.rmSync(cacheFile);
  const warmed = runProcess(`result = await prewarmMetaMedia([${JSON.stringify(mediaFile)}], 'test');`);
  assert.equal(warmed.uploads, 1);
  assert.equal(warmed.sends, 0, 'pre-warm never sends a message');
  assert.deepEqual(warmed.result, { uploaded: 1, cached: 0, failed: 0 });
  const warmedAgain = runProcess(`result = await prewarmMetaMedia([${JSON.stringify(mediaFile)}], 'test');`);
  assert.equal(warmedAgain.uploads, 0, 'a still-valid cached id is not re-uploaded');
  assert.deepEqual(warmedAgain.result, { uploaded: 0, cached: 1, failed: 0 });
  const sendAfterWarm = runProcess(send);
  assert.equal(sendAfterWarm.uploads, 0, 'a send after pre-warm uses the pre-uploaded id');
  console.log('PASS 2: pre-warm uploads ahead of time and never sends.');

  // 3. An id close to Meta's expiry is renewed by pre-warm (not by a participant); an expired one is ignored.
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const key = Object.keys(cache)[0];
  cache[key].expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const renewed = runProcess(`result = await prewarmMetaMedia([${JSON.stringify(mediaFile)}], 'test');`);
  assert.equal(renewed.uploads, 1, 'an id expiring within days is renewed ahead of time');
  assert.ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))[key].expiresAt > Date.now() + 20 * 24 * 60 * 60 * 1000, 'renewed id gets a fresh expiry');
  cache[key].expiresAt = Date.now() - 1000;
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const expired = runProcess(send);
  assert.equal(expired.uploads, 1, 'an expired persisted id is never used');
  console.log('PASS 3: near-expiry ids are renewed by pre-warm; expired ones are ignored.');

  // 4. A missing file is skipped, a corrupt cache file is tolerated (falls back to uploading).
  const missing = runProcess(`result = await prewarmMetaMedia([${JSON.stringify(path.join(dir, 'nope.jpeg'))}], 'test');`);
  assert.deepEqual(missing.result, { uploaded: 0, cached: 0, failed: 0 });
  fs.writeFileSync(cacheFile, '{not json');
  const corrupt = runProcess(send);
  assert.equal(corrupt.uploads, 1, 'a corrupt cache file must not break sending');
  console.log('PASS 4: missing files and a corrupt cache file are handled.');

  // 5. Tests without an explicit path never write a cache file (no state leaking between test runs).
  const noPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-media-nopath-'));
  runProcess(send, { META_MEDIA_CACHE_PATH: '', UPLOADS_PATH: path.join(noPathDir, 'uploads') });
  assert.equal(fs.existsSync(path.join(noPathDir, 'meta-media-cache.json')), false, 'NODE_ENV=test without META_MEDIA_CACHE_PATH persists nothing');
  fs.rmSync(noPathDir, { recursive: true, force: true });
  console.log('PASS 5: test runs do not persist the cache unless asked.');

  console.log('meta-media-cache-persist tests passed.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
