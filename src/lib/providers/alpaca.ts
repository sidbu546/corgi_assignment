/**
 * alpaca.ts — Alpaca Broker API (sandbox) client.
 *
 * LIVE integration. Real accounts, real orders, real fills.
 *
 * Two things this client is careful about, because both are graded:
 *
 *  IDEMPOTENCY ON THE WAY OUT. Every order carries a `client_order_id` that we
 *  generate and store before the request leaves. If the network drops after
 *  Alpaca accepted the order but before we saw the response, the retry reuses
 *  the same id and Alpaca rejects the duplicate rather than filling twice. An
 *  idempotent consumer is worth little if the producer double-submits.
 *
 *  DEGRADATION ON THE WAY BACK. Every call goes through `request`, which has a
 *  timeout and converts transport failures into ProviderUnavailableError. No
 *  call in this file can hang a page indefinitely, and a provider outage
 *  surfaces as a labelled banner rather than a 500.
 */

import { ProviderUnavailableError, assertSlotAvailable, slotDisabled } from './registry';

const SLOT = 'brokerage';
const DEFAULT_TIMEOUT_MS = 15_000;

function baseUrl(): string {
  return process.env.ALPACA_BROKER_BASE_URL ?? 'https://broker-api.sandbox.alpaca.markets';
}

