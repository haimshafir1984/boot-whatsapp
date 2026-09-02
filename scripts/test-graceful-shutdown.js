/**
 * test-graceful-shutdown.js
 * Covers step 2 (A.1) of docs/safety-speed-deploy-plan-2026-09-02.md:
 * ordered SIGTERM drain + stoppable background workers.
 *
 *  1. createShutdownHandler ordering: HTTP close -> workers.stop -> storage.close -> exit(0)
 *  2. forced timeout: storage.close() wedged forever -> process.exit(1) fires, no hang
 *  3. double signal is a no-op
 *  4. storage.close() throwing is logged, shutdown still finishes with exit(0)
 *  5. shutdown waits for an in-flight HTTP request (server.close cb) before stopping workers
 *  6. a real http.Server, once closed, refuses new connections (the pattern shutdown uses)
 *  7. startContactSaveQueue().stop() ends the loop; no job is processed after stop() resolves
 *  8. startOutboxDispatcher().stop() waits for a dispatch that is mid-send; markOutboxSent +
 *     the trailing flush land before stop() resolves; nothing writes after storage.close()
 *  9. startServiceBotFollowUpDispatcher().stop() waits for the current tick
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { createShutdownHandler } = require('../dist/shutdown');
const { startContactSaveQueue } = require('../dist/contactQueue');
const { startOutboxDispatcher } = require('../dist/outboxDispatcher');
const { startServiceBotFollowUpDispatcher } = require('../dist/serviceBotFollowUpDispatcher');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function testOrdering() {
  const order = [];
  const exits = [];
  const shutdown = createShutdownHandler({
    server: { close: (cb) => { order.push('server.close'); setTimeout(cb, 10); } },
    workers: [
      { stop: async () => { order.push('worker-a.stop'); } },
      { stop: async () => { order.push('worker-b.stop'); } },
    ],
    storage: { close: async () => { order.push('storage.close'); } },
    exit: (code) => exits.push(code),
    log: () => {},
    errorLog: () => {},
  });
  await shutdown('SIGTERM');
  assert.deepEqual(
    order,
    ['server.close', 'worker-a.stop', 'worker-b.stop', 'storage.close'],
    'HTTP closes first, then workers, then storage',
  );
  assert.deepEqual(exits, [0], 'clean shutdown exits 0 exactly once');
  console.log('  1. ordering: server.close -> workers.stop -> storage.close -> exit(0)');
}

async function testForcedTimeout() {
  const exits = [];
  let forcedMsg = '';
  const shutdown = createShutdownHandler({
    server: { close: (cb) => cb() },
    workers: [{ stop: async () => {} }],
    storage: { close: () => new Promise(() => {}) }, // never resolves
    graceMs: 150,
    exit: (code) => exits.push(code),
    log: () => {},
    errorLog: (msg) => { forcedMsg = msg; },
  });
  const started = Date.now();
  shutdown('SIGTERM');
  await sleep(120);
  assert.deepEqual(exits, [], 'no exit before the grace period elapses');
  await sleep(200);
  const elapsed = Date.now() - started;
  // storage.close() never resolves, so the only path to exit is the forced timer.
  assert.deepEqual(exits, [1], 'a wedged storage.close() forces exit(1)');
  assert.ok(elapsed < 2000, `forced exit fired via graceMs, not the 22s default (elapsed=${elapsed}ms)`);
  assert.match(forcedMsg, /grace period exceeded/i, 'forced exit is logged');
  console.log('  2. forced timeout: wedged storage.close() -> exit(1) after graceMs, no hang');
}

async function testDoubleSignal() {
  const exits = [];
  let closes = 0;
  const shutdown = createShutdownHandler({
    server: { close: (cb) => { closes += 1; setTimeout(cb, 20); } },
    workers: [{ stop: async () => {} }],
    storage: { close: async () => {} },
    exit: (code) => exits.push(code),
    log: () => {},
    errorLog: () => {},
  });
  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);
  assert.equal(closes, 1, 'server.close() runs once despite three signals');
  assert.deepEqual(exits, [0], 'exit is called once');
  console.log('  3. double signal is a no-op');
}

async function testStorageCloseThrows() {
  const exits = [];
  let logged = '';
  const shutdown = createShutdownHandler({
    server: { close: (cb) => cb() },
    workers: [{ stop: async () => {} }],
    storage: { close: async () => { throw new Error('pool already ended'); } },
    exit: (code) => exits.push(code),
    log: () => {},
    errorLog: (msg) => { logged = msg; },
  });
  await shutdown('SIGTERM');
  assert.match(logged, /storage\.close\(\) on shutdown failed/, 'the failure is logged');
  assert.deepEqual(exits, [0], 'shutdown still completes with exit(0)');
  console.log('  4. storage.close() throwing is logged, shutdown still exits 0');
}

async function testWaitsForInflightRequest() {
  const order = [];
  const serverCloseCb = deferred();
  const shutdown = createShutdownHandler({
    server: { close: (cb) => { order.push('server.close called'); serverCloseCb.promise.then(cb); } },
    workers: [{ stop: async () => { order.push('worker.stop'); } }],
    storage: { close: async () => { order.push('storage.close'); } },
    exit: () => {},
    log: () => {},
    errorLog: () => {},
  });
  const done = shutdown('SIGTERM');
  await sleep(50);
  assert.deepEqual(order, ['server.close called'], 'workers do not stop while an HTTP request is still draining');
  serverCloseCb.resolve(); // the in-flight request finishes now
  await done;
  assert.deepEqual(order, ['server.close called', 'worker.stop', 'storage.close'], 'drain resumes once HTTP is closed');
  console.log('  5. shutdown waits for in-flight HTTP before stopping workers');
}

async function testRealServerRefusesAfterClose() {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const get = () => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, timeout: 1000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });

  assert.equal(await get(), 200, 'server answers before close');
  await new Promise((resolve) => server.close(() => resolve()));
  await assert.rejects(get(), (err) => err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'),
    'after server.close() a new connection is refused');
  console.log('  6. a closed http.Server refuses new connections');
}

async function testContactQueueStop() {
  let attempts = 0;
  const job = { id: 'job-1', phone: '9720000000001', name: 'x', provider: 'manual', attempts: 0 };
  const fakeStorage = {
    getDueContactSaveJob: () => job, // infinite supply
    markContactSaveAttempt: (id) => { attempts += 1; return { ...job, id, attempts: 1 }; },
    markContactSaved: () => {},
    markContactSaveFailed: () => null,
  };
  const queue = startContactSaveQueue(fakeStorage);
  await sleep(60); // let it process a few
  assert.ok(attempts >= 1, 'queue processed at least one job before stop');
  const stopReturned = await Promise.race([queue.stop().then(() => true), sleep(2500).then(() => false)]);
  assert.equal(stopReturned, true, 'stop() resolves, it does not hang on the loop');
  const afterStop = attempts;
  await sleep(200);
  assert.equal(attempts, afterStop, 'no job is processed after stop() resolves (no getDue/processOne race)');

  // flag reset -> a fresh queue can start again in-process
  const queue2 = startContactSaveQueue(fakeStorage);
  await sleep(40);
  assert.ok(attempts > afterStop, 'a new queue instance runs after the previous one stopped');
  await queue2.stop();
  console.log('  7. contactQueue.stop() ends the loop; no processing after it resolves');
}

async function testOutboxDispatcherStopMidSend() {
  const events = [];
  const sendGate = deferred();
  let closed = false;
  const claimed = { id: 'm1', to: '9720000000002', kind: 'text', text: 'hi', attempts: 0, status: 'processing' };
  let handedOut = false;
  const fakeStorage = {
    getPendingOutboxMessages: () => {
      if (handedOut) return [];
      handedOut = true;
      return [{ ...claimed }];
    },
    claimOutboxMessage: () => ({ ...claimed }),
    markOutboxSent: () => {
      if (closed) throw new Error('write after storage.close()');
      events.push('markOutboxSent');
    },
    markOutboxFailed: () => { events.push('markOutboxFailed'); },
    markOutboxRetry: () => { events.push('markOutboxRetry'); },
    flush: async () => {
      if (closed) throw new Error('flush after storage.close()');
      events.push('flush');
    },
    close: async () => { closed = true; },
  };
  const transport = {
    async sendMessage() { events.push('send:start'); await sendGate.promise; events.push('send:end'); return { messageId: 'p1' }; },
    async resolvePhone(jid) { return jid; },
  };

  const dispatcher = startOutboxDispatcher(fakeStorage, () => transport, 10_000);
  await sleep(50);
  assert.deepEqual(events, ['flush', 'send:start'], 'dispatch claimed + flushed, now blocked inside send()');

  let stopResolved = false;
  const stopPromise = dispatcher.stop().then(() => { stopResolved = true; });
  await sleep(50);
  assert.equal(stopResolved, false, 'stop() is still waiting for the in-flight dispatch');

  sendGate.resolve();
  await stopPromise;
  assert.equal(stopResolved, true, 'stop() resolves once the dispatch completes');
  assert.deepEqual(
    events,
    ['flush', 'send:start', 'send:end', 'markOutboxSent', 'flush'],
    'markOutboxSent and the trailing flush land before stop() returns',
  );

  await fakeStorage.close();
  await sleep(50);
  assert.deepEqual(events.slice(-1), ['flush'], 'no further storage writes after close() (dispatcher is stopped)');
  console.log('  8. outboxDispatcher.stop() waits for a mid-send dispatch; no write races close()');
}

async function testServiceBotDispatcherStop() {
  const events = [];
  const flushGate = deferred();
  const due = { id: 'f1' };
  let handedOut = false;
  let flushes = 0;
  const fakeStorage = {
    getDueServiceBotFollowUps: () => (handedOut ? [] : (handedOut = true, [due])),
    claimServiceBotFollowUp: () => ({ ...due }),
    completeServiceBotFollowUp: () => { events.push('complete'); },
    failServiceBotFollowUp: () => { events.push('fail'); },
    // The tick always awaits storage.flush() after (attempting) a delivery — gate
    // the first flush so the tick is provably still in flight when stop() is called.
    flush: async () => {
      flushes += 1;
      events.push('flush');
      if (flushes === 1) await flushGate.promise;
    },
    getServiceBots: () => [],
  };
  const transport = { async sendMessage() { return { messageId: 'x' }; }, async resolvePhone(jid) { return jid; } };

  const dispatcher = startServiceBotFollowUpDispatcher(fakeStorage, () => transport, 10_000);
  await sleep(50);
  assert.ok(events.includes('flush'), 'tick reached the flush() after handling the follow-up');

  let stopResolved = false;
  const stopPromise = dispatcher.stop().then(() => { stopResolved = true; });
  await sleep(50);
  assert.equal(stopResolved, false, 'stop() waits while the follow-up tick is still inside flush()');

  flushGate.resolve();
  const finished = await Promise.race([stopPromise.then(() => true), sleep(2000).then(() => false)]);
  assert.equal(finished, true, 'service-bot dispatcher stop() resolves once the tick completes');
  assert.equal(stopResolved, true, 'stop() resolved after the gated flush released');
  console.log('  9. serviceBotFollowUpDispatcher.stop() waits for the current tick');
}

async function main() {
  await testOrdering();
  await testForcedTimeout();
  await testDoubleSignal();
  await testStorageCloseThrows();
  await testWaitsForInflightRequest();
  await testRealServerRefusesAfterClose();
  await testContactQueueStop();
  await testOutboxDispatcherStopMidSend();
  await testServiceBotDispatcherStop();
  console.log('Graceful shutdown tests passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
