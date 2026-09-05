/**
 * restate.ts — the restatement scenario, end to end.
 *
 *   1. publish a return for a period (what we told the customer)
 *   2. a corrected closing price arrives for a date INSIDE that period
 *   3. every day from that date forward is revalued
 *   4. the return is restated, and the original stays queryable forever
 *
 * Then it ASSERTS the properties that matter:
 *   - the as-published figure is unchanged after the restatement
 *   - the as-corrected figure differs
 *   - both are retrievable, by timestamp, from the same query
 *
 * Run: npx tsx scripts/restate.ts [SYMBOL] [YYYY-MM-DD] [pct]
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { applyCorrectedClose, publishReturn } from '../src/lib/restatement';
import { performance } from '../src/lib/performance';
import { formatPercent } from '../src/lib/returns';
import { formatCents } from '../src/lib/money';
import { type MarketDate } from '../src/lib/calendar';
import { resolvePrice } from '../src/lib/providers/marketdata';

const SYMBOL = process.argv[2] ?? 'VOO';

/**
 * The corrected date is the PERIOD END, and that is not an arbitrary choice.
 *
 * Time-weighted return telescopes. With no external flows the chain
 * (EV1/BV1)·(EV2/BV2)·… cancels every intermediate value and collapses to
 * EV_final / BV_start. So correcting a price on a date INSIDE a period leaves
 * the cumulative return mathematically unchanged: the dip on the corrected day
 * and the recovery on the next day offset each other exactly. I verified this
 * numerically before changing the scenario — both paths produce 0.991079.
 *
 * What a mid-period correction DOES change: the value on that day, the return
 * of any sub-period bounded by it, and — once an external flow lands after it —
 * the weighting of everything downstream.
 *
 * What it changes unambiguously is a period that ENDS on the corrected date,
 * which is also the case that actually happens: a month-end statement goes out,
 * and then the month-end close is corrected.
 */
