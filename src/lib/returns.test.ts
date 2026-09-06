/**
 * Tests for the return figure.
 *
 * "A deposit is not a return; flows must not pollute performance. This is the
 * single most common domain failure we see." So the first two tests below are
 * the ones that matter, and they are written so a stranger can check the
 * arithmetic by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
  annualise,
  computeTwr,
  formatPercent,
  netFlowByDay,
  type BoundaryLine,
  type DailyPoint,
} from './returns';

const point = (
  date: string,
  beginValueCents: bigint,
  externalFlowCents: bigint,
  endValueCents: bigint,
): DailyPoint => ({ date, beginValueCents, externalFlowCents, endValueCents });

/** Round to 10dp so exact-decimal comparisons read cleanly in assertions. */
const r = (d: Decimal) => d.toDecimalPlaces(10).toString();

// -----------------------------------------------------------------------------
// The two that matter
// -----------------------------------------------------------------------------

test('a deposit contributes exactly zero return', () => {
  // $1,000 arrives into an empty account and sits there. Value went from 0 to
  // $1,000, but the customer earned nothing.
  const result = computeTwr([point('2026-06-01', 0n, 100_000n, 100_000n)]);

  assert.equal(r(result.twr), '0');
  assert.equal(
    result.subPeriods[0].returnFraction.isZero(),
    true,
    'the day a deposit lands must show a zero return, not an infinite one',
  );
});

test('TWR is unchanged by the SIZE of a mid-period deposit', () => {
  // Identical market performance (+10% then +5%), wildly different deposits.
  // TWR must be identical, because the portfolio performed identically.
  const build = (depositCents: bigint): DailyPoint[] => {
    const afterFirstDay = 110_000n; // 100,000 grown 10%
    const begin2 = afterFirstDay + depositCents;
    return [
      point('2026-06-01', 100_000n, 0n, afterFirstDay),
      point('2026-06-02', afterFirstDay, depositCents, begin2),
      // +5% on whatever is there
      point('2026-06-03', begin2, 0n, (begin2 * 105n) / 100n),
    ];
  };

  const small = computeTwr(build(0n));
  const large = computeTwr(build(1_000_000n));

  assert.equal(r(small.twr), r(large.twr), 'deposit size must not move the return');
  // 1.10 * 1.05 - 1 = 0.155
  assert.equal(r(small.twr), '0.155');
});

// -----------------------------------------------------------------------------
// Chaining
// -----------------------------------------------------------------------------

test('sub-period returns chain geometrically, not additively', () => {
  const result = computeTwr([
    point('2026-06-01', 100_000n, 0n, 110_000n), // +10%
    point('2026-06-02', 110_000n, 0n, 121_000n), // +10%
  ]);

  // Geometric: 1.1 * 1.1 - 1 = 0.21, NOT 0.10 + 0.10 = 0.20
  assert.equal(r(result.twr), '0.21');
  assert.notEqual(r(result.twr), '0.2');
});

test('a full worked example with a deposit in the middle', () => {
  const result = computeTwr([
    point('2026-06-01', 0n, 100_000n, 100_000n), //  fund: r = 0
    point('2026-06-02', 100_000n, 0n, 110_000n), //  +10%
    point('2026-06-03', 110_000n, 110_000n, 220_000n), //  deposit: r = 0
    point('2026-06-04', 220_000n, 0n, 231_000n), //  +5%
  ]);

  assert.deepEqual(
    result.subPeriods.map((s) => r(s.returnFraction)),
    ['0', '0.1', '0', '0.05'],
  );
  assert.equal(r(result.twr), '0.155'); // 1.10 * 1.05 - 1
  assert.equal(result.netFlowCents, 210_000n);
  assert.equal(result.endValueCents, 231_000n);
});

test('withdrawals do not create a fake loss', () => {
  // Value halves purely because the customer took money out.
  const result = computeTwr([
    point('2026-06-01', 200_000n, -100_000n, 100_000n),
  ]);
  assert.equal(r(result.twr), '0', 'taking your own money out is not a loss');
});

test('a real loss is still reported as a loss', () => {
  const result = computeTwr([point('2026-06-01', 100_000n, 0n, 90_000n)]);
  assert.equal(r(result.twr), '-0.1');
  assert.equal(formatPercent(result.twr), '-10.00%');
});

test('a deposit on a day the market also moved separates the two cleanly', () => {
  // Begin $1,000, deposit $1,000, end $2,100. The extra $100 is real return on
  // the $2,000 that was invested: 5%.
  const result = computeTwr([point('2026-06-01', 100_000n, 100_000n, 210_000n)]);
  assert.equal(r(result.twr), '0.05');
});

// -----------------------------------------------------------------------------
// Degenerate days
// -----------------------------------------------------------------------------

