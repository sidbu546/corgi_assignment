/**
 * valuation.ts — value the book on a date, and keep every version of that answer.
 *
 * A valuation run is a SNAPSHOT of what we believed on an as-of date at a given
 * moment. Restating a day does not edit the old run: it inserts a NEW run for
 * the same `as_of_date` with a later `recorded_at` and a `supersedes_id`
 * pointing at what it replaces. The original stays queryable forever.
 *
 * That is the whole restatement mechanism. There is no separate subsystem for
 * it — a restatement is this function called again with a later `knownAt`,
 * after a corrected price has landed.
 *
 *   as published on day T   = latest run for that date with recorded_at <= T
 *   as corrected now        = latest run for that date, full stop
 *
 * THREE THINGS THIS IS CAREFUL ABOUT:
 *
 *  Stale prices are surfaced, not smoothed. If there is no close on the as-of
 *  date, the most recent earlier close is used and its age in days is stored on
 *  the row and shown in the UI. A valuation on a stale price is still a
 *  valuation; the customer deserves to be told which one it is.
 *
 *  Market value is never stored in the ledger, only here. A price moving is not
 *  a transaction. This table is a derived snapshot and is explicitly allowed to
 *  be recomputed; the journal is not.
 *
 *  Cash is three numbers, not one, all the way through to the screen.
 */

import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { marketValueCents, type Cents } from './money';
import { resolvePrice } from './providers/marketdata';
import type { MarketDate } from './calendar';
import { MARKET_DAY_END_SQL } from './calendar';

export interface ValuationInput {
  asOf: MarketDate;
  /** Only facts recorded by this instant are used. Defaults to now. */
  knownAt?: Date;
  /** 'daily', 'restatement', 'on-demand' — shown in the UI. */
  trigger: string;
  note?: string;
  /** Set when this run replaces an earlier run for the same date. */
  supersedesId?: string | null;
  /** Limit to one customer; omit to value the whole book. */
  customerId?: string;
}

export interface CustomerValuation {
  customerId: string;
  settledCashCents: Cents;
  unsettledCashCents: Cents;
  pendingCashCents: Cents;
  positionsValueCents: Cents;
  totalValueCents: Cents;
  costBasisCents: Cents;
  positions: Array<{
    symbol: string;
    units: Decimal;
    priceCents: Decimal;
    marketValueCents: Cents;
    costCents: Cents;
    priceAgeDays: number;
    priceDate: MarketDate;
  }>;
  /** Symbols we hold but could not price at all. */
  unpriced: string[];
  /** True if any price used was older than the as-of date. */
  hasStalePrices: boolean;
}

export interface ValuationRunResult {
  runId: string;
  asOf: MarketDate;
  customers: CustomerValuation[];
  supersedesId: string | null;
}

/**
 * Value the book and persist the run.
 *
 * Idempotent in the sense that matters: calling it twice for the same date does
 * not overwrite anything. It creates a second run, and the second one wins for
 * "as corrected". That is deliberate — an accidental re-run is harmless and
 * leaves an audit trail, whereas an in-place overwrite would destroy the
 * as-published answer.
 */
