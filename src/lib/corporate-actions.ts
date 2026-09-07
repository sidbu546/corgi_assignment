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
import { postEntry, reverseEntry, shares } from './ledger/post';
import { loadLots, openLot, remainingCost, remainingUnits } from './ledger/lots';
import { resolvePrice } from './providers/marketdata';
import type { MarketDate } from './calendar';
import { UNIT_DP } from './money';
import { MARKET_DAY_END_SQL } from './calendar';

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

  // --- 0. one split per symbol per ex-date --------------------------------
  //
  // A company does not split twice in a day, and without this a second press
  // halves the price again and doubles the units again. Every individual split
  // would be correct and the sequence would describe something that never
  // happened — the same compounding the corrected close had before it was
  // anchored to the original close.
  const { rows: already } = await client.query<{ n: string }>(
    // A split that has been reversed no longer stands, so it must not keep
    // blocking the symbol. Both rows remain — the announcement and its
    // withdrawal — because corporate_actions is append-only.
    `SELECT count(*) AS n FROM corporate_actions ca
      WHERE ca.kind = 'split' AND ca.symbol = $1 AND ca.ex_date = $2::date
        AND ca.reverses_id IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM corporate_actions r WHERE r.reverses_id = ca.id
            )`,
    [symbol, exDate],
  );
  if (Number(already[0].n) > 0) {
    const { rows: free } = await client.query<{ symbol: string }>(
      `SELECT DISTINCT l.commodity AS symbol
         FROM journal_lines l
        WHERE l.account_code = 'assets:positions'
          AND NOT EXISTS (
                SELECT 1 FROM corporate_actions ca
                 WHERE ca.kind = 'split' AND ca.symbol = l.commodity
                   AND ca.ex_date = $1::date
                   AND ca.reverses_id IS NULL
                   AND NOT EXISTS (
                         SELECT 1 FROM corporate_actions r
                          WHERE r.reverses_id = ca.id
                       )
              )
        GROUP BY l.commodity
       HAVING sum(l.units) > 0
        ORDER BY 1`,
      [exDate],
    );
    throw new Error(
      `${symbol} has already been split with an ex-date of ${exDate}. Splitting ` +
        `it again would halve the price and double the units a second time, ` +
        `describing something that never happened.` +
        (free.length
          ? ` Still unsplit today and held by someone: ${free
              .map((f) => f.symbol)
              .join(', ')}.`
          : ' Every held symbol has already been split today.'),
    );
  }

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
        AND e.effective_at < ${MARKET_DAY_END_SQL('$2')}
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


/**
 * Withdraw a split: undo it in the ledger and record the withdrawal.
 *
 * Four things move, and all of them append rather than mutate:
 *
 *   the journal entry   reversed, so the units go back
 *   the price           a new row restoring the pre-split close
 *   the tax lots        the split's replacement lots are themselves replaced,
 *                       back to the original units and cost
 *   the announcement    a reversing corporate_actions row pointing at it
 *
 * The last one matters more than it looks. Undoing the first three while the
 * announcement stood would leave the guard refusing a symbol whose split no
 * longer exists anywhere else in the system.
 */
export async function reverseSplit(
  client: PoolClient,
  input: { symbol: string; exDate: MarketDate },
): Promise<{ symbol: string; entriesReversed: number; priceRestored: string; lotsRestored: number }> {
  const { symbol, exDate } = input;

  const { rows: actions } = await client.query<{
    id: string;
    split_numerator: number;
    split_denominator: number;
  }>(
    `SELECT ca.id, ca.split_numerator, ca.split_denominator
       FROM corporate_actions ca
      WHERE ca.kind = 'split' AND ca.symbol = $1 AND ca.ex_date = $2::date
        AND ca.reverses_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM corporate_actions r WHERE r.reverses_id = ca.id)
      ORDER BY ca.recorded_at DESC LIMIT 1`,
    [symbol, exDate],
  );
  const action = actions[0];
  if (!action) throw new Error(`no standing split in ${symbol} with ex-date ${exDate}`);

  // --- the journal entries -------------------------------------------------
  const { rows: entries } = await client.query<{ id: string }>(
    `SELECT DISTINCT e.id
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.kind = 'corporate_action.split'
        AND l.commodity = $1
        AND NOT EXISTS (
              SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id
            )
      ORDER BY e.id`,
    [symbol],
  );
  for (const entry of entries) {
    await reverseEntry(client, entry.id, {
      reason: `${action.split_numerator}-for-${action.split_denominator} split in ${symbol} withdrawn`,
      createdBy: 'system:corporate-action',
      source: 'corporate-action',
    });
  }

  // --- the price -----------------------------------------------------------
  const { rows: priceRows } = await client.query<{
    price_cents: string;
    superseded_cents: string | null;
  }>(
    `SELECT sp.price_cents,
            (SELECT p.price_cents FROM prices p WHERE p.id = sp.supersedes_id)
              AS superseded_cents
       FROM prices sp
      WHERE sp.symbol = $1 AND sp.source = 'corporate_action:split'
      ORDER BY sp.recorded_at DESC LIMIT 1`,
    [symbol],
  );
  const restore = priceRows[0]?.superseded_cents;
  if (!restore) throw new Error(`cannot find the pre-split close for ${symbol}`);

  await client.query(
    `INSERT INTO prices (symbol, price_date, price_cents, source, is_correction, note)
     VALUES ($1, $2::date, $3, 'corporate_action:split-reversal', false, $4)`,
    [
      symbol,
      exDate,
      restore,
      `Split withdrawn: close restored to ${new Decimal(restore).toFixed(6)} cents.`,
    ],
  );

  // --- the tax lots --------------------------------------------------------
  const { rows: replacements } = await client.query<{
    id: string;
    customer_id: string;
    acquired_at: Date;
    entry_id: string;
    prior_units: string;
    prior_cost: string;
  }>(
    `SELECT t.id, t.customer_id, t.acquired_at, t.entry_id,
            o.units AS prior_units, o.cost_cents::text AS prior_cost
       FROM tax_lots t
       JOIN tax_lots o ON o.id = t.replaces_lot_id
      WHERE t.symbol = $1
        AND NOT EXISTS (SELECT 1 FROM tax_lots r WHERE r.replaces_lot_id = t.id)`,
    [symbol],
  );
  for (const r of replacements) {
    await openLot(client, {
      customerId: r.customer_id,
      symbol,
      units: new Decimal(r.prior_units),
      costCents: BigInt(r.prior_cost),
      acquiredAt: r.acquired_at,
      entryId: r.entry_id,
      replacesLotId: r.id,
    });
  }

  // --- the announcement ----------------------------------------------------
  await client.query(
    `INSERT INTO corporate_actions
       (kind, symbol, declared_date, ex_date, split_numerator, split_denominator,
        source, reverses_id)
     VALUES ('split', $1, $2::date, $2::date, $3, $4, 'reversal', $5::uuid)`,
    [symbol, exDate, action.split_denominator, action.split_numerator, action.id],
  );

  return {
    symbol,
    entriesReversed: entries.length,
    priceRestored: new Decimal(restore).div(100).toFixed(4),
    lotsRestored: replacements.length,
  };
}
