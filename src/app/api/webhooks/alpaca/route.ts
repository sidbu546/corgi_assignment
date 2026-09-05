/**
 * POST /api/webhooks/alpaca — order lifecycle events.
 *
 * HOW EVENTS ACTUALLY REACH THIS ROUTE — stated plainly, because the honest
 * answer matters more than the convenient one.
 *
 * Alpaca's Broker sandbox offers NO webhook registration. I verified this
 * rather than assumed it: `/v1/webhooks`, `/v2/webhooks`,
 * `/v1/events/subscriptions` and `/v1/events/trades/subscriptions` all return
 * 404, while `/v2beta1/events/trades` opens an SSE stream and greets you with
 * `: welcome to the Alpaca events`. Alpaca's transport for trade updates is
 * server-sent events, not webhooks.
 *
 * Serverless functions cannot hold a stream open, so `scripts/alpaca-bridge.ts`
 * holds the SSE connection and POSTs each event here, signed with a shared
 * secret. That makes the bridge a piece of OUR infrastructure, not a claim that
 * Alpaca posts webhooks — and it is labelled that way in the README and on the
 * integrations page.
 *
 * What this buys, and why it is not a fudge: every event — from Persona's real
 * webhooks, from Plaid's real webhooks, from the bridge — lands in the SAME
 * idempotent pipeline with the same dedupe key and the same replay behaviour.
 * Replaying an Alpaca event through the bridge twice is still once. The
 * transport differs; the guarantees do not.
 */

import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { verifySharedSecretHmac } from '@/lib/webhooks/signatures';
import { captureHeaders, receiveWebhook } from '@/lib/webhooks/inbox';
import { recordBuyFill, recordSellFill } from '@/lib/ledger/trades';
import { postEntry, usd } from '@/lib/ledger/post';
import { formatCents, price as toPrice, units as toUnits } from '@/lib/money';
import { marketDateOf, settlementDate } from '@/lib/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AlpacaTradeEvent {
  event?: string;
  event_id?: number | string;
  account_id?: string;
  execution_id?: string;
  timestamp?: string;
  price?: string;
  qty?: string;
  order?: {
    id?: string;
    client_order_id?: string;
    symbol?: string;
    side?: 'buy' | 'sell';
    filled_qty?: string;
    filled_avg_price?: string;
    status?: string;
  };
}

const FILL_EVENTS = new Set(['fill', 'partial_fill']);
const LIFECYCLE_EVENTS = new Set([
  'new',
  'accepted',
  'canceled',
  'rejected',
  'expired',
  'done_for_day',
]);

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = captureHeaders(request.headers);

  const verification = verifySharedSecretHmac(
    rawBody,
    request.headers.get('x-ledgerly-signature'),
    request.headers.get('x-ledgerly-timestamp'),
    process.env.ALPACA_WEBHOOK_SECRET,
    'Alpaca bridge',
  );

  let parsed: AlpacaTradeEvent = {};
  try {
    parsed = JSON.parse(rawBody) as AlpacaTradeEvent;
  } catch {
    /* recorded as unparseable by the inbox */
  }

  // Alpaca's own event id. `event_ulid` is present on the status streams and
  // sorts in time order; `execution_id` is unique per fill leg and is the better
  // key on the trades stream, because one order produces many fills.
  const providerEventId =
    (parsed as { event_ulid?: string }).event_ulid ??
    parsed.execution_id ??
    (parsed.event_id !== undefined ? String(parsed.event_id) : null) ??
    `no-event-id-${Date.now()}`;

  const stream = (parsed as { _stream?: string })._stream;

  const result = await receiveWebhook({
    provider: 'alpaca',
    providerEventId,
    eventType:
      parsed.event ??
      (stream ? `${stream}.${(parsed as { status_to?: string }).status_to ?? '?'}` : 'unknown'),
    rawBody,
    headers,
    verification,
    handle: (client) =>
      stream === 'transfers'
        ? handleTransferEvent(client, parsed as unknown as AlpacaTransferEvent)
        : stream === 'accounts'
          ? handleAccountEvent(client, parsed as unknown as AlpacaAccountEvent)
          : handleTradeEvent(client, parsed),
  });

  return NextResponse.json(
    { received: true, outcome: result.outcome, detail: result.detail },
    { status: 200 },
  );
}

