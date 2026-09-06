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
 * An external flow is a movement of value across the boundary of the portfolio
 * WE MEASURE. It is not "any cash movement", and — the subtler half — the
 * boundary is drawn by what the portfolio value includes, not by what faces the
 * bank:
 *
 *   deposit SETTLING       -> in-flight becomes measured    -> EXTERNAL FLOW
 *   withdrawal             -> measured faces the bank       -> EXTERNAL FLOW
 *   deposit INITIATED      -> outside to outside            -> NOT YET A FLOW
 *   deposit bouncing       -> outside to outside            -> NEVER A FLOW
 *   dividend received      -> faces equity:external:market  -> RETURN
 *   buy / sell             -> internal reshuffling          -> NEITHER
 *   fees charged           -> internal                      -> RETURN (negative)
 *
 * That distinction falls straight out of the chart of accounts rather than
 * being a list of special cases someone has to maintain, which is why the two
 * external accounts were separated in the first place, and why in-flight cash
 * has an account of its own.
 *
 * Recognising a deposit as a flow when it is INITIATED is the trap. Portfolio
 * value excludes in-flight money, so the flow would land on a day the measured
 * value does not move — making that day read as a near-total loss and the
 * settlement day as a spectacular gain. See `netFlowByDay`.
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
// What counts as an external flow — the single definition
// -----------------------------------------------------------------------------

/**
 * The accounts whose value the portfolio figure actually MEASURES.
 *
 * This list must agree with `totalValueCents` in valuation.ts, which is
 * `settled + unsettled + positions`. Pending deposits are deliberately absent
 * from both: the money is not ours yet and can still bounce.
 */
export const MEASURED_CASH_ACCOUNTS = [
  'assets:cash:settled',
  'assets:cash:unsettled_proceeds',
] as const;

/**
 * Accounts that sit OUTSIDE the measured portfolio and whose presence on an
 * entry therefore marks that entry as crossing the boundary.
 *
 * `equity:external:bank` is the obvious one. `assets:cash:pending_deposit` is
 * the one that is easy to miss and was wrong here: in-flight money is outside
 * the measured portfolio just as surely as money still in the customer's bank,
 * so the moment it converts to settled cash, value enters the portfolio and
 * that conversion IS the external flow.
 *
 * Note what is NOT here: `equity:external:market`. A dividend is cash arriving
 * from the market, and that is return, not a flow. Keeping the bank and the
 * market as separate counterparties is what makes this a two-line rule instead
 * of a list of special cases.
 */
export const FLOW_BOUNDARY_ACCOUNTS = [
  'equity:external:bank',
  'assets:cash:pending_deposit',
] as const;

/** One USD journal line, tagged with the entry it belongs to. */
export interface BoundaryLine {
  /** YYYY-MM-DD in market time. */
  day: string;
  /** The journal entry this line belongs to. The rule is decided per ENTRY. */
  entryId: string;
  accountCode: string;
  amountCents: Cents;
  /**
   * Whether this line belongs to the customer whose return is being computed.
   *
   * House accounts carry no customer: an `equity:external:bank` line has a null
   * customer_id, so a query narrowed to one customer would never see the very
   * line that marks the entry as crossing the boundary, and every withdrawal
   * would look internal. So ALL lines of a qualifying entry are passed in, and
   * this flag decides which ones count toward the amount.
   */
  belongsToCustomer: boolean;
}

/**
 * Net external flow per day, from the lines of boundary-crossing entries.
 *
 * THE RULE, in one sentence: an external flow is the change in the MEASURED
 * accounts caused by an entry that also touches something outside them.
 *
 * Worked through the cases that matter:
 *
 *   deposit.initiated   pending +100, bank -100     measured change 0   -> no flow
 *   deposit.settled     pending -100, settled +100  measured change +100 -> FLOW +100
 *   deposit.returned    pending -100, bank +100     measured change 0   -> no flow
 *   withdrawal          settled -100, bank +100     measured change -100 -> FLOW -100
 *   buy                 settled -100, position +1u  boundary untouched  -> not a flow
 *   dividend            settled +12, market -12     boundary untouched  -> RETURN
 *
 * The first three lines are the reason this function exists. Recognising the
 * flow at INITIATION, while the value it represents is excluded from the
 * portfolio until SETTLEMENT, puts the flow on a different day from the value
 * it explains — which makes one day look like a total loss and the next like a
 * spectacular gain. It is pure arithmetic, and it is silent.
 *
 * Pure, so the rule is pinned by tests rather than asserted in a comment.
 *
 * BOTH HALVES OF THE RULE LIVE HERE — deliberately. The decision is made per
 * ENTRY: first "does this entry cross the boundary at all", then "how much did
 * the measured accounts move". An earlier version left the first half to a
 * WHERE clause and kept only the second here, which meant the SQL and the
 * function each held half a rule and neither could be tested against the other.
 * The query may still pre-filter for speed, but it can only ever hand over a
 * SUPERSET; passing it extra entries cannot change the answer.
 */
export function netFlowByDay(lines: readonly BoundaryLine[]): Map<string, Cents> {
  const measured = new Set<string>(MEASURED_CASH_ACCOUNTS);
  const boundary = new Set<string>(FLOW_BOUNDARY_ACCOUNTS);

  const byEntry = new Map<string, BoundaryLine[]>();
  for (const line of lines) {
    const existing = byEntry.get(line.entryId);
    if (existing) existing.push(line);
    else byEntry.set(line.entryId, [line]);
  }

  const byDay = new Map<string, Cents>();
  for (const entryLines of byEntry.values()) {
    // Does this entry touch anything outside the measured portfolio? If not,
    // it is internal — a buy, a sell, a fee — and moves no value across the
    // boundary however much cash it shuffles.
    if (!entryLines.some((l) => boundary.has(l.accountCode))) continue;

    for (const line of entryLines) {
      if (!line.belongsToCustomer) continue;
      if (!measured.has(line.accountCode)) continue;
      byDay.set(line.day, (byDay.get(line.day) ?? 0n) + line.amountCents);
    }
  }
  return byDay;
}
