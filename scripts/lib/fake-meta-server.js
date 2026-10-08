#!/usr/bin/env node
/**
 * One fake Meta Cloud API for the whole peak harness (scripts/measure-peak-3campaigns.js). Every client process reaches it through
 * the FAKE_META_URL fetch redirect in load-preload.js, so everything that is a property of the SHARED NUMBER is modelled once:
 *
 *   - number-wide throughput limit (default 80 messages/second, answered with Meta's 130429 + HTTP 429 above it)
 *   - send latency (text vs media), 5xx, accepted-but-response-lost (the "uncertain" outcome), full blackout
 *   - the delivery-status webhooks Meta posts back to the gateway: sent -> delivered -> read (+ failed, duplicates, slow tail),
 *     with retries when the gateway does not answer 200. A file step in a campaign WAITS for `delivered`, so this traffic is on the
 *     critical path of the flow - and it is broadcast to every client by the gateway.
 *
 * DETERMINISM: every injected fault (5xx, accepted-but-response-lost, failed status, slow tail, duplicate status, latencies) is a pure
 * function of (seed, message identity, attempt number) - scripts/lib/detrand.js - NOT of the order in which requests happen to arrive.
 * The same message therefore gets the same fault in every run, whatever the timing. (The number-wide 429 limit and the time-windowed
 * --fault kinds are properties of timing and stay as they are.) Message identity = recipient + the [X#n] marker in its text.
 *
 * Config: env FM_CONFIG (JSON). Control at run time: process IPC {cmd:'set', key, value} / {cmd:'dump'}.
 * Output (stdout, one JSON per line): @@SEND (one per accepted message), @@META (stats every 5s), @@METADUMP (final).
 */
const http = require('node:http');
const { unit, gauss: gaussD, hash32 } = require('./detrand');

const cfg = JSON.parse(process.env.FM_CONFIG || '{}');
const C = {
  port: 0, gatewayPort: 0, pn: 'shared-phone-id', display: '15550001111',
  mps: 80, textMs: 150, mediaMs: 900, uploadMs: 700,
  sentMs: 250, deliveredMedianMs: 1500, deliveredMedianImageMs: 2500, readFrac: 0.6, readMedianMs: 20000,
  slowTailFrac: 0.03, dupStatusFrac: 0.05, failedFrac: 0.005,
  // dynamic (faults)
  rejectInteractive: 0,   // identity-keyed: this share of QUESTION messages (buttons) is answered 429 on EVERY attempt, so the product must fall back to a numbered text question
  latFactor: 1, err5xx: 0, base5xx: 0, lostResp: 0.0005, blackout: false, statusMult: 1, statusLoss: false,
  seed: 12345,
  ...cfg,
};
const U = (...p) => unit(C.seed, ...p);
const logn = (median, sigma, ...p) => median * Math.exp(sigma * gaussD(C.seed, ...p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { accepted: 0, text: 0, image: 0, interactive: 0, other: 0, markRead: 0, uploads: 0, r429: 0, r5xx: 0, lost: 0, blackout: 0,
  statusQueued: { sent: 0, delivered: 0, read: 0, failed: 0 }, statusPosted: 0, statusDup: 0, statusSkippedLoss: 0, statusRetries: 0, statusGaveUp: 0 };
// what the harness needs to explain any duplicate / reorder afterwards: every attempt of every message, and every fault that was injected
const attemptsOf = new Map();                 // messageKey -> [{ n, outcome }]
const injected = { lostResp: [], err5xx: [], failedStatus: [], slowTail: [], dupStatus: [], rejectInteractive: [] };
const mediaNames = new Map();        // media id -> uploaded file name (audio carries no caption, so its campaign/step marker comes from the file name: clip-Q2.mp3 = campaign Q, step 2)
const terminalPostedAt = new Map();  // media message id -> when Meta posted its delivered/failed status (the moment the product's wait COULD end)   // "<key>#<attempt>"
const sentAcked = new Set(), terminalAcked = new Set(), failedAcked = new Map(); const ackMs = []; let maxInFlightPosts = 0; let postsInFlight = 0; const recent = [];

// ---- webhook poster (Meta -> gateway), with Meta-like redelivery
const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
function postOnce(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body); const t = Date.now();
    const req = http.request({ host: '127.0.0.1', port: C.gatewayPort, path: '/webhooks/meta/whatsapp', method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t })); });
    req.on('error', () => resolve({ status: 0, ms: Date.now() - t })); req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, ms: Date.now() - t }); });
    req.end(data);
  });
}
async function postStatus(status) {
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: C.pn, display_phone_number: C.display }, statuses: [status] } }] }] };
  const first = Date.now(); let wait = 1000; postsInFlight += 1; maxInFlightPosts = Math.max(maxInFlightPosts, postsInFlight);
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await postOnce(body); ackMs.push(r.ms);
      if (r.status === 200) { stats.statusPosted += 1; if (status.status === 'sent') sentAcked.add(status.id); if (status.status === 'delivered' || status.status === 'failed') terminalAcked.add(status.id); if (status.status === 'failed') failedAcked.set(status.id, status.recipient_id); return; }
      if (Date.now() - first > 180000) { stats.statusGaveUp += 1; return; }
      stats.statusRetries += 1; await sleep(wait); wait = Math.min(8000, wait * 2);
    }
  } finally { postsInFlight -= 1; }
}
function scheduleStatuses(id, to, isImage, attemptData, ctx) {
  if (C.statusLoss) { stats.statusSkippedLoss += 1; return; }
  const m = C.statusMult; const tag = `${ctx.key}#${ctx.attempt}`;
  const base = (st, extra = {}) => ({ id, status: st, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to, ...(attemptData ? { biz_opaque_callback_data: attemptData } : {}), x_posted_ms: Date.now(), ...extra });
  const fire = (delayMs, st, extra, dup = true) => setTimeout(() => {
    if (ctx.media && (st === 'delivered' || st === 'failed') && !terminalPostedAt.has(id)) terminalPostedAt.set(id, Date.now());
    void postStatus(base(st, extra)); stats.statusQueued[st] += 1;
    if (dup && U('dupStatus', ctx.key, ctx.attempt, st) < C.dupStatusFrac) { stats.statusDup += 1; injected.dupStatus.push(tag + ':' + st); setTimeout(() => void postStatus(base(st, extra)), 1000 + U('dupStatusDelay', ctx.key, ctx.attempt, st) * 2000); }
  }, Math.max(0, delayMs));
  const sentAt = logn(C.sentMs, 0.4, 'sentLat', ctx.key, ctx.attempt) * m; fire(sentAt, 'sent');
  const failed = U('failedStatus', ctx.key, ctx.attempt) < C.failedFrac;
  let delivered = logn(isImage ? C.deliveredMedianImageMs : C.deliveredMedianMs, 0.6, 'delLat', ctx.key, ctx.attempt);
  if (U('slowTail', ctx.key, ctx.attempt) < C.slowTailFrac) { delivered = 20000 + U('slowTailLen', ctx.key, ctx.attempt) * 70000; injected.slowTail.push(tag); }
  delivered = (delivered * m) + sentAt;
  if (failed) { injected.failedStatus.push(tag); fire(delivered, 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] }, false); return; }
  fire(delivered, 'delivered');
  if (U('read', ctx.key, ctx.attempt) < C.readFrac) fire(delivered + logn(C.readMedianMs, 0.8, 'readLat', ctx.key, ctx.attempt) * m, 'read');
}