async function handleTradeEvent(
  client: PoolClient,
  event: AlpacaTradeEvent,
): Promise<string> {
  const kind = event.event ?? 'unknown';
  const brokerOrderId = event.order?.id ?? null;
  const clientOrderId = event.order?.client_order_id ?? null;

  if (!FILL_EVENTS.has(kind) && !LIFECYCLE_EVENTS.has(kind)) {
    return `recorded but not acted on: unhandled event type '${kind}'`;
  }

  // Match on OUR id first. client_order_id is the idempotency key we generated
  // and stored before the order left, so it is the one identifier that exists
  // on our side even if the response that carried Alpaca's id was lost.
  const { rows: orders } = await client.query<{
    id: string;
    customer_id: string;
    symbol: string;
    side: 'buy' | 'sell';
  }>(
    `SELECT id, customer_id, symbol, side FROM orders
      WHERE client_order_id = $1 OR ($2::text IS NOT NULL AND broker_order_id = $2)
      LIMIT 1`,
    [clientOrderId, brokerOrderId],
  );
  const order = orders[0];

  if (!order) {
    // Out-of-order tolerance: an event can genuinely arrive before we have
    // finished recording the order it belongs to. Recorded, visible in the
    // inbox, not lost — and not fabricated into a position either.
    return (
      `recorded but not acted on: no local order for client_order_id=` +
      `${clientOrderId ?? 'null'} broker_order_id=${brokerOrderId ?? 'null'}`
    );
  }

  if (!FILL_EVENTS.has(kind)) {
    await client.query(
      `INSERT INTO order_events (order_id, kind, broker_event_id, raw, effective_at)
       VALUES ($1::uuid, $2::order_event_kind, $3, $4::jsonb, $5)
       ON CONFLICT (broker_event_id) DO NOTHING`,
      [
        order.id,
        kind === 'new' ? 'accepted' : kind,
        event.execution_id ?? String(event.event_id ?? ''),
        JSON.stringify(event),
        event.timestamp ?? new Date().toISOString(),
      ],
    );
    return `${order.symbol} order ${kind}`;
  }

  // --- a fill: units and money both move ------------------------------------
  const fillUnits = toUnits(new Decimal(event.qty ?? event.order?.filled_qty ?? '0'));
  const fillPriceDollars = new Decimal(
    event.price ?? event.order?.filled_avg_price ?? '0',
  );
  if (fillUnits.lessThanOrEqualTo(0) || fillPriceDollars.lessThanOrEqualTo(0)) {
    return `recorded but not acted on: ${kind} with no usable qty/price`;
  }

  // Alpaca quotes prices in DOLLARS; our ledger works in cents.
  const fillPriceCents = toPrice(fillPriceDollars.times(100));
  const tradeAt = new Date(event.timestamp ?? Date.now());
  const tradeDate = marketDateOf(tradeAt);

  const posted =
    order.side === 'buy'
      ? await recordBuyFill(client, {
          customerId: order.customer_id,
          symbol: order.symbol,
          units: fillUnits,
          priceCents: fillPriceCents,
          tradeDate: tradeAt,
          orderId: order.id,
          source: 'alpaca.events',
          sourceRef: event.execution_id ?? null,
          createdBy: 'webhook:alpaca',
        })
      : await recordSellFill(client, {
          customerId: order.customer_id,
          symbol: order.symbol,
          units: fillUnits,
          priceCents: fillPriceCents,
          tradeDate: tradeAt,
          orderId: order.id,
          source: 'alpaca.events',
          sourceRef: event.execution_id ?? null,
          createdBy: 'webhook:alpaca',
        });

  await client.query(
    `INSERT INTO order_events
       (order_id, kind, fill_units, fill_price_cents, broker_event_id,
        entry_id, raw, effective_at, settlement_date)
     VALUES ($1::uuid, $2::order_event_kind, $3, $4, $5, $6::uuid, $7::jsonb, $8, $9)
     ON CONFLICT (broker_event_id) DO NOTHING`,
    [
      order.id,
      kind === 'fill' ? 'fill' : 'partial_fill',
      fillUnits.toFixed(6),
      fillPriceCents.toFixed(6),
      event.execution_id ?? String(event.event_id ?? ''),
      posted.entryId,
      JSON.stringify(event),
      tradeAt,
      settlementDate(tradeDate),
    ],
  );

  if (brokerOrderId) {
    await client.query(
      `UPDATE orders SET broker_order_id = $2 WHERE id = $1::uuid AND broker_order_id IS NULL`,
      [order.id, brokerOrderId],
    );
  }

  const realised =
    order.side === 'sell' && 'plan' in posted
      ? `, realised ${posted.plan.totalRealizedGainCents} cents`
      : '';

  return (
    `${order.side} ${fillUnits.toString()} ${order.symbol} @ ` +
    `${fillPriceDollars.toFixed(4)}, settles ${settlementDate(tradeDate)}${realised}`
  );
}

