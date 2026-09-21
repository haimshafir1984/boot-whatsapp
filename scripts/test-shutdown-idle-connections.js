/**
 * test-shutdown-idle-connections.js
 * server.close() waits for EVERY connection to end; idle keep-alive sockets (the gateway holds them open to each client) never end inside
 * the grace period, which wedged shutdown step 1 until forceExit (exit 1) with the workers never stopped. The handler now also calls
 * server.closeIdleConnections(): idle sockets are released, a request that is really in flight is left alone and completes.
 *   A. a keep-alive socket idle at shutdown -> shutdown finishes quickly, exit 0, workers stopped (and it wedged before the change)
 *   B. a request truly in flight (slow response) still completes with its full body, and shutdown waits for it, exit 0
 *   C. after shutdown a new connection is refused
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { createShutdownHandler } = require('../dist/shutdown');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' ' + extra : '')); };

function makeServer(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
function handlerFor(server, extra = {}) {
  const exits = []; const order = [];
  const shutdown = createShutdownHandler({
    server, workers: [{ stop: async () => { order.push('workers.stop'); } }], storage: { close: async () => { order.push('storage.close'); } },
    exit: (c) => exits.push(c), log: () => {}, errorLog: () => {}, ...extra,
  });
  return { shutdown, exits, order };
}

(async () => {
  // A. idle keep-alive socket
  {
    const server = await makeServer((req, res) => res.end('ok'));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    await new Promise((resolve, reject) => http.get({ port: server.address().port, host: '127.0.0.1', agent }, (r) => { r.resume(); r.on('end', resolve); }).on('error', reject));
    await sleep(50);   // the socket now sits idle in the agent's keep-alive pool
    const { shutdown, exits, order } = handlerFor(server, { graceMs: 3000 });
    const t0 = Date.now(); await shutdown('SIGTERM'); const took = Date.now() - t0;
    check('A. idle keep-alive socket does not wedge shutdown: exit 0, well inside the grace period, workers stopped', exits.length === 1 && exits[0] === 0 && took < 1500 && order[0] === 'workers.stop', `(took ${took}ms exits=${JSON.stringify(exits)})`);
    agent.destroy();
  }
  // B. request truly in flight
  {
    let sendResponse; const held = new Promise((r) => { sendResponse = r; });
    let started; const startedP = new Promise((r) => { started = r; });
    const server = await makeServer((req, res) => { started(); held.then(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('complete-body'); }); });
    const agent = new http.Agent({ keepAlive: true });
    const clientDone = new Promise((resolve, reject) => http.get({ port: server.address().port, host: '127.0.0.1', agent }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); }).on('error', reject));
    await startedP;
    const { shutdown, exits, order } = handlerFor(server, { graceMs: 5000 });
    const sd = shutdown('SIGTERM');
    await sleep(300);
    check('B1. shutdown waits while a request is really in flight (workers not stopped yet)', order.length === 0 && exits.length === 0);
    sendResponse();
    const res = await clientDone; await sd;
    check('B2. the in-flight request completes with its full response (not cut)', res.status === 200 && res.body === 'complete-body', JSON.stringify(res));
    check('B3. then shutdown proceeds: workers stop, exit 0', exits.length === 1 && exits[0] === 0 && order[0] === 'workers.stop');
    agent.destroy();
  }
  // C. refuses new connections
  {
    const server = await makeServer((req, res) => res.end('ok'));
    const port = server.address().port;
    const { shutdown } = handlerFor(server);
    await shutdown('SIGTERM');
    const refused = await new Promise((resolve) => { const r = http.get({ port, host: '127.0.0.1', agent: false }, () => resolve(false)); r.on('error', () => resolve(true)); });
    check('C. a new connection after shutdown is refused', refused);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`shutdown-idle-connections: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