export async function runValuation(
  client: PoolClient,
  input: ValuationInput,
): Promise<ValuationRunResult> {
  const knownAt = input.knownAt ?? null;

  // Positions and cash, per customer, as at the as-of date and as known at the
  // given instant. Both predicates, always — this is the whole bitemporal idea
  // applied to a read.
  const { rows: positionRows } = await client.query<{
    customer_id: string;
    commodity: string;
    units: string;
  }>(
    `SELECT l.customer_id, l.commodity, sum(l.units) AS units
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_code = 'assets:positions'
        AND e.effective_at < ${MARKET_DAY_END_SQL('$1')}
        AND e.recorded_at  <= coalesce($2::timestamptz, 'infinity')
        AND ($3::uuid IS NULL OR l.customer_id = $3::uuid)
      GROUP BY 1, 2
     HAVING sum(l.units) <> 0`,
    [input.asOf, knownAt, input.customerId ?? null],
  );

  const { rows: cashRows } = await client.query<{
    customer_id: string;
    account_code: string;
    cents: bigint;
  }>(
    `SELECT l.customer_id, l.account_code, sum(l.amount_cents)::bigint AS cents
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.commodity = 'USD'
        AND l.account_code IN ('assets:cash:settled',
                               'assets:cash:unsettled_proceeds',
                               'assets:cash:pending_deposit')
        AND e.effective_at < ${MARKET_DAY_END_SQL('$1')}
        AND e.recorded_at  <= coalesce($2::timestamptz, 'infinity')
        AND ($3::uuid IS NULL OR l.customer_id = $3::uuid)
      GROUP BY 1, 2`,
    [input.asOf, knownAt, input.customerId ?? null],
  );

  const { rows: costRows } = await client.query<{
    customer_id: string;
    related_symbol: string;
    cents: bigint;
  }>(
    `SELECT l.customer_id, l.related_symbol, sum(l.amount_cents)::bigint AS cents
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_code = 'assets:positions:cost'
        AND l.related_symbol IS NOT NULL
        AND e.effective_at < ${MARKET_DAY_END_SQL('$1')}
        AND e.recorded_at  <= coalesce($2::timestamptz, 'infinity')
        AND ($3::uuid IS NULL OR l.customer_id = $3::uuid)
      GROUP BY 1, 2`,
    [input.asOf, knownAt, input.customerId ?? null],
  );

  // --- assemble per customer -------------------------------------------------
  const customerIds = new Set<string>([
    ...positionRows.map((r) => r.customer_id),
    ...cashRows.map((r) => r.customer_id),
  ]);

  const cashByCustomer = new Map<string, Map<string, Cents>>();
  for (const row of cashRows) {
    const map = cashByCustomer.get(row.customer_id) ?? new Map();
    map.set(row.account_code, row.cents);
    cashByCustomer.set(row.customer_id, map);
  }

  const costByCustomer = new Map<string, Map<string, Cents>>();
  for (const row of costRows) {
    const map = costByCustomer.get(row.customer_id) ?? new Map();
    map.set(row.related_symbol, row.cents);
    costByCustomer.set(row.customer_id, map);
  }

  // Resolve each symbol once, not once per customer.
  const symbols = [...new Set(positionRows.map((r) => r.commodity))];
  const priceBySymbol = new Map<
    string,
    Awaited<ReturnType<typeof resolvePrice>>
  >();
  for (const symbol of symbols) {
    priceBySymbol.set(
      symbol,
      await resolvePrice(client, {
        symbol,
        asOf: input.asOf,
        knownAt: knownAt ?? undefined,
      }),
    );
  }

  const customers: CustomerValuation[] = [];

  for (const customerId of customerIds) {
    const cash = cashByCustomer.get(customerId) ?? new Map();
    const costs = costByCustomer.get(customerId) ?? new Map();

    const settled = cash.get('assets:cash:settled') ?? 0n;
    const unsettled = cash.get('assets:cash:unsettled_proceeds') ?? 0n;
    const pending = cash.get('assets:cash:pending_deposit') ?? 0n;

    const positions: CustomerValuation['positions'] = [];
    const unpriced: string[] = [];
    let positionsValue = 0n;
    let costBasis = 0n;
    let stale = false;

    for (const row of positionRows.filter((r) => r.customer_id === customerId)) {
      const units = new Decimal(row.units);
      const price = priceBySymbol.get(row.commodity);
      const cost = costs.get(row.commodity) ?? 0n;
      costBasis += cost;

      if (!price) {
        // Held but unpriceable. Contributing zero would understate the
        // portfolio and quietly lie; the symbol is reported instead.
        unpriced.push(row.commodity);
        continue;
      }
      if (price.ageDays > 0) stale = true;

      const value = marketValueCents(units, price.priceCents);
      positionsValue += value;
      positions.push({
        symbol: row.commodity,
        units,
        priceCents: price.priceCents,
        marketValueCents: value,
        costCents: cost,
        priceAgeDays: price.ageDays,
        priceDate: price.priceDate,
      });
    }

    customers.push({
      customerId,
      settledCashCents: settled,
      unsettledCashCents: unsettled,
      pendingCashCents: pending,
      positionsValueCents: positionsValue,
      // Pending deposits are NOT part of portfolio value: the money is not ours
      // yet and can still bounce. Including it would inflate the balance and,
      // worse, pollute the return when it settles.
      totalValueCents: settled + unsettled + positionsValue,
      costBasisCents: costBasis,
      positions,
      unpriced,
      hasStalePrices: stale,
    });
  }

  // --- persist ---------------------------------------------------------------
  const { rows: runRows } = await client.query<{ id: string }>(
    `INSERT INTO valuation_runs (as_of_date, trigger, note, supersedes_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.asOf, input.trigger, input.note ?? null, input.supersedesId ?? null],
  );
  const runId = runRows[0].id;

  for (const customer of customers) {
    for (const p of customer.positions) {
      const price = priceBySymbol.get(p.symbol)!;
      await client.query(
        `INSERT INTO valuation_positions
           (run_id, customer_id, symbol, units, price_id, price_cents,
            market_value_cents, cost_cents, price_age_days)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9)`,
        [
          runId,
          customer.customerId,
          p.symbol,
          p.units.toFixed(6),
          price.priceId,
          p.priceCents.toFixed(6),
          p.marketValueCents.toString(),
          p.costCents.toString(),
          p.priceAgeDays,
        ],
      );
    }

    await client.query(
      `INSERT INTO valuation_totals
         (run_id, customer_id, settled_cash_cents, unsettled_cash_cents,
          pending_cash_cents, positions_value_cents, total_value_cents,
          cost_basis_cents)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
      [
        runId,
        customer.customerId,
        customer.settledCashCents.toString(),
        customer.unsettledCashCents.toString(),
        customer.pendingCashCents.toString(),
        customer.positionsValueCents.toString(),
        customer.totalValueCents.toString(),
        customer.costBasisCents.toString(),
      ],
    );
  }

  return {
    runId,
    asOf: input.asOf,
    customers,
    supersedesId: input.supersedesId ?? null,
  };
}

