/**
 * money.ts — the two dimensions, and the penny.
 *
 * This module exists so that no other file in the codebase ever has to think
 * about how to round. There are exactly two numeric dimensions in this system
 * and they have different types, so mixing them is a compile error rather than
 * a subtle production bug:
 *
 *   Cents  = bigint          integer USD minor units. Never a float. Ever.
 *   Units  = Decimal         share quantity, exact decimal, 6dp.
 *
 * A price is neither: it is a RATE (cents per unit) and is allowed sub-cent
 * precision, because $150.2345 is a real price and rounding it to the cent
 * before multiplying is how you lose money at scale.
 *
 * ROUNDING RULE, stated once and applied everywhere:
 *   Half away from zero (a.k.a. half-up for positive amounts).
 *   $1.005 -> $1.01,  -$1.005 -> -$1.01.
 *
 * Chosen over banker's rounding deliberately. Banker's rounding is better for
 * large aggregations of independent values, but it surprises customers who
 * check the arithmetic by hand, and every US brokerage statement I have ever
 * read rounds half-up. Consistency with what the customer expects beats
 * statistical elegance on a retail statement.
 *
 * THE PENNY:
 *   Any time one amount is split across several buckets, the split is done by
 *   `allocate()` using the largest-remainder method. It is deterministic (same
 *   inputs, same penny, forever) and it guarantees the parts sum to exactly the
 *   whole. Where a residual genuinely cannot be attributed to a customer, the
 *   house absorbs it into expenses:rounding. The customer never eats the penny.
 */

import Decimal from 'decimal.js';

// 28 significant digits and explicit half-up rounding, set once at module load
// so no other file can quietly change global rounding behaviour underneath us.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/** Integer USD minor units. Always a bigint, never a number, never a float. */
export type Cents = bigint;

/** Share quantity. Exact decimal, carried to 6dp. */
export type Units = Decimal;

/** Cents per single unit, exact decimal to 6dp. A rate, not an amount. */
export type PriceCents = Decimal;

export const UNIT_DP = 6;

export const ZERO_CENTS: Cents = 0n;

// -----------------------------------------------------------------------------
// Constructors and parsing
// -----------------------------------------------------------------------------

export function units(value: Decimal.Value): Units {
  return new Decimal(value).toDecimalPlaces(UNIT_DP, Decimal.ROUND_HALF_UP);
}

export function price(value: Decimal.Value): PriceCents {
  return new Decimal(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/** Parse a human dollar string ("1,234.56", "$1234.56") into exact cents. */
export function dollarsToCents(input: string | number): Cents {
  const cleaned = String(input).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`not a valid dollar amount: ${JSON.stringify(input)}`);
  }
  return decimalToCents(new Decimal(cleaned).times(100));
}

/**
 * Round an exact decimal number OF CENTS to whole cents.
 * This is the single chokepoint where sub-cent precision becomes money, and
 * therefore the single place the rounding rule is applied.
 */
