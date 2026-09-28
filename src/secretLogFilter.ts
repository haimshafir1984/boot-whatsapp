/**
 * libsignal (used by Baileys for WhatsApp encryption) console-logs whole Signal session records when a session is opened, closed or
 * pruned ("Closing session:", "Opening session:", "Removing old closed session:", "Session already closed"). Those records contain
 * private ratchet keys and root keys, which then land in container logs and in every log file that is downloaded or shared.
 * This replaces any such record with a placeholder before it is formatted. The message text itself stays, so the event is still visible.
 */

const REDACTED = '[signal session redacted]';
const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function isSignalSession(value: unknown): boolean {
  if (!value || typeof value !== 'object' || value instanceof Error) return false;
  const v = value as Record<string, unknown>;
  return 'currentRatchet' in v || '_chains' in v || ('indexInfo' in v && 'registrationId' in v);
}

type ConsoleLike = Pick<Console, (typeof METHODS)[number]>;

export function installSecretLogFilter(target: ConsoleLike = console): void {
  const marker = target as ConsoleLike & { __secretLogFilter?: boolean };
  if (marker.__secretLogFilter) return;
  marker.__secretLogFilter = true;
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map((arg) => (isSignalSession(arg) ? REDACTED : arg)));
  }
}
