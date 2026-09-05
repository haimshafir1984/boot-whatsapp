/**
 * shutdown.ts
 * Ordered drain for SIGTERM/SIGINT. Extracted from index.ts so the ordering is
 * unit-testable with fakes.
 *
 * Order matters and is fixed:
 *   1. server.close()  — stop accepting new HTTP work, wait for in-flight requests
 *      to finish (the callback fires only once existing connections drain).
 *   2. workers.stop()  — stop the background loops and wait for whatever iteration
 *      is already running (contact queue, outbox dispatcher, service-bot follow-ups).
 *   3. storage.close() — only now tear down the persistence layer. It already
 *      drains to full quiet internally (backend.close waits for draining ||
 *      queuedSnapshot), so no separate storage.flush() is needed here.
 *
 * A hard timer forces process.exit(1) if any step wedges, so a stuck flush can
 * never hang the container past the grace period.
 */

export interface ShutdownWorker {
  stop: () => Promise<void>;
}

export interface ShutdownDeps {
  server: { close: (cb: (err?: Error) => void) => void };
  workers: ShutdownWorker[];
  storage: { close: () => Promise<void> };
  /**
   * Hard cap before process.exit(1). Default 8s, matching Docker's real
   * `stop_grace_period` default (10s) with a safety margin — see
   * docs/safety-speed-deploy-plan-2026-09-02.md and the grace-period
   * discussion in docs/safety-speed-deploy-results-2026-09-02.md. The
   * platform's actual configured value is unverified; 8s is the safe,
   * immediately-actionable choice given that.
   */
  graceMs?: number;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  errorLog?: (msg: string, err?: unknown) => void;
}

export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const {
    server,
    workers,
    storage,
    graceMs = 8_000,
    exit = (code: number) => process.exit(code),
    log = (msg: string) => console.log(msg),
    errorLog = (msg: string, err?: unknown) => console.error(msg, err),
  } = deps;

  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n${signal} received, draining…`);

    const forceExit = setTimeout(() => {
      errorLog('Shutdown grace period exceeded, forcing exit.');
      exit(1);
    }, graceMs);
    forceExit.unref();

    // 1. Stop taking new requests/work — HTTP first, not storage.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 2. Stop the workers and wait for work already in flight.
    await Promise.all(workers.map((worker) => worker.stop()));
    // 3. Only now close storage — it drains to full quiet on its own, so no
    //    separate storage.flush() is needed here.
    let storageCloseFailed = false;
    try {
      await storage.close();
    } catch (err) {
      storageCloseFailed = true;
      errorLog('storage.close() on shutdown failed:', err);
    }

    clearTimeout(forceExit);
    // A failed storage.close() means unsaved writes remain (finding 02) - the
    // exit code must say so instead of reporting a clean shutdown.
    exit(storageCloseFailed ? 1 : 0);
  };
}
