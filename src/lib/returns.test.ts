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
import { annualise, computeTwr, formatPercent, type DailyPoint } from './returns';

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