/**
 * The authoritative valuation for a date — latest run, or latest as known at a
 * given instant.
 *
 * Passing `knownAt` is how the as-published figure is retrieved: the run that
 * was current when the statement went out, not the one that superseded it.
 */
export async function valuationFor(
  client: PoolClient,
  customerId: string,
  asOf: MarketDate,
  knownAt?: Date,
): Promise<{
  runId: string;
  recordedAt: Date;
  totals: {
    settled: Cents;
    unsettled: Cents;
    pending: Cents;
    positionsValue: Cents;
    totalValue: Cents;
    costBasis: Cents;
  };
} | null> {
  const { rows } = await client.query<{
    run_id: string;
    recorded_at: Date;
    settled_cash_cents: bigint;
    unsettled_cash_cents: bigint;
    pending_cash_cents: bigint;
    positions_value_cents: bigint;
    total_value_cents: bigint;
    cost_basis_cents: bigint;
  }>(
    `SELECT t.run_id, r.recorded_at, t.settled_cash_cents, t.unsettled_cash_cents,
            t.pending_cash_cents, t.positions_value_cents, t.total_value_cents,
            t.cost_basis_cents
       FROM valuation_totals t
       JOIN valuation_runs r ON r.id = t.run_id
      WHERE t.customer_id = $1::uuid
        AND r.as_of_date = $2::date
        AND r.recorded_at <= coalesce($3::timestamptz, 'infinity')
      ORDER BY r.recorded_at DESC
      LIMIT 1`,
    [customerId, asOf, knownAt ?? null],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    runId: row.run_id,
    recordedAt: row.recorded_at,
    totals: {
      settled: row.settled_cash_cents,
      unsettled: row.unsettled_cash_cents,
      pending: row.pending_cash_cents,
      positionsValue: row.positions_value_cents,
      totalValue: row.total_value_cents,
      costBasis: row.cost_basis_cents,
    },
  };
}