test('an empty account produces zero, not a division by zero', () => {
  const result = computeTwr([
    point('2026-06-01', 0n, 0n, 0n),
    point('2026-06-02', 0n, 100_000n, 100_000n),
  ]);
  assert.equal(result.subPeriods[0].skipped, true);
  assert.equal(result.twr.isFinite(), true);
  assert.equal(r(result.twr), '0');
});

test('an account fully withdrawn mid-series does not poison the chain', () => {
  const result = computeTwr([
    point('2026-06-01', 100_000n, 0n, 110_000n), // +10%
    point('2026-06-02', 110_000n, -110_000n, 0n), // emptied
    point('2026-06-03', 0n, 0n, 0n), // dormant
  ]);
  assert.equal(result.twr.isFinite(), true);
  assert.equal(r(result.twr), '0.1', 'the 10% earned before the withdrawal survives');
});

test('an empty series is zero rather than an error', () => {
  const result = computeTwr([]);
  assert.equal(r(result.twr), '0');
  assert.equal(result.beginValueCents, 0n);
  assert.equal(result.endValueCents, 0n);
});

// -----------------------------------------------------------------------------
// Annualisation
// -----------------------------------------------------------------------------

test('short periods are not annualised, on purpose', () => {
  assert.equal(
    annualise(new Decimal('0.05'), 42),
    null,
    'annualising six weeks of good performance into a huge number is a lie',
  );
});

test('a period of a year or more annualises correctly', () => {
  // Exactly one year: annualised equals the raw figure.
  assert.equal(r(annualise(new Decimal('0.10'), 365)!), '0.1');
  // Two years of +21% total is +10% a year.
  const twoYear = annualise(new Decimal('0.21'), 730)!;
  assert.equal(twoYear.toDecimalPlaces(6).toString(), '0.1');
});

test('formatPercent signs positive returns explicitly', () => {
  assert.equal(formatPercent(new Decimal('0.0734')), '+7.34%');
  assert.equal(formatPercent(new Decimal('0')), '+0.00%');
  assert.equal(formatPercent(new Decimal('-0.005')), '-0.50%');
});

// -----------------------------------------------------------------------------
// Which movements are flows at all
//
// The arithmetic above was always right. What was wrong was the input: which
// ledger movements get called a flow in the first place. Every test below is a
// regression test for a real defect that reached a screen.
// -----------------------------------------------------------------------------

/**
 * One journal entry, as the flow rule sees it. Each call gets a fresh entry id,
 * because the rule is decided per entry and lines from different entries must
 * never be pooled.
 */
let entrySeq = 0;
const entry = (
  lines: Array<[string, bigint]>,
  day = '2026-06-10',
): BoundaryLine[] => {
  const entryId = `e${++entrySeq}`;
  return lines.map(([accountCode, amountCents]) => ({
    day,
    entryId,
    accountCode,
    amountCents,
    // House accounts (equity:*) carry no customer, exactly as in the ledger.
    belongsToCustomer: !accountCode.startsWith('equity:'),
  }));
};

const flowOn = (lines: BoundaryLine[], day = '2026-06-10') =>
  netFlowByDay(lines).get(day) ?? 0n;

test('a deposit becoming good funds IS the external flow', () => {
  // pending -> settled. This entry faces no bank account at all, which is
  // exactly why the old rule missed it and reported settling cash as return.
  const settling = entry([
    ['assets:cash:pending_deposit', -2_500_000n],
    ['assets:cash:settled', 2_500_000n],
  ]);
  assert.equal(flowOn(settling), 2_500_000n);
});

test('initiating a deposit is not yet a flow', () => {
  // Money left the bank but has not entered the measured portfolio: it sits in
  // pending, which portfolio value excludes. Counting it here would put the
  // flow on a different day from the value it explains.
  const initiated = entry([
    ['assets:cash:pending_deposit', 2_500_000n],
    ['equity:external:bank', -2_500_000n],
  ]);
  assert.equal(flowOn(initiated), 0n);
});

test('a deposit that bounces is never a flow, in either direction', () => {
  const initiated = entry([
    ['assets:cash:pending_deposit', 2_500_000n],
    ['equity:external:bank', -2_500_000n],
  ]);
  const bounced = entry([
    ['assets:cash:pending_deposit', -2_500_000n],
    ['equity:external:bank', 2_500_000n],
  ]);
  assert.equal(flowOn([...initiated, ...bounced]), 0n);
});

test('a withdrawal is a negative flow', () => {
  const withdrawal = entry([
    ['assets:cash:settled', -30_000n],
    ['equity:external:bank', 30_000n],
  ]);
  assert.equal(flowOn(withdrawal), -30_000n);
});

