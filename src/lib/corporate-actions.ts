/**
 * corporate-actions.ts — a 2-for-1 split, and why it is the sharpest test in
 * this system.
 *
 * A split changes NOTHING economically. Twice as many units at half the price
 * is the same money. So it is the one corporate action where the right answer
 * is that every headline number stands still:
 *
 *   units          double
 *   price          halves
 *   market value   UNCHANGED
 *   cost basis     UNCHANGED in total; per-unit basis halves as an arithmetic
 *                  consequence, never as a write
 *   return         UNCHANGED, to the last basis point
 *
 * That makes it a much better test than a price move, because a model can get
 * a price move roughly right by accident. A split has to be exactly inert, and
 * there are three specific ways to fail it:
 *
 *   1. TOUCHING THE COST ACCOUNT. If the split writes anything to
 *      assets:positions:cost, total basis drifts and every future realised gain
 *      is wrong. The cost legs are absent here — not zero, absent.
 *
 *   2. FACING THE WRONG COUNTERPARTY. The new units come from the MARKET, so
 *      the entry faces equity:external:market. Facing equity:external:bank
 *      would classify it as an external flow and the return would jump — the
 *      same failure that once reported +153.80% when settling cash was counted
 *      as performance.
 *
 *   3. MUTATING TAX LOTS. tax_lots is append-only, and rightly: a lot records
 *      what was actually bought. A split closes each lot and opens a
 *      replacement with doubled units and the SAME cost, linked by
 *      replaces_lot_id. The schema anticipated this from the first migration.
 *
 * The price and the units must move in the same breath. Doubling units without
 * halving the price doubles the portfolio, which is a rather obvious bug; the
 * subtler one is halving the price a day later, which shows a 50% loss followed
 * by a 100% gain and a cumulative return that happens to be right.
 */

import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { postEntry, shares } from './ledger/post';
import { loadLots, openLot, remainingCost, remainingUnits } from './ledger/lots';
import { resolvePrice } from './providers/marketdata';
import type { MarketDate } from './calendar';
import { UNIT_DP } from './money';

export interface SplitResult {
  symbol: string;
  ratio: string;
  exDate: MarketDate;
  priceBeforeCents: string;
  priceAfterCents: string;
  customers: Array<{
    customerId: string;
    legalName: string;
    unitsBefore: string;
    unitsAfter: string;
    lotsReplaced: number;
    entryId: string;
  }>;
}

/**
 * Apply an N-for-M split. 2-for-1 is numerator 2, denominator 1.
 *
 * Everything happens in one transaction, because a split that doubled units
 * and then failed to halve the price would leave the book reporting twice the
 * money it has.
 */
export async function applySplit(
  client: PoolClient,
  input: {
    symbol: string;
    numerator: number;
    denominator: number;
    exDate: MarketDate;
    source?: string;
  },
): Promise<SplitResult> {
  const { symbol, numerator, denominator, exDate } = input;
  if (numerator <= 0 || denominator <= 0) {
    throw new Error('split ratio must be positive on both sides');
  }
  const ratio = new Decimal(numerator).div(denominator);

  // --- 1. the announcement ------------------------------------------------
  await client.query(
    `INSERT INTO corporate_actions
       (kind, symbol, declared_date, ex_date, split_numerator, split_denominator,
        source)
     VALUES ('split', $1, $2::date, $2::date, $3, $4, $5)`,
    [symbol, exDate, numerator, denominator, input.source ?? 'simulator:corporate-action'],
  );

  // --- 2. the price, halved, in the same breath ---------------------------
  const before = await resolvePrice(client, { symbol, asOf: exDate });
  if (!before) throw new Error(`no price for ${symbol} on ${exDate} to split`);

  const after = before.priceCents.div(ratio).toDecimalPlaces(6);
  const { rows: priceRows } = await client.query<{ id: string }>(
    `INSERT INTO prices
       (symbol, price_date, price_cents, source, is_correction, supersedes_id, note)
     VALUES ($1, $2::date, $3, $4, false, $5::uuid, $6)
     RETURNING id`,
    [
      symbol,
      exDate,
      after.toFixed(6),
      'corporate_action:split',
      before.priceId,
      `${numerator}-for-${denominator} split: ${before.priceCents.toFixed(6)} -> ` +
        `${after.toFixed(6)} cents per unit. Not a correction — the earlier ` +
        `price was right for the shares as they then were.`,
    ],
  );
  void priceRows;

  // --- 3. every holder's units, and their lots ----------------------------
  const { rows: holders } = await client.query<{
    customer_id: string;
    legal_name: string;
    units: string;
  }>(
    `SELECT l.customer_id, c.legal_name, sum(l.units) AS units
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN customers c ON c.id = l.customer_id
      WHERE l.account_code = 'assets:positions'
        AND l.commodity = $1
        AND e.effective_at < ($2::date + 1)
      GROUP BY l.customer_id, c.legal_name
     HAVING sum(l.units) > 0
      ORDER BY c.legal_name`,
    [symbol, exDate],
  );

  const customers: SplitResult['customers'] = [];

  for (const holder of holders) {
    const unitsBefore = new Decimal(holder.units);
    const unitsAfter = unitsBefore.times(ratio).toDecimalPlaces(UNIT_DP);
    const added = unitsAfter.minus(unitsBefore);

    // The new units come from the MARKET. Two legs, one commodity, no cash and
    // no cost line anywhere in the entry.
    const entry = await postEntry(client, {
      kind: 'corporate_action.split',
      effectiveAt: new Date(`${exDate}T12:00:00Z`),
      source: 'corporate-action',
      createdBy: 'system:corporate-action',
      narrative:
        `${numerator}-for-${denominator} split in ${symbol}. Units ` +
        `${unitsBefore.toFixed(6)} -> ${unitsAfter.toFixed(6)}, price ` +
        `${before.priceCents.toFixed(4)} -> ${after.toFixed(4)} cents. ` +
        `Cost basis untouched: the same money is now spread over more units, ` +
        `so market value and time-weighted return are unchanged.`,
      lines: [
        shares('assets:positions', symbol, added, {
          customerId: holder.customer_id,
          memo: `${numerator}-for-${denominator} split`,
        }),
        shares('equity:external:market', symbol, added.negated()),
      ],
    });

    // Lots are closed and replaced, never mutated. Same cost, doubled units,
    // same acquired_at — the holding-period clock does not restart on a split.
    const all = await loadLots(client, holder.customer_id, symbol);
    // Only lots with units left. A fully consumed lot is already closed, and
    // opening a replacement for it would resurrect a holding that was sold.
    const lots = all.filter((lot) => remainingUnits(lot).greaterThan(0));
    for (const lot of lots) {
      await openLot(client, {
        customerId: holder.customer_id,
        symbol,
        units: remainingUnits(lot).times(ratio).toDecimalPlaces(UNIT_DP),
        costCents: remainingCost(lot),
        acquiredAt: lot.acquiredAt,
        entryId: entry.id,
        replacesLotId: lot.lotId,
      });
    }

    customers.push({
      customerId: holder.customer_id,
      legalName: holder.legal_name,
      unitsBefore: unitsBefore.toFixed(6),
      unitsAfter: unitsAfter.toFixed(6),
      lotsReplaced: lots.length,
      entryId: entry.id,
    });
  }

  return {
    symbol,
    ratio: `${numerator}-for-${denominator}`,
    exDate,
    priceBeforeCents: before.priceCents.toFixed(6),
    priceAfterCents: after.toFixed(6),
    customers,
  };
}
