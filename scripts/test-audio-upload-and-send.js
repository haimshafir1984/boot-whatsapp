/**
 * Audio clips in a campaign step (e.g. "name this song"): the upload must be accepted, and the file
 * must reach WhatsApp as an AUDIO message - not as a document.
 *
 * The document path is the real failure mode here, and it is silent: an extension missing from
 * mimeTypeForFile() falls through to application/octet-stream, which sendFile() classifies as
 * `document`. The participant then gets a file attachment with a filename instead of a playable
 * clip, and nothing errors. So the assertions below are about the TYPE Meta is asked to send, not
 * just about the upload returning 201.
 *
 * No network: global.fetch is stubbed, the same way test-meta-embedded-signup-graph-calls.js does.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-upload-'));
Object.assign(process.env, {
  NODE_ENV: 'test', WHATSAPP_PROVIDER: 'META_CLOUD_API',
  STORAGE_PATH: path.join(root, 'storage.json'), OWNER_STORAGE_PATH: path.join(root, 'owner.json'),
  CONVERSATION_STATE_PATH: path.join(root, 'conv.json'), UPLOADS_PATH: path.join(root, 'uploads'),
  OWNER_ACCESS_TOKEN: 'audio-owner', CLIENT_ACCESS_TOKEN: 'audio-client',
  META_ACCESS_TOKEN: 'meta-token', META_PHONE_NUMBER_ID: 'phone-id', META_DISPLAY_PHONE_NUMBER: '15550001111',
});
const { Storage } = require('../dist/storage');
const { config } = require('../dist/config');
const { MetaCloudProvider } = require('../dist/providers/MetaCloudProvider');

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([name, 'PASS']); }
  catch (e) { results.push([name, 'FAIL', (e.message || String(e)).split('\n').slice(0, 3).join(' | ')]); }
}
const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

(async () => {
  config.ADMIN_PORT = 0;
  const { startAdminServer } = require('../dist/adminServer');
  fs.writeFileSync(config.OWNER_STORAGE_PATH, '[]');
  const srv = startAdminServer(new Storage(config.STORAGE_PATH));
  if (!srv.listening) await new Promise((resolve) => srv.once('listening', resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  // The dashboard authenticates with a session cookie, not a header.
  const login = await fetch(`${url}/auth/client/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessCode: process.env.CLIENT_ACCESS_TOKEN }),
  });
  assert.equal(login.status, 200, 'the test could not log in as the client');
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'no session cookie was issued');
  const upload = (name, mimeType, bytes) => fetch(`${url}/api/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name, mimeType, dataUrl: dataUrl(mimeType, bytes) }),
  });

  try {
    await scenario('the formats a browser reports for an audio clip are all accepted', async () => {
      // Chrome and Firefox label the same .mp3 / .m4a differently, so both spellings must pass.
      for (const [name, mime] of [
        ['clip.mp3', 'audio/mpeg'], ['clip.mp3', 'audio/mp3'],
        ['clip.m4a', 'audio/mp4'], ['clip.m4a', 'audio/x-m4a'],
        ['clip.aac', 'audio/aac'], ['clip.ogg', 'audio/ogg'], ['clip.amr', 'audio/amr'],
      ]) {
        const res = await upload(name, mime, 32 * 1024);
        assert.equal(res.status, 201, `${name} (${mime}) must be accepted, got ${res.status}`);
      }
    });

    await scenario('an audio file over 2MB is refused, and the limit is audio-specific', async () => {
      const tooBig = await upload('song.mp3', 'audio/mpeg', 2 * 1024 * 1024 + 1024);
      assert.equal(tooBig.status, 400, 'a whole track must be refused');
      assert.match((await tooBig.json()).error, /שמע/, 'the message must say which limit was hit');

      const justUnder = await upload('clip.mp3', 'audio/mpeg', 2 * 1024 * 1024 - 1024);
      assert.equal(justUnder.status, 201, 'a clip just under the limit must still be accepted');

      // The audio limit must not have tightened the others: a 4MB image was fine before and still is.
      const image = await upload('photo.jpg', 'image/jpeg', 4 * 1024 * 1024);
      assert.equal(image.status, 201, 'the image limit (5MB) must be unchanged');
    });

    await scenario('a file type that is still not supported is refused', async () => {
      const res = await upload('clip.wav', 'audio/wav', 1024);
      assert.equal(res.status, 400, 'audio/wav is not in Meta\'s accepted list and must stay refused');
    });
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }

  // The part that actually matters for the participant: what Meta is asked to send.
  await scenario('an audio clip is sent as `audio`, never as a document', async () => {
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (target, init) => {
      const body = init?.body;
      if (String(target).endsWith('/media')) return new Response(JSON.stringify({ id: 'media-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      sent.push(JSON.parse(String(body)));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.AUDIO' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const provider = new MetaCloudProvider();
      for (const name of ['clip.mp3', 'clip.m4a', 'clip.aac', 'clip.ogg', 'clip.amr']) {
        const file = path.join(root, name);
        fs.writeFileSync(file, Buffer.alloc(2048, 3));
        sent.length = 0;
        await provider.sendFile('whatsapp:972500000001', file, 'מה השיר?');
        assert.equal(sent.length, 1, `${name} must produce exactly one send`);
        const payload = sent[0];
        assert.equal(payload.type, 'audio', `${name} must be sent as audio, got "${payload.type}" (document = a file attachment, not a playable clip)`);
        assert.ok(payload.audio?.id, `${name} must carry a media id`);
        assert.equal(payload.audio.filename, undefined, 'audio must not be given a filename - that is the document shape');
        // WhatsApp ignores captions on audio; sending one would silently drop the text.
        assert.equal(payload.audio.caption, undefined, 'a caption on audio is dropped by WhatsApp and must not be sent');
      }
    } finally { global.fetch = realFetch; }
  });

  for (const [name, status, detail] of results) console.log(`${status}  ${name}${detail ? ' :: ' + detail : ''}`);
  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(`\naudio-upload-and-send: ${results.length - failed} passed, ${failed} failed`);
  fs.rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
})().catch((err) => { console.error(err); process.exit(1); });
