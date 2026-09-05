/**
 * Tests for FIFO lot consumption.
 *
 * The drift test is the important one. Everything else here is table stakes;
 * basis drift is the failure that survives a demo and shows up a year later on
 * a customer's 1099-B.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
  planDisposal,
  remainingCost,
  remainingUnits,
  type LotState,
} from './lots';
import { units } from '../money';

const day = (iso: string) => new Date(`${iso}T14:30:00Z`);

function lot(
  id: string,
  acquired: string,
  openedUnits: string,
  openedCost: bigint,
  consumedUnits = '0',
  consumedCost = 0n,
): LotState {
  return {
    lotId: id,
    symbol: 'VOO',
    acquiredAt: day(acquired),
    openedUnits: units(openedUnits),
    openedCost,
    consumedUnits: units(consumedUnits),
    consumedCost,
  };
}

// -----------------------------------------------------------------------------
// Ordering
// -----------------------------------------------------------------------------

test('FIFO consumes the oldest lot first', () => {
  const lots = [
    lot('newer', '2026-03-01', '10', 200000n),
    lot('older', '2026-01-01', '10', 100000n),
  ];
  // Sell 10 units for $1,500.00
  const plan = planDisposal(lots, units('10'), 150000n, day('2026-06-01'));

  assert.equal(plan.consumptions.length, 1);
  assert.equal(plan.consumptions[0].lotId, 'older', 'oldest lot must go first');
  assert.equal(plan.totalCostCents, 100000n);
  assert.equal(plan.totalRealizedGainCents, 50000n, 'gain is proceeds minus the OLD basis');
});

test('a sale spanning two lots splits across both in order', () => {
  const lots = [
    lot('a', '2026-01-01', '10', 100000n),
    lot('b', '2026-02-01', '10', 120000n),
  ];
  // Sell 15 units for $1,800.00
  const plan = planDisposal(lots, units('15'), 180000n, day('2026-06-01'));

  assert.equal(plan.consumptions.length, 2);
  assert.equal(plan.consumptions[0].lotId, 'a');
  assert.equal(plan.consumptions[0].units.toString(), '10');
  assert.equal(plan.consumptions[0].costCents, 100000n, 'lot a is exhausted, exact basis');

  assert.equal(plan.consumptions[1].lotId, 'b');
  assert.equal(plan.consumptions[1].units.toString(), '5');
  assert.equal(plan.consumptions[1].costCents, 60000n, 'half of lot b');

  assert.equal(plan.totalCostCents, 160000n);
  assert.equal(plan.totalRealizedGainCents, 20000n);
});

test('lot ordering is a parameter, so HIFO is a comparator swap not a rewrite', () => {
  const lots = [
    lot('cheap', '2026-01-01', '10', 100000n),
    lot('pricey', '2026-02-01', '10', 200000n),
  ];
  const highestCostFirst = (a: LotState, b: LotState) =>
    Number(remainingCost(b)) / Number(remainingUnits(b)) -
    Number(remainingCost(a)) / Number(remainingUnits(a));

  const plan = planDisposal(lots, units('10'), 150000n, day('2026-06-01'), highestCostFirst);

  assert.equal(plan.consumptions[0].lotId, 'pricey');
  assert.equal(plan.totalRealizedGainCents, -50000n, 'HIFO realises the loss instead');
});

// -----------------------------------------------------------------------------
// The drift test
// -----------------------------------------------------------------------------

test('a lot gives up exactly its opening basis over its lifetime, penny for penny', () => {
  // 3 units bought for $10.00. Per-unit basis is 333.333... cents, which does
  // not divide evenly. Sell one unit at a time and confirm the basis is fully
  // exhausted with nothing left over and nothing conjured.
  let state = lot('drifty', '2026-01-01', '3', 1000n);
  const basisTaken: bigint[] = [];

  for (let i = 0; i < 3; i++) {
    const plan = planDisposal([state], units('1'), 40000n, day('2026-06-01'));
    const c = plan.consumptions[0];
    basisTaken.push(c.costCents);

    state = {
      ...state,
      consumedUnits: state.consumedUnits.plus(c.units),
      consumedCost: state.consumedCost + c.costCents,
    };
  }

  // 1000 / 3 -> 333, then 667 / 2 -> 334 (half-up), then the exhausting
  // consumption takes whatever is left: 333.
  assert.deepEqual(basisTaken, [333n, 334n, 333n]);
  assert.equal(
    basisTaken.reduce((a, b) => a + b, 0n),
    1000n,
    'the lot must give up exactly what it was opened with',
  );
  assert.equal(remainingUnits(state).toString(), '0');
  assert.equal(remainingCost(state), 0n, 'a fully sold lot carries no orphan basis');
});

test('an exhausting consumption takes the remaining basis exactly, never a rounded share', () => {
  // A lot already 99% consumed, with an awkward 1 cent of basis left.
  const state = lot('nearly-gone', '2026-01-01', '3', 1000n, '2.999999', 999n);
  const plan = planDisposal([state], units('0.000001'), 50n, day('2026-06-01'));

  assert.equal(plan.consumptions[0].exhaustsLot, true);
  assert.equal(plan.consumptions[0].costCents, 1n, 'takes the last cent, not round(0.0003)');
  assert.equal(plan.totalRealizedGainCents, 49n);
});

// -----------------------------------------------------------------------------
// Proceeds allocation
// -----------------------------------------------------------------------------

test('proceeds split across lots sums to exactly the proceeds', () => {
  const lots = [
    lot('a', '2026-01-01', '1', 10000n),
    lot('b', '2026-02-01', '1', 10000n),
    lot('c', '2026-03-01', '1', 10000n),
  ];
  // $100.01 across three equal lots does not divide evenly.
  const plan = planDisposal(lots, units('3'), 10001n, day('2026-06-01'));

  assert.equal(
    plan.consumptions.reduce((s, c) => s + c.proceedsCents, 0n),
    10001n,
  );
  assert.equal(plan.totalProceedsCents, 10001n);
  // The odd cent lands on the first lot, deterministically.
  assert.deepEqual(
    plan.consumptions.map((c) => c.proceedsCents),
    [3334n, 3334n, 3333n],
  );
});

test('total realised gain always equals proceeds minus basis, with no reconciling item', () => {
  const lots = [
    lot('a', '2026-01-01', '7', 3333n),
    lot('b', '2026-02-01', '11', 7777n),
  ];
  const plan = planDisposal(lots, units('13'), 9999n, day('2026-06-01'));

  assert.equal(
    plan.totalRealizedGainCents,
    plan.totalProceedsCents - plan.totalCostCents,
    'gain must be exactly proceeds minus basis',
  );
  assert.equal(
    plan.consumptions.reduce((s, c) => s + c.realizedGainCents, 0n),
    plan.totalRealizedGainCents,
    'per-lot gains must sum to the total',
  );
});

// -----------------------------------------------------------------------------
// Holding period
// -----------------------------------------------------------------------------

test('holding period: more than one year is long-term, exactly one year is not', () => {
  const shortByADay = planDisposal(
    [lot('a', '2025-06-02', '1', 1000n)],
    units('1'),
    1500n,
    day('2026-06-01'),
  );
  assert.equal(shortByADay.consumptions[0].longTerm, false);

  const exactlyOneYear = planDisposal(
    [lot('b', '2025-06-01', '1', 1000n)],
    units('1'),
    1500n,
    day('2026-06-01'),
  );
  assert.equal(
    exactlyOneYear.consumptions[0].longTerm,
    false,
    'a holding of exactly one year is short-term under US rules',
  );

  const longTerm = planDisposal(
    [lot('c', '2025-05-31', '1', 1000n)],
    units('1'),
    1500n,
    day('2026-06-01'),
  );
  assert.equal(longTerm.consumptions[0].longTerm, true);
});

// -----------------------------------------------------------------------------
// Refusals
// -----------------------------------------------------------------------------

test('selling more units than are held is refused, not silently shorted', () => {
  const lots = [lot('a', '2026-01-01', '5', 50000n)];
  assert.throws(
    () => planDisposal(lots, units('10'), 100000n, day('2026-06-01')),
    /only 5.*held/s,
  );
});

test('fully consumed lots are skipped rather than double-sold', () => {
  const lots = [
    lot('spent', '2026-01-01', '10', 100000n, '10', 100000n),
    lot('live', '2026-02-01', '10', 120000n),
  ];
  const plan = planDisposal(lots, units('10'), 150000n, day('2026-06-01'));

  assert.equal(plan.consumptions.length, 1);
  assert.equal(plan.consumptions[0].lotId, 'live');
});

test('a zero or negative disposal is refused', () => {
  const lots = [lot('a', '2026-01-01', '5', 50000n)];
  assert.throws(() => planDisposal(lots, units('0'), 0n, day('2026-06-01')));
  assert.throws(() => planDisposal(lots, new Decimal('-1'), 0n, day('2026-06-01')));
});