// ---- Meta Graph API
const sendTimes = [];
const bodyOf = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', () => resolve(Buffer.alloc(0))); });
const json = (res, code, obj, headers = {}) => { const s = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers }); res.end(s); };

const server = http.createServer(async (req, res) => {
  const raw = await bodyOf(req);
  const url = req.url || '';
  if (C.blackout) { stats.blackout += 1; req.socket.destroy(); return; }
  if (/\/media$/.test(url)) {
    const mid = 'media.FAKE' + (++stats.uploads); await sleep(logn(C.uploadMs, 0.3) * C.latFactor);   // the id is taken BEFORE the wait: concurrent uploads must not share one
    const fn = /filename="([^"]+)"/.exec(raw.toString('latin1', 0, Math.min(raw.length, 2048))); if (fn) mediaNames.set(mid, fn[1]);
    return json(res, 200, { id: mid });
  }
  if (!/\/messages$/.test(url)) return json(res, 404, { error: { message: 'unknown ' + url } });
  let body = {}; try { body = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: { message: 'bad json' } }); }
  if (body.status === 'read') { stats.markRead += 1; await sleep(40 * C.latFactor); return json(res, 200, { success: true }); }

  // identity of THIS message (recipient + the [X#n] marker in its text), and which attempt this is
  const type = String(body.type || 'unknown'); const isImage = ['image', 'video', 'document', 'audio', 'sticker'].includes(type);
  const to = String(body.to || '').replace(/\D/g, '');
  const text = type === 'text' ? body.text?.body : type === 'image' ? body.image?.caption : type === 'interactive' ? body.interactive?.body?.text : '';
  let mk = /\[([A-Z])#(\d+)\]/.exec(String(text || ''));
  if (!mk && isImage) { const nm = mediaNames.get(body[type] && body[type].id); const m2 = nm && /-([A-Z])(\d+)\.[A-Za-z0-9]+$/.exec(nm); if (m2) mk = [null, m2[1], m2[2]]; }
  const key = mk ? `${to}|${mk[1]}#${mk[2]}` : `${to}|${type}|${hash32(JSON.stringify({ ...body, biz_opaque_callback_data: undefined }))}`;
  const hist = attemptsOf.get(key) || []; attemptsOf.set(key, hist);
  const attempt = hist.length + 1; const prev = hist.length ? hist[hist.length - 1].outcome : null;
  const record = (outcome) => { hist.push({ n: attempt, outcome }); };

  const now = Date.now();
  while (sendTimes.length && sendTimes[0] <= now - 1000) sendTimes.shift();
  if (sendTimes.length >= C.mps) { stats.r429 += 1; record('429'); console.log('@@FAULT ' + JSON.stringify({ t: Date.now(), key, attempt, kind: '429' })); return json(res, 429, { error: { message: '(#130429) Rate limit hit', type: 'OAuthException', code: 130429 } }, { 'retry-after': '1' }); }
  sendTimes.push(now);
  if (type === 'interactive' && C.rejectInteractive > 0 && U('rejectInteractive', key) < C.rejectInteractive) { stats.r429 += 1; record('429-injected'); injected.rejectInteractive.push(`${key}#${attempt}`); console.log('@@FAULT ' + JSON.stringify({ t: Date.now(), key, attempt, kind: '429-injected' })); return json(res, 429, { error: { message: '(#130429) Rate limit hit (injected)', type: 'OAuthException', code: 130429 } }, { 'retry-after': '1' }); }
  const p5xx = Math.min(1, (C.base5xx || 0) + (C.err5xx || 0));
  if (p5xx > 0 && U('5xx', key, attempt) < p5xx) { stats.r5xx += 1; record('5xx'); injected.err5xx.push(`${key}#${attempt}`); console.log('@@FAULT ' + JSON.stringify({ t: Date.now(), key, attempt, kind: '5xx' })); await sleep(30); return json(res, 503, { error: { message: 'Service unavailable', code: 2 } }); }

  await sleep(logn(isImage ? C.mediaMs : C.textMs, 0.3, 'sendLat', key, attempt) * C.latFactor);
  const id = `wamid.FM${process.pid}.${++stats.accepted}`;
  const btn = type === 'interactive' ? body.interactive?.action?.buttons?.[0]?.reply?.id : undefined;
  const btnTitle = type === 'interactive' ? body.interactive?.action?.buttons?.[0]?.reply?.title : undefined;
  if (type === 'text') stats.text += 1; else if (type === 'image') stats.image += 1; else if (type === 'interactive') stats.interactive += 1; else stats.other += 1;
  const lost = C.lostResp > 0 && U('lost', key, attempt) < C.lostResp;     // accepted by "Meta", the answer never arrives
  record(lost ? 'accepted-lost' : 'accepted');
  console.log('@@SEND ' + JSON.stringify({ t: Date.now(), to, type, id, idx: mk ? Number(mk[2]) : null, camp: mk ? mk[1] : null, btn: btn || null, title: btnTitle || null, key, attempt, prev, lost }));
  scheduleStatuses(id, to, isImage, body.biz_opaque_callback_data, { key, attempt, media: isImage });
  if (lost) { stats.lost += 1; injected.lostResp.push(`${key}#${attempt}`); req.socket.destroy(); return; }
  return json(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id }] });
});
server.keepAliveTimeout = 30000;
server.listen(C.port, '127.0.0.1', () => console.log('@@READY ' + server.address().port));