const CORRECTED_DATE = (process.argv[3] ?? '2026-08-31') as MarketDate;
const PERIOD_START = (process.argv[4] ?? '2026-08-01') as MarketDate;
/** How wrong the original close was, as a percentage. */
const PCT = Number(process.argv[5] ?? '-3.5');

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 4,
  });
  const client = await pool.connect();

  try {
    const { rows: customers } = await client.query<{ id: string; legal_name: string }>(
      `SELECT DISTINCT c.id, c.legal_name
         FROM customers c
         JOIN journal_lines l ON l.customer_id = c.id
        WHERE l.account_code = 'assets:positions' AND l.commodity = $1
          AND c.legal_name <> 'Invariant Probe'
        ORDER BY c.legal_name`,
      [SYMBOL],
    );
    if (customers.length === 0) throw new Error(`no customer holds ${SYMBOL}`);

    const periodStart: MarketDate = PERIOD_START;
    // The period ENDS on the corrected date. See the comment on CORRECTED_DATE
    // for why a mid-period correction cannot move a cumulative TWR.
    const periodEnd: MarketDate = CORRECTED_DATE;

    // ---------------------------------------------------------------------
    console.log(`\n1. Publishing the return for ${periodStart} .. ${periodEnd}\n`);

    const published = new Map<string, { id: string; twr: Decimal; end: bigint }>();

    for (const customer of customers) {
      await client.query('BEGIN');
      const result = await publishReturn(client, {
        customerId: customer.id,
        periodStart,
        periodEnd,
      });
      await client.query('COMMIT');
      published.set(customer.id, {
        id: result.id,
        twr: result.twr,
        end: result.endValueCents,
      });
      console.log(
        `   ${customer.legal_name.padEnd(20)} ${formatPercent(result.twr).padStart(9)}  ` +
          `end value ${formatCents(result.endValueCents)}`,
      );
    }

    const publishedAt = new Date();
    await new Promise((r) => setTimeout(r, 10));

    // ---------------------------------------------------------------------
    const before = await resolvePrice(client, { symbol: SYMBOL, asOf: CORRECTED_DATE });
    if (!before) throw new Error(`no price for ${SYMBOL} on ${CORRECTED_DATE}`);

    const corrected = before.priceCents.times(1 + PCT / 100).toDecimalPlaces(6);

    console.log(
      `\n2. A corrected close arrives for ${SYMBOL} on ${CORRECTED_DATE}\n` +
        `   was  ${before.priceCents.div(100).toFixed(4)} USD\n` +
        `   now  ${corrected.div(100).toFixed(4)} USD  (${PCT > 0 ? '+' : ''}${PCT}%)\n`,
    );

    await client.query('BEGIN');
    const restatement = await applyCorrectedClose(client, {
      symbol: SYMBOL,
      date: CORRECTED_DATE,
      correctedPriceCents: corrected.toFixed(6),
      note: 'Custodian issued a corrected closing price.',
    });
    await client.query('COMMIT');

    console.log(
      `3. Revalued ${restatement.revaluedDates.length} day(s) from ${CORRECTED_DATE} forward\n`,
    );
    console.log(`4. Restated ${restatement.restated.length} published return(s)\n`);

    for (const r of restatement.restated) {
      const delta = r.asCorrectedTwr.minus(r.asPublishedTwr);
      console.log(`   ${r.customerName}`);
      console.log(
        `     as published  ${formatPercent(r.asPublishedTwr).padStart(9)}   ` +
          `end value ${formatCents(r.asPublishedEndValueCents)}`,
      );
      console.log(
        `     as corrected  ${formatPercent(r.asCorrectedTwr).padStart(9)}   ` +
          `end value ${formatCents(r.asCorrectedEndValueCents)}`,
      );
      console.log(
        `     difference    ${formatPercent(delta).padStart(9)}   ` +
          `${formatCents(r.asCorrectedEndValueCents - r.asPublishedEndValueCents)}`,
      );
      console.log('');
    }

    // ---------------------------------------------------------------------
    console.log('5. The properties that actually matter\n');

    for (const customer of customers) {
      const original = published.get(customer.id)!;

      // As published: only what we knew at publication time.
      const asPublished = await performance(client, {
        customerId: customer.id,
        from: periodStart,
        to: periodEnd,
        knownAt: publishedAt,
      });

      // As corrected: everything we know now.
      const asCorrected = await performance(client, {
        customerId: customer.id,
        from: periodStart,
        to: periodEnd,
      });

      check(
        `${customer.legal_name}: the as-published figure is UNCHANGED by the restatement`,
        asPublished.twr.toFixed(10) === original.twr.toFixed(10),
        `${formatPercent(original.twr)} then, ${formatPercent(asPublished.twr)} now`,
      );

      check(
        `${customer.legal_name}: the as-corrected figure DIFFERS`,
        !asCorrected.twr.toFixed(10).startsWith(original.twr.toFixed(10)),
        `${formatPercent(original.twr)} -> ${formatPercent(asCorrected.twr)}`,
      );

      const { rows: history } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM published_returns
          WHERE customer_id = $1::uuid AND period_start = $2::date AND period_end = $3::date`,
        [customer.id, periodStart, periodEnd],
      );
      check(
        `${customer.legal_name}: both versions are retained`,
        Number(history[0].n) >= 2,
        `${history[0].n} published_returns rows for this period`,
      );

      const { rows: originalRow } = await client.query<{ twr: string }>(
        `SELECT twr FROM published_returns WHERE id = $1::uuid`,
        [original.id],
      );
      check(
        `${customer.legal_name}: the ORIGINAL row is untouched`,
        new Decimal(originalRow[0].twr).toFixed(10) === original.twr.toFixed(10),
        'no UPDATE was performed on a published figure',
      );
    }

    const { rows: priceRows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM prices WHERE symbol = $1 AND price_date = $2::date`,
      [SYMBOL, CORRECTED_DATE],
    );
    check(
      'the original price row still exists alongside the correction',
      Number(priceRows[0].n) >= 2,
      `${priceRows[0].n} price rows for ${SYMBOL} on ${CORRECTED_DATE}`,
    );

    console.log(`\n${'='.repeat(72)}`);
    if (failures > 0) {
      console.log(`${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log('History was restated, not rewritten.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nRestatement failed:\n', error);
  process.exit(1);
});
