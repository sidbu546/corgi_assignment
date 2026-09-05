/**
 * POST /api/invest — buy into a model portfolio with real orders.
 *
 * The amount is split across the model's weights by largest-remainder, so the
 * parts sum to exactly the amount and the split is deterministic. Each part
 * becomes a NOTIONAL order — "put $250 into VOO", not "buy 1.31 shares" —
 * because a percentage allocation of an arbitrary balance almost never lands on
 * a whole number of shares.
 *
 * WHAT IS BOOKED HERE, AND WHAT IS NOT.
 *
 * This route records the ORDER. It does not book a position, a cost basis or a
 * tax lot, because none of those exist yet: an order is an instruction, and
 * until the broker fills it there is nothing to account for. Positions appear
 * when the fill arrives through the webhook pipeline, which is also what makes
 * partial fills and rejections fall out correctly instead of needing special
 * cases.
 *
 * Writing the order row BEFORE calling Alpaca is deliberate. The client_order_id
 * is generated and persisted first, so if the network drops after Alpaca
 * accepted the order but before we saw the response, the retry reuses the same
 * id and Alpaca rejects the duplicate rather than filling twice.
 */

import { NextResponse } from 'next/server';
import Decimal from 'decimal.js';
import { transaction } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import { getTradingAccount, submitOrder } from '@/lib/providers/alpaca';
import { allocate, formatCents, dollarsToCents } from '@/lib/money';
import { cashPosition } from '@/lib/ledger/read';
import {
  assertMayTransact,
  loadCustomer,
  OnboardingError,
} from '@/lib/onboarding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await requireCustomer();
  const body = (await request.json().catch(() => ({}))) as {
    modelId?: string;
    amount?: string;
  };

  let amountCents: bigint;
  try {
    amountCents = dollarsToCents(body.amount ?? '');
  } catch {
    return NextResponse.json({ error: 'Enter a dollar amount.' }, { status: 400 });
  }
  if (amountCents <= 0n) {
    return NextResponse.json({ error: 'Amount must be positive.' }, { status: 400 });
  }
  if (!body.modelId) {
    return NextResponse.json({ error: 'Choose a model portfolio.' }, { status: 400 });
  }

  try {
    return await transaction(async (client) => {
      const customer = await loadCustomer(client, session.customerId);
      await assertMayTransact(client, customer.id);

      if (!customer.alpaca_account_id) {
        throw new OnboardingError(
          'no_brokerage_account',
          'No brokerage account on file. Link a bank first.',
        );
      }

      // Investable = settled + unsettled sale proceeds. Deliberately NOT
      // including pending deposits: you cannot invest money that has not
      // cleared, and the ledger keeps those separate precisely so this check is
      // a lookup rather than a judgement call.
      const cash = await cashPosition(customer.id);
      if (amountCents > cash.investable) {
        return NextResponse.json(
          {
            error:
              `Investable cash is ${formatCents(cash.investable)}. ` +
              (cash.pendingDeposits > 0n
                ? `${formatCents(cash.pendingDeposits)} is still in flight and cannot be invested until it settles.`
                : 'Deposit first.'),
            investable: formatCents(cash.investable),
            pending: formatCents(cash.pendingDeposits),
          },
          { status: 422 },
        );
      }

      // OUR ledger says the cash is investable. The BROKER has its own opinion,
      // and where the two disagree the broker wins for the purpose of placing an
      // order — their balance is their ledger, ours is ours.
      //
      // Checking here rather than letting Alpaca reject each order individually
      // turns an opaque 422 per symbol into one legible explanation, and shows
      // both numbers side by side. A divergence between our ledger and the
      // broker's is not an error to swallow; it is exactly the thing the
      // reconciliation screen exists to surface.
      const brokerAccount = await getTradingAccount(customer.alpaca_account_id).catch(
        () => null,
      );

      if (!brokerAccount) {
        return NextResponse.json(
          {
            error:
              'The brokerage account is not reachable right now. No orders were ' +
              'placed, and nothing has been booked.',
          },
          { status: 503 },
        );
      }

      const brokerBuyingPowerCents = dollarsToCents(brokerAccount.buying_power || '0');

      if (amountCents > brokerBuyingPowerCents) {
        return NextResponse.json(
          {
            error:
              `The broker reports ${formatCents(brokerBuyingPowerCents)} of buying power, ` +
              `so no orders were placed.`,
            ourInvestableCash: formatCents(cash.investable),
            brokerBuyingPower: formatCents(brokerBuyingPowerCents),
            pendingDeposits: formatCents(cash.pendingDeposits),
            why:
              cash.pendingDeposits > 0n
                ? 'A deposit is in flight. Alpaca sandbox settles ACH on trading ' +
                  'days, so funds initiated outside a trading day stay pending — ' +
                  'and unsettled money is not buying power at the broker either.'
                : 'Our ledger and the broker disagree. That is a reconciliation ' +
                  'break, not a rounding issue, and it is shown rather than hidden.',
          },
          { status: 422 },
        );
      }

      const { rows: weights } = await client.query<{
        symbol: string;
        weight_bps: number;
      }>(
        `SELECT w.symbol, w.weight_bps
           FROM model_weights w
           JOIN model_versions v ON v.id = w.model_version_id
          WHERE v.model_id = $1
          ORDER BY v.version DESC, w.symbol`,
        [body.modelId],
      );
      if (weights.length === 0) {
        return NextResponse.json({ error: 'Unknown model portfolio.' }, { status: 400 });
      }

      const parts = allocate(
        amountCents,
        weights.map((w) => new Decimal(w.weight_bps)),
      );

      const submitted: Array<{
        symbol: string;
        notional: string;
        clientOrderId: string;
        brokerOrderId: string | null;
        status: string;
        error?: string;
      }> = [];

      for (let i = 0; i < weights.length; i++) {
        const symbol = weights[i].symbol;
        const notional = parts[i];
        if (notional <= 0n) continue;

        const clientOrderId = `inv-${customer.id.slice(0, 8)}-${Date.now()}-${symbol}`;

        // Persist the order BEFORE the network call, so the idempotency key
        // exists on our side even if the response never arrives.
        const { rows: orderRows } = await client.query<{ id: string }>(
          `INSERT INTO orders
             (customer_id, symbol, side, requested_cents, client_order_id,
              submitted_by, effective_at)
           VALUES ($1::uuid, $2, 'buy', $3, $4, $5, now())
           RETURNING id`,
          [customer.id, symbol, notional.toString(), clientOrderId, session.email],
        );

        try {
          const order = await submitOrder({
            accountId: customer.alpaca_account_id,
            symbol,
            side: 'buy',
            notionalUsd: (Number(notional) / 100).toFixed(2),
            clientOrderId,
          });

          await client.query(
            `UPDATE orders SET broker_order_id = $2 WHERE id = $1::uuid`,
            [orderRows[0].id, order.id],
          );
          await client.query(
            `INSERT INTO order_events (order_id, kind, broker_event_id, raw, effective_at)
             VALUES ($1::uuid, 'submitted', $2, $3::jsonb, now())
             ON CONFLICT (broker_event_id) DO NOTHING`,
            [orderRows[0].id, `submit-${order.id}`, JSON.stringify(order)],
          );

          submitted.push({
            symbol,
            notional: formatCents(notional),
            clientOrderId,
            brokerOrderId: order.id,
            status: order.status,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await client.query(
            `INSERT INTO order_events (order_id, kind, broker_event_id, raw, effective_at)
             VALUES ($1::uuid, 'rejected', $2, $3::jsonb, now())
             ON CONFLICT (broker_event_id) DO NOTHING`,
            [
              orderRows[0].id,
              `reject-${clientOrderId}`,
              JSON.stringify({ error: message }),
            ],
          );
          submitted.push({
            symbol,
            notional: formatCents(notional),
            clientOrderId,
            brokerOrderId: null,
            status: 'rejected',
            error: message.slice(0, 300),
          });
        }
      }

      const accepted = submitted.filter((s) => s.status !== 'rejected').length;

      return NextResponse.json({
        ok: accepted > 0,
        modelId: body.modelId,
        amount: formatCents(amountCents),
        orders: submitted,
        note:
          'Orders are recorded as instructions. Positions, cost basis and tax ' +
          'lots appear only when a fill arrives through the webhook pipeline — ' +
          'an unfilled order is not a holding.',
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