export function decimalToCents(d: Decimal): Cents {
  return BigInt(d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

export function formatCents(c: Cents): string {
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const dollars = abs / 100n;
  const remainder = abs % 100n;
  const body = `${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
  return negative ? `-$${body}` : `$${body}`;
}

export function formatUnits(u: Units): string {
  // Trim trailing zeros but never show fewer than 2dp, so 10 shares reads
  // "10.00" and 0.123456 reads "0.123456".
  const fixed = u.toFixed(UNIT_DP);
  const trimmed = fixed.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '.00');
  return trimmed;
}

// -----------------------------------------------------------------------------
// The one multiplication that matters: units x price -> money
// -----------------------------------------------------------------------------

/**
 * Market value of a position. This is THE crossing point between the two
 * dimensions, and it is deliberately the only function in the codebase that
 * turns units into cents.
 *
 * Note it returns a value and never stores one. There is no `market_value`
 * column in the ledger, because a price moving is not a transaction.
 */
export function marketValueCents(u: Units, p: PriceCents): Cents {
  return decimalToCents(u.times(p));
}

/** Cost per unit for a lot. Used for split adjustments and basis reporting. */
export function costPerUnit(cost: Cents, u: Units): PriceCents {
  if (u.isZero()) throw new Error('cannot compute cost per unit of a zero-unit lot');
  return price(new Decimal(cost.toString()).div(u));
}

// -----------------------------------------------------------------------------
// The penny: deterministic allocation
// -----------------------------------------------------------------------------

/**
 * Split `total` cents across buckets in proportion to `weights`, such that the
 * parts sum to EXACTLY `total`.
 *
 * Largest-remainder method:
 *   1. give every bucket its floor share
 *   2. hand out the leftover pennies one at a time, to the buckets with the
 *      largest fractional remainder first
 *   3. ties break by lower index, so the result is a pure function of the
 *      inputs and never depends on map iteration order or wall-clock time
 *
 * This is what "pro-rata maths always leaves a penny, and someone has to eat it
 * deterministically" means in code. The penny goes to whoever was closest to
 * earning it, and the same inputs produce the same answer forever, which is
 * what makes a re-run of a closed period reproduce the identical document.
 */
export function allocate(total: Cents, weights: readonly Decimal[]): Cents[] {
  if (weights.length === 0) {
    if (total !== 0n) throw new Error('cannot allocate a non-zero total across zero buckets');
    return [];
  }
  if (weights.some((w) => w.isNegative())) {
    throw new Error('allocation weights must be non-negative');
  }

  const totalWeight = weights.reduce((a, b) => a.plus(b), new Decimal(0));
  if (totalWeight.isZero()) {
    throw new Error('allocation weights sum to zero');
  }

  const negative = total < 0n;
  const magnitude = new Decimal((negative ? -total : total).toString());

  // Floor share plus fractional remainder for each bucket.
  const exact = weights.map((w) => magnitude.times(w).div(totalWeight));
  const floors = exact.map((e) => e.floor());
  const parts = floors.map((f) => BigInt(f.toFixed(0)));

  const allocated = parts.reduce((a, b) => a + b, 0n);
  let leftover = (negative ? -total : total) - allocated;

  // Rank by fractional remainder descending, index ascending. Sorting on a
  // stable key rather than relying on Array.sort stability across engines.
  const ranked = exact
    .map((e, i) => ({ i, frac: e.minus(floors[i]) }))
    .sort((a, b) => {
      const cmp = b.frac.comparedTo(a.frac);
      return cmp !== 0 ? cmp : a.i - b.i;
    });

  for (let k = 0; leftover > 0n; k++, leftover--) {
    parts[ranked[k % ranked.length].i] += 1n;
  }

  return negative ? parts.map((p) => -p) : parts;
}

/**
 * Convenience for the common case: split evenly across n buckets.
 * $10.00 across 3 -> [334, 333, 333]. The first bucket eats the extra cent,
 * deterministically.
 */
export function allocateEvenly(total: Cents, n: number): Cents[] {
  return allocate(total, Array.from({ length: n }, () => new Decimal(1)));
}

// -----------------------------------------------------------------------------
// Guards
// -----------------------------------------------------------------------------

/**
 * Assert a set of amounts sums to zero. Used in the posting engine before an
 * entry is sent to the database, so a developer gets a clear error at the call
 * site rather than a constraint violation at COMMIT.
 */
export function assertSumsToZero(amounts: readonly Cents[], context: string): void {
  const sum = amounts.reduce((a, b) => a + b, 0n);
  if (sum !== 0n) {
    throw new Error(`${context}: amounts do not sum to zero, off by ${formatCents(sum)}`);
  }
}

export function assertUnitsSumToZero(quantities: readonly Units[], context: string): void {
  const sum = quantities.reduce((a, b) => a.plus(b), new Decimal(0));
  if (!sum.isZero()) {
    throw new Error(`${context}: units do not sum to zero, off by ${sum.toFixed(UNIT_DP)}`);
  }
}
