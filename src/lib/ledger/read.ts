/**
 * read.ts — every balance in the system, derived from journal lines.
 *
 * There is one query shape underneath all of this:
 *
 *   SELECT account, commodity, sum(cents), sum(units)
 *   FROM journal_lines JOIN journal_entries
 *   WHERE recorded_at  <= :knownAt      -- what we KNEW at a moment
 *     AND effective_at <= :asOf         -- what had HAPPENED by a date
 *   GROUP BY account, commodity
 *
 * Those two predicates are the whole bitemporal story, and they answer three
 * different questions that people casually conflate:
 *
 *   asOf = today,     knownAt = now       "what is the balance"
 *   asOf = 3 Sep,     knownAt = now       "what was the balance on 3 Sep,
 *                                          given everything we now know"
 *   asOf = 3 Sep,     knownAt = 3 Sep     "what did we BELIEVE the balance was
 *                                          on 3 Sep" — the as-published figure,
 *                                          before the late dividend and the
 *                                          corrected price arrived
 *
 * The third one is the one regulators ask about and the one that is nearly
 * impossible to answer if the model is not event-shaped. Here it is a
 * parameter.
 */

import Decimal from 'decimal.js';
import { query } from '../db';
import type { Cents, Units } from '../money';

/**
 * A bitemporal coordinate. Both default to "now", which gives the ordinary
 * current-state answer.
 */
export interface AsOf {
  /** Include only what had economically happened by this instant. */
  asOf?: Date;
  /** Include only what we had learned by this instant. */
  knownAt?: Date;
}

function bounds(a: AsOf = {}): [Date, Date] {
  const far = new Date('9999-12-31T00:00:00Z');
  return [a.asOf ?? far, a.knownAt ?? far];
}

export interface AccountBalance {
  account: string;
  commodity: string;
  cents: Cents;
  units: Units;
}

/**
 * Balances grouped by account and commodity.
 *
 * `customerId` scopes to one customer's book; omit it for the whole firm
 * including house accounts.
 */
export async function accountBalances(
  opts: AsOf & { customerId?: string; accounts?: string[] } = {},
): Promise<AccountBalance[]> {
  const [asOf, knownAt] = bounds(opts);
  const rows = await query<{
    account_code: string;
    commodity: string;
    cents: bigint | null;
    units: string | null;
  }>(
    `SELECT l.account_code,
            l.commodity,
            sum(l.amount_cents) AS cents,
            sum(l.units)        AS units
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.effective_at <= $1
        AND e.recorded_at  <= $2
        AND ($3::uuid IS NULL OR l.customer_id = $3::uuid)
        AND ($4::text[] IS NULL OR l.account_code = ANY($4::text[]))
      GROUP BY l.account_code, l.commodity
      HAVING coalesce(sum(l.amount_cents), 0) <> 0
          OR coalesce(sum(l.units), 0) <> 0
      ORDER BY l.account_code, l.commodity`,
    [asOf, knownAt, opts.customerId ?? null, opts.accounts ?? null],
  );

  return rows.map((r) => ({
    account: r.account_code,
    commodity: r.commodity,
    cents: r.cents ?? 0n,
    units: new Decimal(r.units ?? 0),
  }));
}

/** Balance of a single USD account, in cents. */
export async function usdBalance(
  account: string,
  opts: AsOf & { customerId?: string } = {},
): Promise<Cents> {
  const rows = await accountBalances({ ...opts, accounts: [account] });
  return rows.find((r) => r.commodity === 'USD')?.cents ?? 0n;
}

/**
 * The three cash buckets, and the two numbers a customer actually cares about.
 *
 * withdrawable = settled only. Withdrawing unsettled sale proceeds is
 * free-riding, and a deposit that has not cleared is not money yet.
 *
 * investable = settled + unsettled proceeds. US cash-account rules do let you
 * buy with unsettled proceeds; you just cannot take them out of the door.
 */
export interface CashPosition {
  settled: Cents;
  unsettledProceeds: Cents;
  pendingDeposits: Cents;
  withdrawable: Cents;
  investable: Cents;
}

export async function cashPosition(
  customerId: string,
  opts: AsOf = {},
): Promise<CashPosition> {
  const balances = await accountBalances({
    ...opts,
    customerId,
    accounts: [
      'assets:cash:settled',
      'assets:cash:unsettled_proceeds',
      'assets:cash:pending_deposit',
    ],
  });
  const get = (account: string) =>
    balances.find((b) => b.account === account && b.commodity === 'USD')?.cents ?? 0n;

  const settled = get('assets:cash:settled');
  const unsettledProceeds = get('assets:cash:unsettled_proceeds');
  const pendingDeposits = get('assets:cash:pending_deposit');

  return {
    settled,
    unsettledProceeds,
    pendingDeposits,
    withdrawable: settled,
    investable: settled + unsettledProceeds,
  };
}

export interface Position {
  symbol: string;
  units: Units;
  costCents: Cents;
}

/**
 * Positions in units, with cost basis.
 *
 * Note what is NOT here: market value. This function cannot tell you what a
 * position is worth, because that needs a price, and a price is a separate fact
 * with its own as-of semantics. Valuation composes the two explicitly rather
 * than smuggling a price into a position query.
 */
