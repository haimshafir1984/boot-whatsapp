/**
 * metaWebhookSignature.ts
 * Verifies the `X-Hub-Signature-256` header that Meta attaches to every webhook
 * POST. The gateway route `/webhooks/meta/whatsapp` receives traffic straight
 * from Meta, so without this check any party that knows the URL can inject fake
 * inbound messages.
 *
 * The HMAC is computed over the *raw* request body, which the global
 * `express.json()` parser consumes before the route handler runs. The raw buffer
 * is therefore captured in the `verify` callback of that parser and stashed on
 * `req.rawBody` (see adminServer.ts).
 */

import crypto from 'crypto';
import type { RequestHandler } from 'express';

/**
 * Pure signature check. Returns true only when `signatureHeader` is a
 * well-formed `sha256=<hex>` value that matches an HMAC-SHA256 of `rawBody`
 * keyed by `secret`. Comparison is constant-time.
 *
 * Callers decide what to do when `secret` is empty; this function treats an
 * empty secret as "cannot verify" and returns false.
 */
export function isValidMetaSignature(
  rawBody: Buffer | undefined,
  signatureHeader: unknown,
  secret: string,
): boolean {
  if (!secret) return false;
  const signature = typeof signatureHeader === 'string' ? signatureHeader : '';
  if (!signature) return false;
  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', secret)
      .update(rawBody ?? Buffer.alloc(0))
      .digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Express middleware that rejects a Meta webhook POST with 403 before it reaches
 * its handler unless the signature checks out. `getSecret` is read per-request so
 * config changes (and tests) take effect without re-wiring.
 *
 * When the secret is empty the request is allowed through unverified — deliberate,
 * so the check can ship before every existing client has the secret provisioned
 * (see docs/safety-speed-deploy-plan-2026-09-02.md B.1 step 3).
 */
export function createMetaSignatureVerifier(getSecret: () => string): RequestHandler {
  return (req, res, next) => {
    const secret = getSecret();
    if (!secret) { next(); return; }
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (isValidMetaSignature(rawBody, req.headers['x-hub-signature-256'], secret)) {
      next();
      return;
    }
    console.warn(
      '[META_GATEWAY_SIGNATURE_REJECTED]',
      req.ip,
      String(req.headers['x-hub-signature-256'] || '(none)').slice(0, 24),
    );
    res.sendStatus(403);
  };
}

