/**
 * lots.ts — tax lots, FIFO consumption, and realised gain.
 *
 * METHOD: FIFO, chosen and defended.
 *
 * FIFO is the IRS default when a taxpayer does not specify lots at the time of
 * sale, it is what a retail product ships first, and it needs no per-sale user
 * input — which matters because a rebalance generates sells the customer never
 * individually authorised. Specific-ID is strictly better for the customer's
 * tax bill, but it is a UI and instruction problem layered on exactly this lot
 * table: the engine below takes an ordered list of lots, and FIFO is only the
 * default ordering. Swapping in HIFO or specific-ID is a comparator change, not
 * a rewrite. That is the reason the ordering is a parameter.
 *
 * THE PENNY, IN TWO PLACES:
 *
 *  1. Cost basis. A partially-consumed lot allocates cost pro-rata, EXCEPT when
 *     the consumption exhausts the lot — then it takes whatever basis is left,
 *     exactly. This guarantees that over a lot's whole life the sum of the basis
 *     it gives up equals the basis it was opened with, to the cent, with no
 *     drift. Without that rule a lot can be fully sold and still carry two
 *     cents of basis forever, which is invisible until an accountant finds it.
 *
 *  2. Proceeds. Split across the consumed lots by largest-remainder on units,
 *     so the parts sum to the exact proceeds and the split is deterministic.
 *
 * Because both allocations are exact, total realised gain is exactly
 * (proceeds - basis) with no reconciling item. That is asserted, not assumed.
 */

import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { type Cents, type Units, allocate, decimalToCents, UNIT_DP } from '../money';

/** A lot as it currently stands: what it was opened with, what it has given up. */
export interface LotState {
  lotId: string;
  symbol: string;
  acquiredAt: Date;
  openedUnits: Units;
  openedCost: Cents;
  consumedUnits: Units;
  consumedCost: Cents;
}

export function remainingUnits(lot: LotState): Units {
  return lot.openedUnits.minus(lot.consumedUnits);
}

export function remainingCost(lot: LotState): Cents {
  return lot.openedCost - lot.consumedCost;
}

/** One lot's contribution to a sale. */
export interface LotConsumption {
  lotId: string;
  acquiredAt: Date;
  units: Units;
  costCents: Cents;
  proceedsCents: Cents;
  realizedGainCents: Cents;
  /** True when this consumption takes the lot's last remaining units. */
  exhaustsLot: boolean;
  /** Long-term if held more than one year, which changes the tax rate. */
  longTerm: boolean;
}

export interface DisposalPlan {
  consumptions: LotConsumption[];
  totalUnits: Units;
  totalCostCents: Cents;
  totalProceedsCents: Cents;
  totalRealizedGainCents: Cents;
}

/**
 * Default lot ordering: oldest acquisition first. Ties broken by lot id so the
 * plan is a pure function of its inputs and never depends on row order.
 */
export function fifoOrder(a: LotState, b: LotState): number {
  const byDate = a.acquiredAt.getTime() - b.acquiredAt.getTime();
  return byDate !== 0 ? byDate : a.lotId.localeCompare(b.lotId);
}

/**
 * Plan a disposal without touching the database.
 *
 * Pure, and therefore testable by hand — which is the point, because this is
 * the function that decides what a customer owes tax on.
 */
export function planDisposal(
  lots: readonly LotState[],
  unitsToSell: Units,
  proceedsCents: Cents,
  disposedAt: Date,
  order: (a: LotState, b: LotState) => number = fifoOrder,
): DisposalPlan {
  if (unitsToSell.lessThanOrEqualTo(0)) {
    throw new Error(`cannot dispose of ${unitsToSell.toFixed(UNIT_DP)} units`);
  }

  const available = [...lots]
    .filter((l) => remainingUnits(l).greaterThan(0))
    .sort(order);

  const totalAvailable = available.reduce(
    (sum, l) => sum.plus(remainingUnits(l)),
    new Decimal(0),
  );

  if (totalAvailable.lessThan(unitsToSell)) {
    throw new Error(
      `cannot sell ${unitsToSell.toFixed(UNIT_DP)} units: only ` +
        `${totalAvailable.toFixed(UNIT_DP)} held. Selling units you do not own is ` +
        `a short position, which this product does not support.`,
    );
  }

  // --- pass 1: how many units come from each lot, and at what basis ---------
  interface Draft {
    lot: LotState;
    units: Units;
    costCents: Cents;
    exhausts: boolean;
  }

  const drafts: Draft[] = [];
  let outstanding = unitsToSell;

  for (const lot of available) {
    if (outstanding.lessThanOrEqualTo(0)) break;

    const lotUnits = remainingUnits(lot);
    const lotCost = remainingCost(lot);
    const take = Decimal.min(lotUnits, outstanding);
    const exhausts = take.equals(lotUnits);

    // The rule that stops basis from drifting: an exhausting consumption takes
    // whatever basis is left, exactly. Only partial consumptions round.
    const costCents = exhausts
      ? lotCost
      : decimalToCents(new Decimal(lotCost.toString()).times(take).div(lotUnits));

    drafts.push({ lot, units: take, costCents, exhausts });
    outstanding = outstanding.minus(take);
  }

  // --- pass 2: split proceeds across those lots, exactly -------------------
  const proceedsSplit = allocate(
    proceedsCents,
    drafts.map((d) => d.units),
  );

  const oneYearBefore = new Date(disposedAt);
  oneYearBefore.setUTCFullYear(oneYearBefore.getUTCFullYear() - 1);

  const consumptions: LotConsumption[] = drafts.map((d, i) => ({
    lotId: d.lot.lotId,
    acquiredAt: d.lot.acquiredAt,
    units: d.units,
    costCents: d.costCents,
    proceedsCents: proceedsSplit[i],
    realizedGainCents: proceedsSplit[i] - d.costCents,
    exhaustsLot: d.exhausts,
    // Strictly MORE than one year. A holding of exactly one year is short-term
    // under US rules; the clock starts the day after acquisition.
    longTerm: d.lot.acquiredAt.getTime() < oneYearBefore.getTime(),
  }));

  const totalCostCents = consumptions.reduce((s, c) => s + c.costCents, 0n);
  const totalProceedsCents = consumptions.reduce((s, c) => s + c.proceedsCents, 0n);
  const totalRealizedGainCents = consumptions.reduce((s, c) => s + c.realizedGainCents, 0n);
  const totalUnits = consumptions.reduce((s, c) => s.plus(c.units), new Decimal(0));

  // These assertions are the reason this function can be trusted by the ledger.
  // If any of them can fire, the entry that follows would not balance.
  if (!totalUnits.equals(unitsToSell)) {
    throw new Error(
      `lot plan consumed ${totalUnits.toFixed(UNIT_DP)} units, expected ` +
        `${unitsToSell.toFixed(UNIT_DP)}`,
    );
  }
  if (totalProceedsCents !== proceedsCents) {
    throw new Error(
      `lot plan allocated ${totalProceedsCents} of ${proceedsCents} cents of proceeds`,
    );
  }
  if (totalRealizedGainCents !== totalProceedsCents - totalCostCents) {
    throw new Error(
      `realised gain ${totalRealizedGainCents} does not equal proceeds minus basis`,
    );
  }

  return {
    consumptions,
    totalUnits,
    totalCostCents,
    totalProceedsCents,
    totalRealizedGainCents,
  };
}

