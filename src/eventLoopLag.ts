import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';

/**
 * Event-loop lag, exposed on /health so a blocked Node process (the cause of "Health check exceeded timeout" kills) can be seen
 * in real time instead of guessed afterwards. The histogram samples every 10ms; every SAMPLE_MS we freeze one window
 * (p50 / p99 / max) and reset it, and keep the last WINDOWS windows (about 10 minutes) so a short block is still visible
 * minutes after it happened. A block longer than WARN_MAX_MS is also logged once per window.
 */
const SAMPLE_MS = 30_000;
const WINDOWS = 20;
const WARN_MAX_MS = 2_000;

export interface EventLoopLagWindow { at: string; p50Ms: number; p99Ms: number; maxMs: number }
export interface EventLoopLagSnapshot {
  windowSec: number;
  last: EventLoopLagWindow | null;
  worstP99Ms10m: number;
  worstMaxMs10m: number;
  windowsOverWarn10m: number;
}

let histogram: IntervalHistogram | null = null;
let timer: NodeJS.Timeout | null = null;
const windows: EventLoopLagWindow[] = [];

const ms = (nanos: number): number => Math.round(nanos / 1e5) / 10; // nanoseconds -> milliseconds, 0.1 precision

function closeWindow(now: Date = new Date()): void {
  if (!histogram) return;
  // An empty window (no samples yet) reports NaN/0 for percentiles; skip it.
  if (histogram.count > 0) {
    const w: EventLoopLagWindow = { at: now.toISOString(), p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max) };
    windows.push(w);
    if (windows.length > WINDOWS) windows.shift();
    if (w.maxMs >= WARN_MAX_MS) console.warn(`[EVENT_LOOP_LAG] max=${w.maxMs}ms p99=${w.p99Ms}ms over the last ${SAMPLE_MS / 1000}s`);
  }
  histogram.reset();
}

/** Idempotent. Never keeps the process alive. */
export function startEventLoopLagMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  timer = setInterval(() => closeWindow(), SAMPLE_MS);
  timer.unref();
}

export function stopEventLoopLagMonitor(): void {
  if (timer) clearInterval(timer);
  if (histogram) histogram.disable();
  timer = null;
  histogram = null;
  windows.length = 0;
}

/** Test hook: close the current window immediately instead of waiting SAMPLE_MS. */
export function closeEventLoopLagWindowForTests(): void { closeWindow(); }

export function getEventLoopLagSnapshot(): EventLoopLagSnapshot {
  return {
    windowSec: SAMPLE_MS / 1000,
    last: windows.length ? windows[windows.length - 1] : null,
    worstP99Ms10m: windows.reduce((max, w) => Math.max(max, w.p99Ms), 0),
    worstMaxMs10m: windows.reduce((max, w) => Math.max(max, w.maxMs), 0),
    windowsOverWarn10m: windows.filter((w) => w.maxMs >= WARN_MAX_MS).length,
  };
}
