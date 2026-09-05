/**
 * auth.ts — passwords and sessions.
 *
 * Deliberately small and dependency-free. Authentication is not what this
 * trial is testing, and every hour spent on it is an hour not spent on the
 * ledger. What it does need to be is *not embarrassing*: no plaintext
 * passwords, no guessable session tokens, no timing oracle on login.
 *
 * scrypt from node:crypto rather than bcrypt-the-npm-package, because it is in
 * the standard library, it is memory-hard, and it is one less dependency I would
 * have to defend line by line.
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 32;

// -----------------------------------------------------------------------------
// Passwords
// -----------------------------------------------------------------------------

/** Stored as `scrypt$<salt-hex>$<hash-hex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);

  // Constant-time: a length-varying or short-circuiting comparison leaks how
  // much of the hash matched.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// -----------------------------------------------------------------------------
// Sessions
// -----------------------------------------------------------------------------

export const SESSION_COOKIE = 'ledgerly_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionPayload {
  userId: string;
  email: string;
  role: 'customer' | 'ops';
  displayName: string;
  customerId: string | null;
  expiresAt: number;
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

function sign(body: string): string {
  return createHmac('sha256', sessionSecret()).update(body).digest('base64url');
}

/** Signed, not encrypted. The contents are not secret; the signature is. */
export function encodeSession(payload: Omit<SessionPayload, 'expiresAt'>): string {
  const full: SessionPayload = { ...payload, expiresAt: Date.now() + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeSession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
