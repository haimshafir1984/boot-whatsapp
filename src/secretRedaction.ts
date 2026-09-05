/**
 * Best-effort scrub of credential/token-shaped substrings from text that may
 * end up in an HTTP response - admin API error bodies, needs_review reasons,
 * outbox/inbox lastError fields (finding 11, point 3). Not a substitute for
 * not putting secrets in error messages in the first place; it exists as a
 * safety net so a raw driver/provider error string containing an access
 * token, a Bearer header, or a long opaque credential does not leak to the
 * dashboard just because it happened to be embedded in an Error message.
 */

// key=value / key: value pairs whose key name looks like a credential.
const KEYED_SECRET = /((?:access|api|auth|owner|client|refresh|bearer|secret|session)[-_]?(?:token|key|secret|password)?\s*[:=]\s*)([^\s"'&,;]{6,})/gi;
// Authorization: Bearer xxx / Basic xxx headers embedded in an error string.
const AUTH_HEADER = /(Authorization:\s*(?:Bearer|Basic)\s+)([^\s"'&,;]{6,})/gi;
// Standalone long opaque tokens (e.g. crypto.randomBytes(32).toString('base64url'))
// with no obvious key= prefix nearby - a broad net on purpose, since an
// over-redaction here is far cheaper than a leaked credential.
const STANDALONE_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

export function redactSecrets(text: string | undefined | null): string {
  if (!text) return '';
  let out = String(text);
  out = out.replace(KEYED_SECRET, (_m, prefix: string) => `${prefix}[REDACTED]`);
  out = out.replace(AUTH_HEADER, (_m, prefix: string) => `${prefix}[REDACTED]`);
  out = out.replace(STANDALONE_TOKEN, '[REDACTED]');
  return out;
}