test('a dividend is return, not a flow', () => {
  // Cash genuinely arrives in settled cash — but from the market, not the
  // customer's bank. Calling this a flow would erase real performance.
  const dividend = entry([
    ['assets:cash:settled', 1_247n],
    ['equity:external:market', -1_247n],
  ]);
  assert.equal(flowOn(dividend), 0n);
});

test('a buy is not a flow even though settled cash falls', () => {
  // The SQL would never hand these lines over, since the entry touches no
  // boundary account. Asserted anyway: if the selection ever widens, the rule
  // must still refuse to call this a flow.
  const buy = entry([
    ['assets:cash:settled', -100_000n],
    ['assets:positions:cost', 100_000n],
  ]);
  assert.equal(flowOn(buy), 0n);
});

test('correcting an entry by reversal and re-book nets to no flow', () => {
  // The provenance correction: reverse a settlement, then re-book it. Cash
  // effect zero, so the return must not move either.
  const reversal = entry(
    [
      ['assets:cash:settled', -2_500_000n],
      ['assets:cash:pending_deposit', 2_500_000n],
    ],
    '2026-09-06',
  );
  const rebook = entry(
    [
      ['assets:cash:pending_deposit', -2_500_000n],
      ['assets:cash:settled', 2_500_000n],
    ],
    '2026-09-06',
  );
  assert.equal(flowOn([...reversal, ...rebook], '2026-09-06'), 0n);
});

test('flows land on the day they happened, not summed across the series', () => {
  const byDay = netFlowByDay([
    ...entry(
      [
        ['assets:cash:pending_deposit', -2_500_000n],
        ['assets:cash:settled', 2_500_000n],
      ],
      '2026-06-10',
    ),
    ...entry(
      [
        ['assets:cash:settled', -30_000n],
        ['equity:external:bank', 30_000n],
      ],
      '2026-09-06',
    ),
  ]);
  assert.equal(byDay.get('2026-06-10'), 2_500_000n);
  assert.equal(byDay.get('2026-09-06'), -30_000n);
});

test('the whole deposit lifecycle contributes exactly zero return', () => {
  // The end-to-end statement of the bug. $25,000 is deposited on day 1 and
  // settles on day 2 into an empty account, then nothing happens. Under the
  // old rule day 2 showed a +2,500,000-cent gain out of nowhere.
  const day1 = entry(
    [
      ['assets:cash:pending_deposit', 2_500_000n],
      ['equity:external:bank', -2_500_000n],
    ],
    '2026-06-10',
  );
  const day2 = entry(
    [
      ['assets:cash:pending_deposit', -2_500_000n],
      ['assets:cash:settled', 2_500_000n],
    ],
    '2026-06-11',
  );
  const byDay = netFlowByDay([...day1, ...day2]);

  const series = computeTwr([
    // Day 1: money in flight, portfolio value still zero.
    point('2026-06-10', 0n, byDay.get('2026-06-10') ?? 0n, 0n),
    // Day 2: it settles and enters the measured portfolio.
    point('2026-06-11', 0n, byDay.get('2026-06-11') ?? 0n, 2_500_000n),
  ]);

  assert.equal(r(series.twr), '0');
  assert.equal(series.netFlowCents, 2_500_000n);
});

test('a house line marks the boundary but never adds to the amount', () => {
  // The withdrawal case in full: equity:external:bank has no customer_id, so it
  // must still be visible to the rule (or the entry looks internal) while
  // contributing nothing to the flow amount.
  const withdrawal = entry([
    ['assets:cash:settled', -30_000n],
    ['equity:external:bank', 30_000n],
  ]);
  assert.equal(
    withdrawal.find((l) => l.accountCode === 'equity:external:bank')!.belongsToCustomer,
    false,
  );
  assert.equal(flowOn(withdrawal), -30_000n, 'not -30,000 + 30,000 = 0');
});

test("another customer's lines on a shared entry are not counted", () => {
  // A batched entry touching two customers. Only ours counts.
  const entryId = 'shared-1';
  const lines: BoundaryLine[] = [
    { day: '2026-06-10', entryId, accountCode: 'assets:cash:pending_deposit', amountCents: -100n, belongsToCustomer: true },
    { day: '2026-06-10', entryId, accountCode: 'assets:cash:settled', amountCents: 100n, belongsToCustomer: true },
    { day: '2026-06-10', entryId, accountCode: 'assets:cash:pending_deposit', amountCents: -900n, belongsToCustomer: false },
    { day: '2026-06-10', entryId, accountCode: 'assets:cash:settled', amountCents: 900n, belongsToCustomer: false },
  ];
  assert.equal(netFlowByDay(lines).get('2026-06-10'), 100n);
});
