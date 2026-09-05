/**
 * value-history.ts — run the daily valuation across the whole history.
 *
 * In production this is a nightly job valuing one day. Here it backfills every
 * calendar day since the book opened, which is what gives the return figure a
 * real series to chain rather than two endpoints and a guess.
 *
 * Valuation runs on CALENDAR days, not trading days, on purpose: a customer's
 * balance exists at the weekend, and a statement dated Saturday has to say
 * something. Weekends carry the previous close forward, and the price's age in
 * days is stored on the row so the staleness is visible rather than implied.
 *
 * Run: npm run value            (backfill everything missing)
 *      npm run value -- --force (re-run every day, creating superseding runs)
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import { runValuation } from '../src/lib/valuation';
import { calendarDaysBetween, marketDateOf, type MarketDate } from '../src/lib/calendar';
import { formatCents } from '../src/lib/money';

async function main() {
  const force = process.argv.includes('--force');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 4,
  });
  const client = await pool.connect();

  try {
    // Start from the first day anything economically happened.
    const { rows: bounds } = await client.query<{ first: string | null }>(
      `SELECT to_char(min(effective_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS first
         FROM journal_entries`,
    );
    const first = bounds[0]?.first;
    if (!first) {
      console.log('No journal entries. Run `npm run seed -- --reset` first.');
      return;
    }

    const today = marketDateOf(new Date());
    const days = calendarDaysBetween(first as MarketDate, today);

    const { rows: existing } = await client.query<{ d: string }>(
      `SELECT DISTINCT to_char(as_of_date, 'YYYY-MM-DD') AS d FROM valuation_runs`,
    );
    const already = new Set(existing.map((r) => r.d));

    console.log(
      `Valuing ${days.length} days from ${first} to ${today}` +
        (force ? ' (--force: re-running all)' : ` (${already.size} already done)`),
    );

    let ran = 0;
    let lastTotals = '';

    for (const day of days) {
      if (!force && already.has(day)) continue;

      await client.query('BEGIN');
      const result = await runValuation(client, {
        asOf: day,
        trigger: force ? 'backfill.force' : 'backfill',
      });
      await client.query('COMMIT');
      ran++;

      const total = result.customers.reduce((s, c) => s + c.totalValueCents, 0n);
      const stale = result.customers.some((c) => c.hasStalePrices);
      const unpriced = result.customers.flatMap((c) => c.unpriced);
      lastTotals = formatCents(total);

      if (ran % 10 === 0 || stale || unpriced.length > 0) {
        console.log(
          `  ${day}  book ${formatCents(total).padStart(14)}` +
            (stale ? '  [stale price carried forward]' : '') +
            (unpriced.length ? `  [unpriced: ${[...new Set(unpriced)].join(',')}]` : ''),
        );
      }
    }

    console.log(`\nCreated ${ran} valuation run(s). Latest book value ${lastTotals}.`);

    const { rows: summary } = await client.query<{
      runs: string;
      positions: string;
      stale: string;
    }>(
      `SELECT (SELECT count(*) FROM valuation_runs)      AS runs,
              (SELECT count(*) FROM valuation_positions) AS positions,
              (SELECT count(*) FROM valuation_positions WHERE price_age_days > 0) AS stale`,
    );
    console.log(
      `Total: ${summary[0].runs} runs, ${summary[0].positions} position rows, ` +
        `${summary[0].stale} valued on a carried-forward price.`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nValuation backfill failed:\n', error);
  process.exit(1);
});
