/**
 * returns.ts — time-weighted return.
 *
 * WHY TIME-WEIGHTED, NOT MONEY-WEIGHTED.
 *
 * They answer different questions and both are legitimate:
 *
 *   TWR  "how did the PORTFOLIO perform" — neutral to the size and timing of
 *        deposits and withdrawals, because the customer does not control the
 *        market and the manager does not control the customer's savings habits.
 *   MWR  "how did THIS CUSTOMER do" — an IRR, dominated by whether they happened
 *        to deposit before a rally.
 *
 * The headline number on a retail statement is TWR. A customer who deposits
 * $10,000 on a Friday must not see their "return" leap on Monday because their
 * balance grew: a deposit is not a return. MWR is the right number for a
 * personal-outcome view and is a straightforward addition on the same flow data,
 * but it is not the figure that goes at the top of the screen.
 *
 * HOW THE FLOWS ARE IDENTIFIED — this is the part that is usually fudged.
 *
 * An external flow is a movement of cash across the boundary between the
 * customer and their BANK. It is not "any cash movement". Specifically:
 *
 *   deposit / withdrawal   -> faces equity:external:bank    -> EXTERNAL FLOW
 *   dividend received      -> faces equity:external:market  -> RETURN
 *   buy / sell             -> internal reshuffling          -> NEITHER
 *   fees charged           -> internal                      -> RETURN (negative)
 *
 * That distinction falls straight out of the chart of accounts rather than
 * being a list of special cases someone has to maintain, which is why the two
 * external accounts were separated in the first place.
 *
 * THE METHOD: daily-valued true TWR.
 *
 * For each day, with the flow treated as arriving at the START of the day:
 *
 *   r_d = (EV_d - BV_d - F_d) / (BV_d + F_d)
 *
 * and the period return chains geometrically:  TWR = product(1 + r_d) - 1.
 *
 * A deposit raises EV and the denominator by the same amount, so it contributes
 * exactly zero to r_d. That is the whole point, and it is asserted in the tests
 * rather than argued in a comment.
 */

import Decimal from 'decimal.js';
import { query } from './db';
import type { Cents } from './money';

/** One day of the return series. All money in integer cents. */
export interface DailyPoint {
  date: string; // YYYY-MM-DD
  /** Total portfolio value at the END of the previous day. */
  beginValueCents: Cents;
  /** Net external cash flow on this day. Positive = deposit. */
  externalFlowCents: Cents;
  /** Total portfolio value at the END of this day. */
  endValueCents: Cents;
}

export interface SubPeriodReturn extends DailyPoint {
  /** The day's return as an exact decimal. 0.01 = +1%. */
  returnFraction: Decimal;
  /** True when the day was skipped because there was nothing invested. */
  skipped: boolean;
}

export interface TwrResult {
  subPeriods: SubPeriodReturn[];
  /** Cumulative TWR across the whole series. 0.0734 = +7.34%. */
  twr: Decimal;
  /** Sum of external flows over the period, for the statement. */
  netFlowCents: Cents;
  beginValueCents: Cents;
  endValueCents: Cents;
}

/**
 * Compute TWR from a daily series. Pure — no database, no clock, no prices.
 *
 * Deliberately takes the series as an argument rather than fetching it, so the
 * arithmetic can be tested against hand-worked examples and so the same
 * function serves both the as-published and the as-corrected figure. A
 * restatement is the same code over a series built with a different `knownAt`.
 */
export function computeTwr(points: readonly DailyPoint[]): TwrResult {
  const subPeriods: SubPeriodReturn[] = [];
  let chain = new Decimal(1);
  let netFlowCents = 0n;

  for (const point of points) {
    netFlowCents += point.externalFlowCents;

    const denominator = point.beginValueCents + point.externalFlowCents;

    // Nothing was invested for this day: an empty account, or one whose entire
    // balance arrived and left the same day. There is no return to measure, and
    // dividing by zero would produce Infinity that then poisons the chain.
    if (denominator === 0n) {
      subPeriods.push({ ...point, returnFraction: new Decimal(0), skipped: true });
      continue;
    }

    const numerator = point.endValueCents - point.beginValueCents - point.externalFlowCents;
    const r = new Decimal(numerator.toString()).div(denominator.toString());

    subPeriods.push({ ...point, returnFraction: r, skipped: false });
    chain = chain.times(r.plus(1));
  }

  return {
    subPeriods,
    twr: chain.minus(1),
    netFlowCents,
    beginValueCents: points[0]?.beginValueCents ?? 0n,
    endValueCents: points[points.length - 1]?.endValueCents ?? 0n,
  };
}

/**
 * Annualise a TWR over a number of days, using the actual/365 convention.
 *
 * Refuses to annualise periods under a year rather than producing the
 * misleading big number that retail apps like to show. Annualising six weeks of
 * good performance into "+412% annualised" is technically defensible and
 * practically a lie.
 */
export function annualise(twr: Decimal, days: number): Decimal | null {
  if (days < 365) return null;
  return twr.plus(1).pow(new Decimal(365).div(days)).minus(1);
}

export function formatPercent(fraction: Decimal, dp = 2): string {
  const pct = fraction.times(100).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
  return `${pct.greaterThanOrEqualTo(0) ? '+' : ''}${pct.toFixed(dp)}%`;
}

// -----------------------------------------------------------------------------
// Building the series from the ledger
// -----------------------------------------------------------------------------

/**
 * Net external cash flow per day for a customer.
 *
 * Identified structurally: a USD line whose ENTRY also touches
 * equity:external:bank is a flow across the customer/bank boundary. Everything
 * else — dividends, trades, fees — is investment activity and belongs in the
 * return, not in the flows.
 *
 * `knownAt` is what makes as-published reproducible: run it with the timestamp
 * of the original statement and late-arriving corrections are excluded, exactly
 * as they were on the day.
 */
export async function externalFlowsByDay(
  customerId: string,
  from: Date,
  to: Date,
  knownAt?: Date,
): Promise<Map<string, Cents>> {
  const rows = await query<{ day: string; flow: bigint }>(
    // ::bigint because sum() over bigint yields numeric, which our parser
    // leaves as a string.
    `SELECT to_char(e.effective_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS day,
            sum(l.amount_cents)::bigint AS flow
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid
        AND l.commodity = 'USD'
        AND e.effective_at >= $2
        AND e.effective_at <  $3
        AND e.recorded_at  <= coalesce($4::timestamptz, 'infinity')
        -- the entry crosses the customer/bank boundary
        AND EXISTS (
              SELECT 1 FROM journal_lines b
               WHERE b.entry_id = e.id
                 AND b.account_code = 'equity:external:bank'
            )
      GROUP BY 1
      ORDER BY 1`,
    [customerId, from, to, knownAt ?? null],
  );

  const byDay = new Map<string, Cents>();
  for (const row of rows) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0n) + (row.flow ?? 0n));
  }
  return byDay;
}
