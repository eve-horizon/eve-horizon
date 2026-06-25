import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify a Slack request signature (HMAC-SHA256).
 *
 * Slack sends x-slack-signature and x-slack-request-timestamp headers.
 * The signature is computed as:
 *   v0=HMAC-SHA256(signing_secret, "v0:{timestamp}:{rawBody}")
 *
 * Requests older than 5 minutes are rejected to prevent replay attacks.
 */
export function isValidSlackSignature(
  secret: string,
  rawBody: string,
  signature: string,
  timestamp: string,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
