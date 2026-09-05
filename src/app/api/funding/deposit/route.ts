/**
 * POST /api/funding/deposit — initiate an ACH deposit through the linked bank.
 *
 * Two things happen, in one transaction:
 *
 *   1. Alpaca is asked to pull the money on the ACH rail.
 *   2. Our ledger books it as `assets:cash:pending_deposit` — money in flight.
 *
 * It is NOT booked as settled cash, and it is NOT counted in portfolio value.
 * A deposit that has not cleared is not money: it can bounce, and if we had
 * already counted it the customer would see a balance that later evaporates and
 * a return figure polluted by a flow that never happened.
 *
 * The ledger entry is written only if Alpaca accepted the transfer. If Alpaca
 * refuses, the transaction rolls back and we have not claimed money is coming
 * that is not.
 */

import { NextResponse } from 'next/server';
import { transaction } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import { createTransfer } from '@/lib/providers/alpaca';
import { postEntry, usd } from '@/lib/ledger/post';
import { dollarsToCents, formatCents } from '@/lib/money';
import {
  activeBankLink,
  assertMayTransact,
  loadCustomer,
  OnboardingError,
} from '@/lib/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Deposits above this need a second pair of eyes before they are initiated. */
const REVIEW_THRESHOLD_CENTS = 5_000_00n;

export async function POST(request: Request) {
  const session = await requireCustomer();
  const body = (await request.json().catch(() => ({}))) as { amount?: string };

  let amountCents: bigint;
  try {
    amountCents = dollarsToCents(body.amount ?? '');
  } catch {
    return NextResponse.json({ error: 'Enter a dollar amount.' }, { status: 400 });
  }
  if (amountCents <= 0n) {
    return NextResponse.json({ error: 'Amount must be positive.' }, { status: 400 });
  }
  if (amountCents > 100_000_00n) {
    return NextResponse.json(
      { error: 'Deposits over $100,000 are not supported in this demo.' },
      { status: 400 },
    );
  }

  try {
    return await transaction(async (client) => {
      const customer = await loadCustomer(client, session.customerId);
      await assertMayTransact(client, customer.id);

      const link = await activeBankLink(client, customer.id);
      if (!link || !link.alpaca_relationship_id) {
        throw new OnboardingError(
          'no_bank_link',
          'Link a bank account before depositing.',
        );
      }
      if (!customer.alpaca_account_id) {
        throw new OnboardingError(
          'no_brokerage_account',
          'No brokerage account on file.',
        );
      }

      const idempotencyKey = `dep-${customer.id.slice(0, 8)}-${Date.now()}`;

      // Ask the rail first. If it refuses, nothing is booked.
      const transfer = await createTransfer({
        accountId: customer.alpaca_account_id,
        relationshipId: link.alpaca_relationship_id,
        amountUsd: (Number(amountCents) / 100).toFixed(2),
        direction: 'INCOMING',
        transferId: idempotencyKey,
      });

      const { rows: transferRows } = await client.query<{ id: string }>(
        `INSERT INTO cash_transfers
           (customer_id, bank_link_id, direction, amount_cents, rail,
            idempotency_key, provider_ref, initiated_by, effective_at)
         VALUES ($1::uuid, $2::uuid, 'deposit', $3, 'ach', $4, $5, $6, now())
         RETURNING id`,
        [
          customer.id,
          link.id,
          amountCents.toString(),
          idempotencyKey,
          transfer.id,
          session.email,
        ],
      );

      const entry = await postEntry(client, {
        kind: 'deposit.initiated',
        effectiveAt: new Date(),
        source: 'plaid+alpaca',
        sourceRef: transfer.id,
        createdBy: session.email,
        narrative:
          `ACH deposit of ${formatCents(amountCents)} initiated from ` +
          `${link.institution} ****${link.account_mask}`,
        lines: [
          usd('assets:cash:pending_deposit', amountCents, {
            customerId: customer.id,
            memo: 'in flight — not investable, not withdrawable, excluded from value',
          }),
          usd('equity:external:bank', -amountCents),
        ],
      });

      await client.query(
        `INSERT INTO cash_transfer_events
           (transfer_id, kind, provider_event_id, entry_id, effective_at, raw)
         VALUES ($1::uuid, 'initiated', $2, $3::uuid, now(), $4::jsonb)`,
        [
          transferRows[0].id,
          `alpaca-transfer-${transfer.id}`,
          entry.id,
          JSON.stringify(transfer),
        ],
      );

      return NextResponse.json({
        ok: true,
        transferId: transfer.id,
        status: transfer.status,
        amount: formatCents(amountCents),
        entryId: entry.id,
        needsReview: amountCents > REVIEW_THRESHOLD_CENTS,
        note:
          'Booked as a pending deposit. It becomes investable when the rail ' +
          'reports it as good funds — Alpaca sandbox settles ACH on trading days.',
      });
    });
  } catch (error) {
    if (error instanceof OnboardingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
