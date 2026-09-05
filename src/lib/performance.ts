/**
 * performance.ts — build the daily series and chain it into a return.
 *
 * This is where valuation (what the book was worth each day) meets the ledger
 * (what money crossed the customer/bank boundary each day), and the two produce
 * a time-weighted return.
 *
 * The important line in this file is the flow query's join condition: a flow is
 * a USD movement on an entry that ALSO touches `equity:external:bank`. Not "any
 * cash movement" — a dividend is cash arriving and it is emphatically return,
 * not a flow. Getting that predicate wrong is the single most common way a
 * return figure ends up wrong, and it is why the chart of accounts separates
 * the bank counterparty from the market counterparty.
 *
 * `knownAt` threads through everything, so the same function produces the
 * as-published figure and the as-corrected one. A restatement is not a
 * different code path; it is a different timestamp.
 */

import type { PoolClient } from 'pg';
import { computeTwr, type DailyPoint, type TwrResult } from './returns';
import { calendarDaysBetween, type MarketDate } from './calendar';
import type { Cents } from './money';

export interface PerformanceInput {
  customerId: string;
  from: MarketDate;
  to: MarketDate;
  /** Only facts recorded by this instant. Omit for "as corrected now". */
  knownAt?: Date;
}

export interface PerformanceResult extends TwrResult {
  from: MarketDate;
  to: MarketDate;
  knownAt: Date | null;
  /** Days we had no valuation for, so the caller can say so rather than guess. */
  missingValuationDays: MarketDate[];
}

export async function performance(
  client: PoolClient,
  input: PerformanceInput,
): Promise<PerformanceResult> {
  const knownAt = input.knownAt ?? null;

  // --- daily book value, as known at the given instant ----------------------
  // DISTINCT ON picks the latest run per as-of date, which is what makes a
  // restatement take effect: the superseding run has a later recorded_at and
  // wins, while an as-published query with an earlier knownAt still sees the
  // original.
  const { rows: valuations } = await client.query<{
    d: MarketDate;
    total: bigint;
  }>(
    `SELECT DISTINCT ON (r.as_of_date)
            to_char(r.as_of_date, 'YYYY-MM-DD') AS d,
            t.total_value_cents AS total
       FROM valuation_totals t
       JOIN valuation_runs r ON r.id = t.run_id
      WHERE t.customer_id = $1::uuid
        AND r.as_of_date BETWEEN $2::date AND $3::date
        AND r.recorded_at <= coalesce($4::timestamptz, 'infinity')
      ORDER BY r.as_of_date, r.recorded_at DESC`,
    [input.customerId, input.from, input.to, knownAt],
  );

  const valueByDay = new Map<MarketDate, Cents>();
  for (const row of valuations) valueByDay.set(row.d, row.total);

  // --- external flows: money across the customer/bank boundary --------------
  const { rows: flows } = await client.query<{ d: MarketDate; flow: bigint }>(
    `SELECT to_char(e.effective_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d,
            sum(l.amount_cents)::bigint AS flow
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid
        AND l.commodity = 'USD'
        AND e.effective_at >= $2::date
        AND e.effective_at <  ($3::date + 1)
        AND e.recorded_at  <= coalesce($4::timestamptz, 'infinity')
        -- Only settled money counts as a flow. A deposit still in flight has
        -- not entered the portfolio, and it is excluded from portfolio value
        -- too, so both sides of the return stay consistent.
        AND l.account_code = 'assets:cash:settled'
        AND EXISTS (
              SELECT 1 FROM journal_lines b
               WHERE b.entry_id = e.id
                 AND b.account_code = 'equity:external:bank'
            )
      GROUP BY 1`,
    [input.customerId, input.from, input.to, knownAt],
  );

  const flowByDay = new Map<MarketDate, Cents>();
  for (const row of flows) flowByDay.set(row.d, row.flow ?? 0n);

  // --- assemble the series --------------------------------------------------
  const days = calendarDaysBetween(input.from, input.to);
  const points: DailyPoint[] = [];
  const missing: MarketDate[] = [];

  // The day before the window opens is the first day's opening value. Without
  // it, day one would look like a 100% gain from nothing.
  let previousValue: Cents = 0n;
  const dayBefore = calendarDaysBetween(input.from, input.from)[0];
  if (dayBefore) {
    const { rows: prior } = await client.query<{ total: bigint }>(
      `SELECT DISTINCT ON (r.as_of_date) t.total_value_cents AS total
         FROM valuation_totals t
         JOIN valuation_runs r ON r.id = t.run_id
        WHERE t.customer_id = $1::uuid
          AND r.as_of_date < $2::date
          AND r.recorded_at <= coalesce($3::timestamptz, 'infinity')
        ORDER BY r.as_of_date DESC, r.recorded_at DESC
        LIMIT 1`,
      [input.customerId, input.from, knownAt],
    );
    previousValue = prior[0]?.total ?? 0n;
  }

  for (const day of days) {
    const endValue = valueByDay.get(day);
    if (endValue === undefined) {
      // No valuation for this day. Carrying the previous value forward would
      // silently invent a flat day; recording it as missing lets the UI say so.
      missing.push(day);
      continue;
    }
    points.push({
      date: day,
      beginValueCents: previousValue,
      externalFlowCents: flowByDay.get(day) ?? 0n,
      endValueCents: endValue,
    });
    previousValue = endValue;
  }

  return {
    ...computeTwr(points),
    from: input.from,
    to: input.to,
    knownAt,
    missingValuationDays: missing,
  };
}

/** Convenience: since the customer's first ledger entry, to today. */
export async function inceptionToDate(
  client: PoolClient,
  customerId: string,
  to: MarketDate,
  knownAt?: Date,
): Promise<PerformanceResult | null> {
  const { rows } = await client.query<{ first: MarketDate | null }>(
    `SELECT to_char(min(e.effective_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS first
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid
        AND e.recorded_at <= coalesce($2::timestamptz, 'infinity')`,
    [customerId, knownAt ?? null],
  );
  const first = rows[0]?.first;
  if (!first) return null;

  return performance(client, { customerId, from: first, to, knownAt });
}
