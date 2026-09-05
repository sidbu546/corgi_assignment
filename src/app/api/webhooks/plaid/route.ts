/**
 * POST /api/webhooks/plaid — bank-link events. LIVE.
 *
 * Plaid signs with a JWT in the `Plaid-Verification` header rather than an HMAC.
 * Verification checks three things, and skipping any one of them makes the
 * check decorative:
 *
 *   1. the JWT is signed by Plaid (ES256, key fetched by `kid`)
 *   2. the algorithm really is ES256 — refusing anything else blocks the
 *      classic `alg: none` downgrade
 *   3. `request_body_sha256` matches the body we actually received — without
 *      this, a valid JWT could be replayed against a body of the attacker's
 *      choosing
 *
 * What we act on: link health. A bank link that has errored or is about to
 * expire cannot fund an account, and the customer needs to be told before they
 * try rather than after a deposit fails.
 */

import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { verifyPlaid } from '@/lib/webhooks/signatures';
import { captureHeaders, receiveWebhook } from '@/lib/webhooks/inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PlaidWebhook {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string; error_message?: string } | null;
  environment?: string;
}

/** Codes that mean the link can no longer be used to move money. */
const LINK_BROKEN = new Set([
  'ERROR',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'USER_PERMISSION_REVOKED',
  'USER_ACCOUNT_REVOKED',
  'LOGIN_REPAIRED',
]);

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = captureHeaders(request.headers);

  const verification = await verifyPlaid(
    rawBody,
    request.headers.get('plaid-verification'),
    {
      clientId: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      env: process.env.PLAID_ENV ?? 'sandbox',
    },
  );

  let parsed: PlaidWebhook = {};
  try {
    parsed = JSON.parse(rawBody) as PlaidWebhook;
  } catch {
    /* recorded as unparseable */
  }

  const type = parsed.webhook_type ?? 'UNKNOWN';
  const code = parsed.webhook_code ?? 'UNKNOWN';

  // Plaid does not send an event id on every webhook. Composing a stable key
  // from (type, code, item_id) plus the body hash means a genuine re-send of
  // the same notification dedupes, while a materially different notification
  // does not collide. Documented because it is a judgement call, not a given.
  const bodyHash = await sha256Hex(rawBody);
  const providerEventId = `${type}:${code}:${parsed.item_id ?? 'no-item'}:${bodyHash.slice(0, 16)}`;

  const result = await receiveWebhook({
    provider: 'plaid',
    providerEventId,
    eventType: `${type}.${code}`,
    rawBody,
    headers,
    verification,
    handle: (client) => handlePlaidWebhook(client, parsed),
  });

  return NextResponse.json(
    { received: true, outcome: result.outcome, detail: result.detail },
    { status: 200 },
  );
}

async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

async function handlePlaidWebhook(
  client: PoolClient,
  webhook: PlaidWebhook,
): Promise<string> {
  const type = webhook.webhook_type ?? 'UNKNOWN';
  const code = webhook.webhook_code ?? 'UNKNOWN';

  if (!webhook.item_id) {
    return `recorded but not acted on: ${type}.${code} carries no item_id`;
  }

  const { rows } = await client.query<{ id: string; legal_name: string }>(
    `SELECT id, legal_name FROM customers WHERE plaid_item_id = $1`,
    [webhook.item_id],
  );
  const customer = rows[0];
  if (!customer) {
    return `recorded but not acted on: no customer linked to item ${webhook.item_id}`;
  }

  if (type === 'ITEM' && LINK_BROKEN.has(code)) {
    // Deactivate rather than delete: the link is reference data, and the
    // history of a link having existed matters when reconciling old deposits.
    await client.query(
      `UPDATE bank_links SET is_active = false
        WHERE customer_id = $1::uuid AND provider = 'plaid'`,
      [customer.id],
    );
    return (
      `${customer.legal_name}: bank link deactivated on ${type}.${code}` +
      (webhook.error?.error_code ? ` (${webhook.error.error_code})` : '')
    );
  }

  return `recorded: ${type}.${code} for ${customer.legal_name}, no action required`;
}