const maxOf = (a) => { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; };   // Math.max(...a) throws RangeError above ~120k elements
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const snapshot = (full) => ({ t: Date.now(), ...stats, delivery: { accepted: stats.accepted, sentAcked: sentAcked.size, terminalAcked: terminalAcked.size, failedAcked: failedAcked.size, acceptedWithoutTerminal: stats.accepted - terminalAcked.size }, ...(full ? { failedIds: [...failedAcked.entries()], terminalPostedAt: Object.fromEntries(terminalPostedAt), rejectedInteractive: injected.rejectInteractive.length, injected: { counts: Object.fromEntries(Object.entries(injected).map(([k, v]) => [k, v.length])), lostResp: injected.lostResp, err5xx: injected.err5xx, failedStatus: injected.failedStatus, slowTail: injected.slowTail, dupStatus: injected.dupStatus, rejectInteractive: injected.rejectInteractive }, retriedMessages: [...attemptsOf.entries()].filter(([, h]) => h.length > 1).length, messagesWithAttempts: attemptsOf.size } : {}), postsInFlight, maxInFlightPosts, gatewayAckMs: { n: ackMs.length, p50: pct(ackMs, 50), p95: pct(ackMs, 95), p99: pct(ackMs, 99), max: ackMs.length ? maxOf(ackMs) : null }, dyn: { latFactor: C.latFactor, err5xx: C.err5xx, base5xx: C.base5xx, blackout: C.blackout, statusMult: C.statusMult, statusLoss: C.statusLoss, mps: C.mps, lostResp: C.lostResp } });
const tick = setInterval(() => { console.log('@@META ' + JSON.stringify(snapshot())); ackMs.splice(0, Math.max(0, ackMs.length - 50000)); }, 5000); tick.unref();
process.on('message', (m) => {
  if (m?.cmd === 'set') { C[m.key] = m.value; console.log('@@META_SET ' + JSON.stringify({ key: m.key, value: m.value, t: Date.now() })); }
  if (m?.cmd === 'dump') { console.log('@@METADUMP ' + JSON.stringify(snapshot(true))); if (process.send) process.send({ dumped: true }); }
});
void recent;