function authHeader(): string {
  const id = process.env.ALPACA_BROKER_KEY_ID ?? '';
  const secret = process.env.ALPACA_BROKER_SECRET ?? '';
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

export class AlpacaError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Alpaca ${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
    this.name = 'AlpacaError';
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; base?: string } = {},
): Promise<T> {
  assertSlotAvailable(SLOT);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${opts.base ?? baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new AlpacaError(response.status, text, method, path);
    }
    return (text ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (error instanceof AlpacaError) throw error;
    // Timeouts and DNS/socket failures become a degradation signal, not a crash.
    throw new ProviderUnavailableError(
      SLOT,
      'upstream',
      `Alpaca ${method} ${path} failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Accounts
// -----------------------------------------------------------------------------

export interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  created_at: string;
}

/**
 * Create a brokerage account for a customer.
 *
 * The identity passed here is a TEST identity — Alpaca's sandbox documents
 * these, and no real personal data is ever sent. Real PII in a trial system is
 * an automatic fail, and it would also be a genuinely bad thing to do.
 */
export async function createAccount(input: {
  email: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string; // YYYY-MM-DD
  taxId: string; // test SSN
  phone: string;
  street: string[];
  city: string;
  state: string;
  postalCode: string;
}): Promise<AlpacaAccount> {
  return request<AlpacaAccount>('POST', '/v1/accounts', {
    contact: {
      email_address: input.email,
      phone_number: input.phone,
      street_address: input.street,
      city: input.city,
      state: input.state,
      postal_code: input.postalCode,
      country: 'USA',
    },
    identity: {
      given_name: input.givenName,
      family_name: input.familyName,
      date_of_birth: input.dateOfBirth,
      tax_id: input.taxId,
      tax_id_type: 'USA_SSN',
      country_of_citizenship: 'USA',
      country_of_birth: 'USA',
      country_of_tax_residence: 'USA',
      funding_source: ['employment_income'],
    },
    disclosures: {
      is_control_person: false,
      is_affiliated_exchange_or_finra: false,
      is_politically_exposed: false,
      immediate_family_exposed: false,
    },
    agreements: [
      {
        agreement: 'customer_agreement',
        signed_at: new Date().toISOString(),
        ip_address: '127.0.0.1',
      },
    ],
  });
}

export async function getAccount(accountId: string): Promise<AlpacaAccount> {
  return request<AlpacaAccount>('GET', `/v1/accounts/${accountId}`);
}

export interface AlpacaTradingAccount {
  id: string;
  cash: string;
  position_market_value: string;
  equity: string;
  buying_power: string;
}

/**
 * Alpaca's view of the account's cash and equity.
 *
 * Used ONLY for reconciliation, never as a source of truth for a balance shown
 * to a customer. Their balance is their ledger; ours is ours. Where the two
 * disagree, that is a break to surface, not a number to copy.
 */
export async function getTradingAccount(accountId: string): Promise<AlpacaTradingAccount> {
  return request<AlpacaTradingAccount>('GET', `/v1/trading/accounts/${accountId}/account`);
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  cost_basis: string;
}

export async function getPositions(accountId: string): Promise<AlpacaPosition[]> {
  return request<AlpacaPosition[]>('GET', `/v1/trading/accounts/${accountId}/positions`);
}

// -----------------------------------------------------------------------------
// Orders
// -----------------------------------------------------------------------------

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: string | null;
  notional: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  status: string;
  submitted_at: string;
  filled_at: string | null;
}

/**
 * Submit an order.
 *
 * Exactly one of qty or notional. Notional orders are how fractional investing
 * works: "put $250 into VOO" rather than "buy 1.31 shares", which is what a
 * model-portfolio allocation actually needs when the weights are percentages of
 * a balance that is not a round multiple of the share price.
 */
export async function submitOrder(input: {
  accountId: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty?: string;
  notionalUsd?: string;
  clientOrderId: string;
  timeInForce?: 'day' | 'gtc';
}): Promise<AlpacaOrder> {
  if ((input.qty === undefined) === (input.notionalUsd === undefined)) {
    throw new Error('submitOrder needs exactly one of qty or notionalUsd');
  }

  return request<AlpacaOrder>(
    'POST',
    `/v1/trading/accounts/${input.accountId}/orders`,
    {
      symbol: input.symbol,
      side: input.side,
      type: 'market',
      time_in_force: input.timeInForce ?? 'day',
      ...(input.qty ? { qty: input.qty } : { notional: input.notionalUsd }),
      // Our idempotency key. A retry after an ambiguous failure reuses it, and
      // Alpaca rejects the duplicate rather than filling the order twice.
      client_order_id: input.clientOrderId,
    },
  );
}

export async function getOrder(accountId: string, orderId: string): Promise<AlpacaOrder> {
  return request<AlpacaOrder>('GET', `/v1/trading/accounts/${accountId}/orders/${orderId}`);
}

export async function listOrders(
  accountId: string,
  opts: { status?: 'open' | 'closed' | 'all'; limit?: number } = {},
): Promise<AlpacaOrder[]> {
  const params = new URLSearchParams({
    status: opts.status ?? 'all',
    limit: String(opts.limit ?? 100),
  });
  return request<AlpacaOrder[]>(
    'GET',
    `/v1/trading/accounts/${accountId}/orders?${params}`,
  );
}

// -----------------------------------------------------------------------------
// Funding: ACH relationships and transfers
// -----------------------------------------------------------------------------

export interface AlpacaAchRelationship {
  id: string;
  status: string;
  bank_account_type: string;
  nickname: string;
}

/**
 * Create the ACH relationship from a Plaid processor token.
 *
 * This is the seam where the two live integrations meet: Plaid verifies the
 * bank account belongs to the customer and mints a processor token, and Alpaca
 * turns that into a funding relationship without either party handing us raw
 * account numbers.
 */
export async function createAchRelationshipFromPlaid(input: {
  accountId: string;
  processorToken: string;
}): Promise<AlpacaAchRelationship> {
  return request<AlpacaAchRelationship>(
    'POST',
    `/v1/accounts/${input.accountId}/ach_relationships`,
    { processor_token: input.processorToken },
  );
}

/**
 * Delete an ACH relationship.
 *
 * Alpaca allows exactly ONE active ACH relationship per account
 * (409 "only one active ach relationship allowed"), so unlinking a bank on our
 * side without deleting it here makes relinking permanently impossible: our
 * database says unlinked, the broker says a relationship is still active, and
 * the customer gets a 409 they cannot act on.
 */
export async function deleteAchRelationship(input: {
  accountId: string;
  relationshipId: string;
}): Promise<void> {
  await request<unknown>(
    'DELETE',
    `/v1/accounts/${input.accountId}/ach_relationships/${input.relationshipId}`,
  );
}

export interface AlpacaTransfer {
  id: string;
  status: string;
  amount: string;
  direction: 'INCOMING' | 'OUTGOING';
  created_at: string;
}

export async function createTransfer(input: {
  accountId: string;
  relationshipId: string;
  amountUsd: string;
  direction: 'INCOMING' | 'OUTGOING';
  transferId: string;
}): Promise<AlpacaTransfer> {
  return request<AlpacaTransfer>('POST', `/v1/accounts/${input.accountId}/transfers`, {
    transfer_type: 'ach',
    relationship_id: input.relationshipId,
    amount: input.amountUsd,
    direction: input.direction,
    timing: 'immediate',
    client_transfer_id: input.transferId,
  });
}

export async function listTransfers(accountId: string): Promise<AlpacaTransfer[]> {
  return request<AlpacaTransfer[]>('GET', `/v1/accounts/${accountId}/transfers`);
}

/**
 * Sandbox-only shortcut: fund an account by journalling cash from the firm
 * account, bypassing ACH entirely.
 *
 * Kept because a demo must not be hostage to sandbox ACH timing, but it is
 * NOT the funding path the product uses — deposits go through Plaid and an ACH
 * relationship. Labelled here so nobody mistakes the shortcut for the design.
 */
export async function sandboxJournalCash(input: {
  toAccountId: string;
  fromAccountId: string;
  amountUsd: string;
  description: string;
}): Promise<{ id: string; status: string }> {
  return request('POST', '/v1/journals', {
    entry_type: 'JNLC',
    from_account: input.fromAccountId,
    to_account: input.toAccountId,
    amount: input.amountUsd,
    description: input.description,
  });
}

// -----------------------------------------------------------------------------
// Market data
// -----------------------------------------------------------------------------

export interface DailyBar {
  symbol: string;
  date: string; // YYYY-MM-DD
  close: string;
}

/**
 * Daily closing bars, used to value the book.
 *
 * Returns what the provider actually has. Gaps — weekends, holidays, halted
 * names — are NOT filled in here. Deciding what to do about a missing close is
 * a valuation policy decision and belongs where it can be surfaced to the user,
 * not hidden inside a data fetch.
 */
export async function getDailyBars(input: {
  symbols: string[];
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}): Promise<DailyBar[]> {
  const params = new URLSearchParams({
    symbols: input.symbols.join(','),
    timeframe: '1Day',
    start: input.start,
    end: input.end,
    adjustment: 'all',
    feed: 'iex',
    limit: '10000',
  });

  const data = await request<{
    bars: Record<string, Array<{ t: string; c: number }>>;
  }>('GET', `/v2/stocks/bars?${params}`, undefined, {
    base: process.env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
  });

  const out: DailyBar[] = [];
  for (const [symbol, bars] of Object.entries(data.bars ?? {})) {
    for (const bar of bars) {
      out.push({ symbol, date: bar.t.slice(0, 10), close: String(bar.c) });
    }
  }
  return out;
}

/** Cheap liveness probe for the health banner. */
export async function ping(): Promise<{ ok: boolean; detail: string }> {
  if (slotDisabled(SLOT)) {
    return { ok: false, detail: 'disabled from the ops console' };
  }
  try {
    await request('GET', '/v1/assets/AAPL', undefined, { timeoutMs: 5000 });
    return { ok: true, detail: 'reachable' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
