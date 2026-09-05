/**
 * signatures.ts — verify that an inbound webhook really came from the provider.
 *
 * Three rules this module holds to, because each guards a real attack:
 *
 *  1. VERIFY AGAINST THE RAW BODY, never a re-serialised object. `JSON.parse`
 *     then `JSON.stringify` reorders keys and drops whitespace, so the bytes you
 *     hash stop being the bytes that were signed. Every function here takes a
 *     string.
 *
 *  2. COMPARE IN CONSTANT TIME. A `===` on a signature is a timing oracle: an
 *     attacker who can measure response time can recover a valid signature byte
 *     by byte. `timingSafeEqual`, always.
 *
 *  3. CHECK THE TIMESTAMP. A signature with no freshness bound is a replay
 *     token forever. A captured-and-replayed delivery is separately harmless
 *     here because consumers are idempotent — but defence in depth is the whole
 *     point of a signature.
 *
 * A verification FAILURE is recorded in the inbox and returns 200, not 4xx.
 * That is deliberate: a provider that gets a 4xx will retry, hammering an
 * endpoint that will never accept the message. We want the bad delivery
 * captured and visible on a screen, not bouncing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';

export interface VerificationResult {
  valid: boolean;
  /** Human-readable, shown in the webhook inbox. Never leaks the secret. */
  detail: string;
  /** True when no secret is configured, so we could not verify either way. */
  unverifiable?: boolean;
}

/** Five minutes, the usual tolerance for clock skew plus network delay. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// -----------------------------------------------------------------------------
// Persona — `Persona-Signature: t=<unix>,v1=<hex>`
// signature = HMAC-SHA256(secret, `${t}.${rawBody}`)
// -----------------------------------------------------------------------------

export function verifyPersona(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
): VerificationResult {
  if (!secret) {
    return {
      valid: false,
      unverifiable: true,
      detail:
        'PERSONA_WEBHOOK_SECRET is not configured, so this delivery could not be ' +
        'verified. Recorded but NOT processed.',
    };
  }
  if (!header) {
    return { valid: false, detail: 'missing Persona-Signature header' };
  }

  // Persona may rotate secrets, sending several v1= values in one header.
  const parts = header.split(',').map((p) => p.trim());
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));

  if (!t || signatures.length === 0) {
    return { valid: false, detail: `malformed Persona-Signature: ${header.slice(0, 60)}` };
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) {
    return {
      valid: false,
      detail: `timestamp outside tolerance: ${age}s old (max ${TIMESTAMP_TOLERANCE_SECONDS}s)`,
    };
  }

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const matched = signatures.some((sig) => safeEqualHex(expected, sig));

  return matched
    ? { valid: true, detail: `HMAC-SHA256 over "t.body" verified (t=${t}, age ${age}s)` }
    : { valid: false, detail: 'signature did not match any v1 value in the header' };
}

// -----------------------------------------------------------------------------
// Plaid — `Plaid-Verification: <JWT>` (ES256)
//
// The JWT's `request_body_sha256` claim must equal SHA-256 of the raw body, and
// the JWT itself is verified against Plaid's JWKS, keyed by the header `kid`.
// Verifying only the JWT signature without checking the body hash would let
// anyone replay a valid JWT with a body of their choosing.
// -----------------------------------------------------------------------------

const plaidJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(env: string) {
  const url = `https://${env}.plaid.com/webhook_verification_key/get`;
  // Plaid's key endpoint is a POST API rather than a standard JWKS URL, so the
  // remote set is keyed per environment and fetched lazily.
  let set = plaidJwks.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    plaidJwks.set(url, set);
  }
  return set;
}

export async function verifyPlaid(
  rawBody: string,
  header: string | null,
  opts: { clientId?: string; secret?: string; env?: string } = {},
): Promise<VerificationResult> {
  if (!header) return { valid: false, detail: 'missing Plaid-Verification header' };
  if (!opts.clientId || !opts.secret) {
    return {
      valid: false,
      unverifiable: true,
      detail: 'Plaid credentials not configured; cannot fetch the verification key',
    };
  }

  const env = opts.env ?? 'sandbox';

  try {
    // The kid tells us which key to ask Plaid for.
    const [encodedHeader] = header.split('.');
    const jwtHeader = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()) as {
      kid?: string;
      alg?: string;
    };

    if (jwtHeader.alg !== 'ES256') {
      // Refusing anything but ES256 blocks the classic "alg: none" downgrade.
      return { valid: false, detail: `unexpected JWT alg: ${jwtHeader.alg}` };
    }
    if (!jwtHeader.kid) return { valid: false, detail: 'JWT has no kid' };

    const response = await fetch(`https://${env}.plaid.com/webhook_verification_key/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: opts.clientId,
        secret: opts.secret,
        key_id: jwtHeader.kid,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { valid: false, detail: `key fetch failed: HTTP ${response.status}` };
    }
    const { key } = (await response.json()) as { key: JsonWebKey };

    const { importJWK } = await import('jose');
    const publicKey = await importJWK(key as Parameters<typeof importJWK>[0], 'ES256');
    const { payload } = await jwtVerify(header, publicKey, { algorithms: ['ES256'] });

    const claimed = payload.request_body_sha256 as string | undefined;
    if (!claimed) return { valid: false, detail: 'JWT has no request_body_sha256 claim' };

    const actual = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    if (!safeEqualHex(claimed, actual)) {
      return {
        valid: false,
        detail: 'body hash does not match the JWT claim — body was altered in transit',
      };
    }

    const issuedAt = Number(payload.iat ?? 0);
    const age = Math.floor(Date.now() / 1000) - issuedAt;
    if (age > TIMESTAMP_TOLERANCE_SECONDS) {
      return { valid: false, detail: `JWT is ${age}s old (max ${TIMESTAMP_TOLERANCE_SECONDS}s)` };
    }

    return { valid: true, detail: `ES256 JWT verified, body hash matches (age ${age}s)` };
  } catch (error) {
    return {
      valid: false,
      detail: `verification error: ${error instanceof Error ? error.message : error}`,
    };
  }
}

// -----------------------------------------------------------------------------
// Generic shared-secret HMAC.
//
// Used by the Alpaca events bridge and the custodian file simulator. Both are
// under our control, so a plain HMAC over the raw body with a shared secret is
// the right amount of ceremony — and it means the bridge cannot forge a fill
// unless it holds the secret.
// -----------------------------------------------------------------------------

export function verifySharedSecretHmac(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secret: string | undefined,
  label: string,
): VerificationResult {
  if (!secret) {
    return {
      valid: false,
      unverifiable: true,
      detail: `${label} secret is not configured; delivery recorded but NOT processed`,
    };
  }
  if (!signatureHeader) return { valid: false, detail: 'missing signature header' };
  if (!timestampHeader) return { valid: false, detail: 'missing timestamp header' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestampHeader));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) {
    return { valid: false, detail: `timestamp outside tolerance: ${age}s` };
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest('hex');

  return safeEqualHex(expected, signatureHeader)
    ? { valid: true, detail: `${label} HMAC-SHA256 verified (age ${age}s)` }
    : { valid: false, detail: 'signature mismatch' };
}

/** Sign an outbound payload the same way, used by the bridge and simulator. */
export function signSharedSecret(
  rawBody: string,
  secret: string,
): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return { signature, timestamp };
}