// -----------------------------------------------------------------------------
// Transfer status: a deposit becomes good funds, or bounces
// -----------------------------------------------------------------------------

interface AlpacaTransferEvent {
  transfer_id?: string;
  account_id?: string;
  status_from?: string;
  status_to?: string;
  at?: string;
  event_ulid?: string;
}

/** Alpaca transfer statuses that mean the money is really ours. */
const SETTLED_STATUSES = new Set(['COMPLETE', 'SETTLED']);

/**
 * Statuses that mean the money is NOT coming, after we already booked it as
 * pending. This is the bounced deposit, and it is the case the brief asks
 * about: what does the customer see when a deposit fails?
 */
const FAILED_STATUSES = new Set(['RETURNED', 'CANCELED', 'REJECTED', 'FAILED']);

async function handleTransferEvent(
  client: PoolClient,
  event: AlpacaTransferEvent,
): Promise<string> {
  const status = (event.status_to ?? '').toUpperCase();
  if (!event.transfer_id) return `recorded but not acted on: no transfer_id`;

  const { rows } = await client.query<{
    id: string;
    customer_id: string;
    amount_cents: bigint;
    direction: string;
  }>(
    `SELECT id, customer_id, amount_cents, direction::text AS direction
       FROM cash_transfers WHERE provider_ref = $1`,
    [event.transfer_id],
  );
  const transfer = rows[0];

  if (!transfer) {
    // Alpaca's sandbox streams carry events for accounts we did not create.
    // Recording and ignoring them is correct; inventing a transfer would not be.
    return `recorded but not acted on: transfer ${event.transfer_id} is not ours`;
  }

  // Has this transfer already reached a terminal state? Out-of-order delivery
  // is explicitly tolerated, so a late PENDING arriving after COMPLETE must not
  // undo the settlement.
  const { rows: existing } = await client.query<{ kind: string }>(
    `SELECT kind::text AS kind FROM cash_transfer_events
      WHERE transfer_id = $1::uuid AND kind IN ('settled', 'returned')`,
    [transfer.id],
  );
  if (existing.length > 0) {
    return (
      `recorded but not acted on: transfer already ${existing[0].kind}; ` +
      `a late '${status}' cannot undo a terminal state`
    );
  }

  if (SETTLED_STATUSES.has(status)) {
    const entry = await postEntry(client, {
      kind: 'deposit.settled',
      effectiveAt: new Date(event.at ?? Date.now()),
      source: 'alpaca.events',
      sourceRef: event.transfer_id,
      createdBy: 'bridge:alpaca',
      narrative:
        `ACH deposit of ${formatCents(transfer.amount_cents)} became good funds ` +
        `(${event.status_from ?? '?'} -> ${status})`,
      lines: [
        usd('assets:cash:pending_deposit', -transfer.amount_cents, {
          customerId: transfer.customer_id,
        }),
        usd('assets:cash:settled', transfer.amount_cents, {
          customerId: transfer.customer_id,
          memo: 'now investable and withdrawable',
        }),
      ],
    });

    await client.query(
      `INSERT INTO cash_transfer_events
         (transfer_id, kind, provider_event_id, entry_id, effective_at, raw)
       VALUES ($1::uuid, 'settled', $2, $3::uuid, $4, $5::jsonb)
       ON CONFLICT (provider_event_id) DO NOTHING`,
      [
        transfer.id,
        event.event_ulid ?? `settle-${event.transfer_id}`,
        entry.id,
        new Date(event.at ?? Date.now()),
        JSON.stringify(event),
      ],
    );

    return `deposit ${formatCents(transfer.amount_cents)} settled — now investable`;
  }

  if (FAILED_STATUSES.has(status)) {
    // The money is not coming. Reverse the pending deposit.
    //
    // Note what this does NOT do: it does not touch settled cash, because the
    // deposit never reached settled cash. That is the payoff for keeping
    // pending deposits in their own account — the bounce has an obvious,
    // exactly-sized thing to reverse, and no position or trade is disturbed.
    const entry = await postEntry(client, {
      kind: 'deposit.returned',
      effectiveAt: new Date(event.at ?? Date.now()),
      source: 'alpaca.events',
      sourceRef: event.transfer_id,
      createdBy: 'bridge:alpaca',
      narrative:
        `ACH deposit of ${formatCents(transfer.amount_cents)} was ${status.toLowerCase()} ` +
        `by the rail and never became good funds`,
      lines: [
        usd('assets:cash:pending_deposit', -transfer.amount_cents, {
          customerId: transfer.customer_id,
          memo: `reversed on ${status}`,
        }),
        usd('equity:external:bank', transfer.amount_cents),
      ],
    });

    await client.query(
      `INSERT INTO cash_transfer_events
         (transfer_id, kind, return_code, provider_event_id, entry_id, effective_at, raw)
       VALUES ($1::uuid, 'returned', $2, $3, $4::uuid, $5, $6::jsonb)
       ON CONFLICT (provider_event_id) DO NOTHING`,
      [
        transfer.id,
        status,
        event.event_ulid ?? `return-${event.transfer_id}`,
        entry.id,
        new Date(event.at ?? Date.now()),
        JSON.stringify(event),
      ],
    );

    return `deposit ${formatCents(transfer.amount_cents)} ${status} — pending balance reversed`;
  }

  return `recorded: transfer ${event.transfer_id} ${event.status_from ?? '?'} -> ${status}`;
}

// -----------------------------------------------------------------------------
// Account status: whether the customer may transact at the broker
// -----------------------------------------------------------------------------

interface AlpacaAccountEvent {
  account_id?: string;
  account_number?: string;
  status_from?: string;
  status_to?: string;
  account_blocked?: boolean;
  trading_blocked?: boolean;
  at?: string;
}

async function handleAccountEvent(
  client: PoolClient,
  event: AlpacaAccountEvent,
): Promise<string> {
  if (!event.account_id) return 'recorded but not acted on: no account_id';

  const { rows } = await client.query<{ id: string; legal_name: string }>(
    `SELECT id, legal_name FROM customers WHERE alpaca_account_id = $1`,
    [event.account_id],
  );
  const customer = rows[0];
  if (!customer) {
    return `recorded but not acted on: account ${event.account_id} is not ours`;
  }

  // Deliberately informational. The broker's account status is NOT our KYC
  // gate — Persona decides that, and collapsing the two would mean a change at
  // the broker could silently grant or revoke a customer's ability to transact.
  return (
    `${customer.legal_name}: broker account ${event.status_from ?? '?'} -> ` +
    `${event.status_to ?? '?'}` +
    (event.trading_blocked ? ' (trading blocked)' : '')
  );
}
