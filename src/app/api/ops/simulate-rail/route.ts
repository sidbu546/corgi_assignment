/**
 * POST /api/ops/simulate-rail — make the rail's settlement notification arrive.
 *
 * WHAT IS REAL AND WHAT IS SIMULATED, stated exactly.
 *
 *   REAL       the ACH relationship at Alpaca, the transfer, its id, and the
 *              fact that Alpaca is holding it at SENT_TO_CLEARING right now
 *   SIMULATED  Alpaca telling us it COMPLETED
 *
 * Alpaca's sandbox settles ACH on trading days. A deposit made at a weekend
 * therefore sits in flight for days, which means the entire downstream path —
 * settled cash, investing, positions — cannot be demonstrated at all. This
 * endpoint produces the notification the rail will eventually send anyway.
 *
 * It is NOT a shortcut around the ledger. The event is signed with the bridge
 * secret and POSTed to our own /api/webhooks/alpaca, so it goes through
 * signature verification, the idempotency check and the same handler a genuine
 * Alpaca event uses. Replay it and it dedupes. There is no privileged path.
 *
 * `direction: 'returned'` produces the bounce instead — the deposit that fails
 * after the fact, which the brief asks about and which the real sandbox will
 * not generate on demand either.
 */

import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { requireOps } from '@/lib/session';
import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  await requireOps();
  const body = (await request.json().catch(() => ({}))) as {
    transferId?: string;
    /** Email of the customer whose in-flight deposit to advance. */
    customer?: string;
    outcome?: 'settled' | 'returned';
  };

  const secret = process.env.ALPACA_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'ALPACA_WEBHOOK_SECRET is not configured' },
      { status: 500 },
    );
  }

  // Find a transfer we actually recorded and that has not reached a terminal
  // state. Refusing to invent one keeps this honest: it can only advance a
  // deposit that genuinely exists at Alpaca.
  const candidates = await query<{
    provider_ref: string;
    amount_cents: bigint;
    legal_name: string;
    account_id: string | null;
  }>(
    `SELECT t.provider_ref, t.amount_cents, c.legal_name,
            c.alpaca_account_id AS account_id
       FROM cash_transfers t
       JOIN customers c ON c.id = t.customer_id
      WHERE t.provider_ref IS NOT NULL
        AND ($1::text IS NULL OR t.provider_ref = $1)
        -- Target a specific customer when asked. Without this the endpoint
        -- advanced whichever deposit happened to be newest across the whole
        -- book, which silently settled somebody else's money while a demo
        -- narrated a customer whose balances had not moved.
        AND ($2::text IS NULL OR c.email = $2)
        AND NOT EXISTS (
              SELECT 1 FROM cash_transfer_events e
               WHERE e.transfer_id = t.id AND e.kind IN ('settled', 'returned')
        )
      ORDER BY t.recorded_at DESC
      LIMIT 1`,
    [body.transferId ?? null, body.customer ?? null],
  );

  const transfer = candidates[0];
  if (!transfer) {
    return NextResponse.json(
      {
        error:
          'No in-flight deposit to advance for that customer. Every recorded ' +
          'transfer has already settled or returned — this endpoint will not ' +
          'invent one.',
      },
      { status: 404 },
    );
  }

  const outcome = body.outcome ?? 'settled';

  // Shaped exactly like a real Alpaca transfers-stream event, because it is
  // consumed by exactly the same handler.
  const event = {
    _stream: 'transfers',
    transfer_id: transfer.provider_ref,
    account_id: transfer.account_id,
    status_from: 'SENT_TO_CLEARING',
    status_to: outcome === 'settled' ? 'COMPLETE' : 'RETURNED',
    at: new Date().toISOString(),
    event_ulid: `simulated-${outcome}-${transfer.provider_ref}`,
    _simulated: true,
    _note:
      'Alpaca sandbox settles ACH on trading days. This is the notification the ' +
      'rail will send on its own; the transfer itself is real.',
  };

  const raw = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

  const response = await fetch(
    `${process.env.APP_BASE_URL}/api/webhooks/alpaca`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ledgerly-signature': signature,
        'x-ledgerly-timestamp': timestamp,
      },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    },
  );
  const result = (await response.json().catch(() => ({}))) as {
    outcome?: string;
    detail?: string;
  };

  return NextResponse.json({
    ok: response.ok,
    customer: transfer.legal_name,
    transferId: transfer.provider_ref,
    statusTo: event.status_to,
    pipeline: result.outcome,
    detail: result.detail,
    whatWasSimulated:
      'Only the settlement NOTIFICATION. The ACH relationship, the transfer and ' +
      'its id are real and exist at Alpaca. The event was signed and went ' +
      'through the same webhook endpoint, signature check and idempotency check ' +
      'as a genuine Alpaca event — replay it and it dedupes.',
  });
}
