/**
 * brokerage.ts — one interface, two real execution venues.
 *
 * Both are LIVE Alpaca sandboxes. They differ in account model, and the
 * difference is honest and visible rather than hidden behind the abstraction:
 *
 *   BROKER API      per-customer brokerage accounts. The correct model for a
 *                   retail investing product: each customer's assets are held
 *                   in an account in their own name. Funded by ACH, which
 *                   settles on trading days.
 *
 *   TRADING PAPER   ONE account, pre-funded with $100,000, shared by every
 *                   customer routed to it. That is an OMNIBUS arrangement, and
 *                   calling it anything else would be a lie: the broker cannot
 *                   tell our customers apart, so the segregation exists only in
 *                   our ledger.
 *
 * WHY BOTH EXIST. Broker API is the right model but its sandbox settles ACH on
 * trading days, so a deposit made at a weekend cannot fund an order. The paper
 * account is pre-funded, so an order can actually reach the broker today. Every
 * order records which venue executed it, and the UI says so.
 *
 * WHAT DOES NOT CHANGE. Our ledger. Positions, tax lots, cost basis and
 * realised gain are booked identically from either venue's fills, because they
 * are OUR records of OUR customer's holdings — the venue is a counterparty
 * detail, not an accounting one. Which is exactly why reconciliation against
 * the venue matters: with an omnibus account, our ledger is the ONLY thing that
 * knows who owns what.
 */

import { assertSlotAvailable, ProviderUnavailableError } from './registry';
import * as broker from './alpaca';

export type Venue = 'broker' | 'paper';

export interface SubmittedOrder {
  venue: Venue;
  brokerOrderId: string;
  clientOrderId: string;
  status: string;
  symbol: string;
  notionalUsd: string | null;
  qty: string | null;
  filledQty: string;
  filledAvgPrice: string | null;
}

export interface VenueAccount {
  venue: Venue;
  reference: string;
  cash: string;
  buyingPower: string;
  /** True when this venue holds one account shared across customers. */
  omnibus: boolean;
}

// -----------------------------------------------------------------------------
// Trading API (paper) — a single omnibus account
// -----------------------------------------------------------------------------

function paperHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_PAPER_KEY_ID ?? '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_PAPER_SECRET ?? '',
    'Content-Type': 'application/json',
  };
}

function paperBase(): string {
  return process.env.ALPACA_PAPER_BASE_URL ?? 'https://paper-api.alpaca.markets';
}

export function paperConfigured(): boolean {
  return Boolean(process.env.ALPACA_PAPER_KEY_ID && process.env.ALPACA_PAPER_SECRET);
}

async function paperCall<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!paperConfigured()) {
    throw new ProviderUnavailableError(
      'brokerage',
      'unconfigured',
      'ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET are not set',
    );
  }
  // A live key must never reach this code path. Paper keys are prefixed PK;
  // live keys are AK. Cheap, and the consequence of getting it wrong is real
  // money.
  if (!process.env.ALPACA_PAPER_KEY_ID!.startsWith('PK')) {
    throw new Error(
      'ALPACA_PAPER_KEY_ID does not start with "PK" — refusing to use what may ' +
        'be a live-mode key.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${paperBase()}${path}`, {
      method,
      headers: paperHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Alpaca paper ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    if (error instanceof Error && error.message.startsWith('Alpaca paper')) throw error;
    throw new ProviderUnavailableError(
      'brokerage',
      'upstream',
      `Alpaca paper ${method} ${path} failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// The venue-agnostic surface
// -----------------------------------------------------------------------------

export async function getVenueAccount(
  venue: Venue,
  brokerAccountId?: string | null,
): Promise<VenueAccount> {
  if (venue === 'paper') {
    const account = await paperCall<{
      account_number: string;
      cash: string;
      buying_power: string;
    }>('GET', '/v2/account');
    return {
      venue,
      reference: account.account_number,
      cash: account.cash,
      buyingPower: account.buying_power,
      omnibus: true,
    };
  }

  if (!brokerAccountId) {
    throw new Error('broker venue requires the customer’s Alpaca account id');
  }
  assertSlotAvailable('brokerage');
  const account = await broker.getTradingAccount(brokerAccountId);
  return {
    venue,
    reference: brokerAccountId,
    cash: account.cash,
    buyingPower: account.buying_power,
    omnibus: false,
  };
}

export async function submitVenueOrder(input: {
  venue: Venue;
  brokerAccountId?: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd?: string;
  qty?: string;
  clientOrderId: string;
}): Promise<SubmittedOrder> {
  if ((input.qty === undefined) === (input.notionalUsd === undefined)) {
    throw new Error('submitVenueOrder needs exactly one of qty or notionalUsd');
  }

  if (input.venue === 'paper') {
    const order = await paperCall<{
      id: string;
      client_order_id: string;
      status: string;
      symbol: string;
      notional: string | null;
      qty: string | null;
      filled_qty: string;
      filled_avg_price: string | null;
    }>('POST', '/v2/orders', {
      symbol: input.symbol,
      side: input.side,
      type: 'market',
      time_in_force: 'day',
      ...(input.qty ? { qty: input.qty } : { notional: input.notionalUsd }),
      client_order_id: input.clientOrderId,
    });

    return {
      venue: 'paper',
      brokerOrderId: order.id,
      clientOrderId: order.client_order_id,
      status: order.status,
      symbol: order.symbol,
      notionalUsd: order.notional,
      qty: order.qty,
      filledQty: order.filled_qty,
      filledAvgPrice: order.filled_avg_price,
    };
  }

  if (!input.brokerAccountId) {
    throw new Error('broker venue requires the customer’s Alpaca account id');
  }
  const order = await broker.submitOrder({
    accountId: input.brokerAccountId,
    symbol: input.symbol,
    side: input.side,
    qty: input.qty,
    notionalUsd: input.notionalUsd,
    clientOrderId: input.clientOrderId,
  });

  return {
    venue: 'broker',
    brokerOrderId: order.id,
    clientOrderId: order.client_order_id,
    status: order.status,
    symbol: order.symbol,
    notionalUsd: order.notional,
    qty: order.qty,
    filledQty: order.filled_qty,
    filledAvgPrice: order.filled_avg_price,
  };
}

/** Alpaca's own view of whether the market is open, and when it next is. */
export async function marketClock(): Promise<{
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
}> {
  const clock = await paperCall<{
    is_open: boolean;
    next_open: string;
    next_close: string;
  }>('GET', '/v2/clock');
  return {
    isOpen: clock.is_open,
    nextOpen: clock.next_open,
    nextClose: clock.next_close,
  };
}

export async function listVenueOrders(venue: Venue, brokerAccountId?: string | null) {
  if (venue === 'paper') {
    return paperCall<
      Array<{
        id: string;
        client_order_id: string;
        symbol: string;
        side: string;
        status: string;
        notional: string | null;
        filled_qty: string;
        filled_avg_price: string | null;
        submitted_at: string;
      }>
    >('GET', '/v2/orders?status=all&limit=50');
  }
  if (!brokerAccountId) return [];
  return broker.listOrders(brokerAccountId, { status: 'all', limit: 50 });
}