export async function positions(
  customerId: string,
  opts: AsOf = {},
): Promise<Position[]> {
  const [asOf, knownAt] = bounds(opts);
  // Units come from the instrument dimension of assets:positions; cost comes
  // from the USD dimension of assets:positions:cost, tied together by
  // related_symbol. Two dimensions, joined explicitly, never conflated.
  const rows = await query<{ commodity: string; units: string; cost: bigint | null }>(
    `SELECT u.commodity,
            u.units,
            c.cost
       FROM (
              SELECT l.commodity, sum(l.units) AS units
                FROM journal_lines l
                JOIN journal_entries e ON e.id = l.entry_id
               WHERE l.account_code = 'assets:positions'
                 AND l.customer_id = $3::uuid
                 AND e.effective_at <= $1
                 AND e.recorded_at  <= $2
               GROUP BY l.commodity
            ) u
       LEFT JOIN (
              SELECT l.related_symbol AS symbol,
                     sum(l.amount_cents) AS cost
                FROM journal_lines l
                JOIN journal_entries e ON e.id = l.entry_id
               WHERE l.account_code = 'assets:positions:cost'
                 AND l.customer_id = $3::uuid
                 AND l.related_symbol IS NOT NULL
                 AND e.effective_at <= $1
                 AND e.recorded_at  <= $2
               GROUP BY l.related_symbol
            ) c ON c.symbol = u.commodity
      WHERE u.units <> 0
      ORDER BY u.commodity`,
    [asOf, knownAt, customerId],
  );

  return rows.map((r) => ({
    symbol: r.commodity,
    units: new Decimal(r.units),
    costCents: r.cost ?? 0n,
  }));
}

/**
 * The trial balance: every account, every commodity, across the whole firm.
 *
 * In a correct double-entry system this sums to exactly zero for every
 * commodity, at every instant in history. That is not a nice-to-have property,
 * it is the definition of the thing working, which is why the invariants page
 * runs this over a spread of historical dates rather than only today.
 */
export interface TrialBalance {
  rows: AccountBalance[];
  totalsByCommodity: Array<{ commodity: string; cents: Cents; units: Units }>;
  balanced: boolean;
}

export async function trialBalance(opts: AsOf = {}): Promise<TrialBalance> {
  const rows = await accountBalances(opts);

  const totals = new Map<string, { cents: Cents; units: Units }>();
  for (const row of rows) {
    const current = totals.get(row.commodity) ?? { cents: 0n, units: new Decimal(0) };
    totals.set(row.commodity, {
      cents: current.cents + row.cents,
      units: current.units.plus(row.units),
    });
  }

  const totalsByCommodity = [...totals.entries()]
    .map(([commodity, t]) => ({ commodity, ...t }))
    .sort((a, b) => a.commodity.localeCompare(b.commodity));

  return {
    rows,
    totalsByCommodity,
    balanced: totalsByCommodity.every((t) => t.cents === 0n && t.units.isZero()),
  };
}

/**
 * Every line behind a number, for the drill-down.
 *
 * Any figure shown anywhere in the UI is clickable through to this. It is the
 * difference between claiming the ledger is the source of truth and being able
 * to show it on demand, mid-question.
 */
export interface JournalLineDetail {
  entryId: string;
  kind: string;
  effectiveAt: Date;
  recordedAt: Date;
  narrative: string;
  createdBy: string;
  source: string;
  account: string;
  commodity: string;
  cents: Cents | null;
  units: Units | null;
  memo: string | null;
  reversesEntryId: string | null;
  correctsEntryId: string | null;
}

export async function linesFor(
  opts: AsOf & { customerId?: string; accounts?: string[]; limit?: number } = {},
): Promise<JournalLineDetail[]> {
  const [asOf, knownAt] = bounds(opts);
  const rows = await query<Record<string, never>>(
    `SELECT e.id AS entry_id, e.kind, e.effective_at, e.recorded_at, e.narrative,
            e.created_by, e.source, e.reverses_entry_id, e.corrects_entry_id,
            l.account_code, l.commodity, l.amount_cents, l.units, l.memo
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.effective_at <= $1
        AND e.recorded_at  <= $2
        AND ($3::uuid IS NULL OR l.customer_id = $3::uuid)
        AND ($4::text[] IS NULL OR l.account_code = ANY($4::text[]))
      ORDER BY e.effective_at DESC, e.recorded_at DESC, l.id
      LIMIT $5`,
    [asOf, knownAt, opts.customerId ?? null, opts.accounts ?? null, opts.limit ?? 500],
  );

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    entryId: r.entry_id as string,
    kind: r.kind as string,
    effectiveAt: r.effective_at as Date,
    recordedAt: r.recorded_at as Date,
    narrative: r.narrative as string,
    createdBy: r.created_by as string,
    source: r.source as string,
    account: r.account_code as string,
    commodity: r.commodity as string,
    cents: (r.amount_cents as bigint | null) ?? null,
    units: r.units ? new Decimal(r.units as string) : null,
    memo: (r.memo as string | null) ?? null,
    reversesEntryId: (r.reverses_entry_id as string | null) ?? null,
    correctsEntryId: (r.corrects_entry_id as string | null) ?? null,
  }));
}