// -----------------------------------------------------------------------------
// Database access
// -----------------------------------------------------------------------------

/**
 * Load lots for a symbol with their consumption to date.
 *
 * Note both halves are append-only: `tax_lots` records what was opened and
 * `tax_lot_consumptions` records what has been given up. A lot row is never
 * updated as it is sold down, so "remaining" is always a computed fold. That is
 * what lets the tax export be reconstructed for any past date.
 */
export async function loadLots(
  client: PoolClient,
  customerId: string,
  symbol: string,
  knownAt?: Date,
): Promise<LotState[]> {
  const { rows } = await client.query<{
    id: string;
    symbol: string;
    units: string;
    cost_cents: bigint;
    acquired_at: Date;
    consumed_units: string;
    consumed_cost: bigint;
  }>(
    `SELECT l.id,
            l.symbol,
            l.units,
            l.cost_cents,
            l.acquired_at,
            coalesce(c.units, 0)      AS consumed_units,
            coalesce(c.cost_cents, 0) AS consumed_cost
       FROM tax_lots l
       LEFT JOIN LATERAL (
              SELECT sum(units)      AS units,
                     sum(cost_cents) AS cost_cents
                FROM tax_lot_consumptions tc
               WHERE tc.lot_id = l.id
                 AND tc.recorded_at <= coalesce($3::timestamptz, 'infinity')
            ) c ON true
      WHERE l.customer_id = $1::uuid
        AND l.symbol = $2
        AND l.recorded_at <= coalesce($3::timestamptz, 'infinity')
      ORDER BY l.acquired_at, l.id`,
    [customerId, symbol, knownAt ?? null],
  );

  return rows.map((r) => ({
    lotId: r.id,
    symbol: r.symbol,
    acquiredAt: r.acquired_at,
    openedUnits: new Decimal(r.units),
    openedCost: r.cost_cents,
    consumedUnits: new Decimal(r.consumed_units),
    consumedCost: r.consumed_cost,
  }));
}

export async function openLot(
  client: PoolClient,
  input: {
    customerId: string;
    symbol: string;
    units: Units;
    costCents: Cents;
    acquiredAt: Date;
    orderId?: string | null;
    entryId: string;
    replacesLotId?: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO tax_lots
       (customer_id, symbol, units, cost_cents, acquired_at, order_id, entry_id,
        replaces_lot_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.customerId,
      input.symbol,
      input.units.toFixed(UNIT_DP),
      input.costCents.toString(),
      input.acquiredAt,
      input.orderId ?? null,
      input.entryId,
      input.replacesLotId ?? null,
    ],
  );
  return rows[0].id;
}

export async function recordConsumptions(
  client: PoolClient,
  plan: DisposalPlan,
  meta: { orderId?: string | null; entryId: string; disposedAt: Date },
): Promise<void> {
  for (const c of plan.consumptions) {
    await client.query(
      `INSERT INTO tax_lot_consumptions
         (lot_id, units, cost_cents, proceeds_cents, realized_gain_cents,
          order_id, entry_id, disposed_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
      [
        c.lotId,
        c.units.toFixed(UNIT_DP),
        c.costCents.toString(),
        c.proceedsCents.toString(),
        c.realizedGainCents.toString(),
        meta.orderId ?? null,
        meta.entryId,
        meta.disposedAt,
      ],
    );
  }
}
