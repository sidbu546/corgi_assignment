/**
 * split-test.ts — run a 2-for-1 split and assert that nothing economic moved.
 *
 * The whole test in one line: units double, price halves, and every figure that
 * represents MONEY stands still. If the return moves on a split, the model is
 * wrong, and a model can only be shown to be right by measuring before and
 * after rather than by reasoning about it.
 *
 * Runs inside a transaction that is ROLLED BACK by default, so it can be run
 * against the live demo database without changing it. Pass --commit to keep it.
 *
 *   npx tsx scripts/split-test.ts [SYMBOL]
 *   npx tsx scripts/split-test.ts VOO --commit
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { applySplit } from '../src/lib/corporate-actions';
import { runValuation } from '../src/lib/valuation';
import { inceptionToDate } from '../src/lib/performance';
import { formatPercent } from '../src/lib/returns';
import { formatCents } from '../src/lib/money';
import { marketDateOf } from '../src/lib/calendar';
import { loadLots, remainingCost, remainingUnits } from '../src/lib/ledger/lots';

const SYMBOL = (process.argv[2] ?? 'VOO').toUpperCase();
const COMMIT = process.argv.includes('--commit');

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  if (!ok) failures++;
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

interface Snapshot {
  units: Decimal;
  positionsValue: bigint;
  costBasis: bigint;
  total: bigint;
  twr: Decimal;
  lotUnits: Decimal;
  lotCost: bigint;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });
  const client = await pool.connect();
  const today = marketDateOf(new Date());

  const snapshot = async (customerId: string): Promise<Snapshot> => {
    const valuation = await runValuation(client, {
      asOf: today,
      trigger: 'split.test',
      customerId,
    });
    const mine = valuation.customers.find((c) => c.customerId === customerId)!;
    const position = mine.positions.find((p) => p.symbol === SYMBOL);
    const perf = await inceptionToDate(client, customerId, today);
    const lots = (await loadLots(client, customerId, SYMBOL)).filter((l) =>
      remainingUnits(l).greaterThan(0),
    );
    return {
      units: position?.units ?? new Decimal(0),
      positionsValue: position?.marketValueCents ?? 0n,
      costBasis: position?.costCents ?? 0n,
      total: mine.totalValueCents,
      twr: perf?.twr ?? new Decimal(0),
      lotUnits: lots.reduce((a, l) => a.plus(remainingUnits(l)), new Decimal(0)),
      lotCost: lots.reduce((a, l) => a + remainingCost(l), 0n),
    };
  };

  try {
    await client.query('BEGIN');

    const { rows: holders } = await client.query<{ id: string; legal_name: string }>(
      `SELECT DISTINCT l.customer_id AS id, c.legal_name
         FROM journal_lines l
         JOIN customers c ON c.id = l.customer_id
        WHERE l.account_code = 'assets:positions' AND l.commodity = $1
        GROUP BY l.customer_id, c.legal_name
       HAVING sum(l.units) > 0
        ORDER BY c.legal_name`,
      [SYMBOL],
    );
    if (holders.length === 0) {
      console.log(`\nNobody holds ${SYMBOL}. Nothing to split.\n`);
      return;
    }

    console.log(`\n2-for-1 split in ${SYMBOL}, ex ${today}`);
    console.log(`${holders.length} holder(s)${COMMIT ? '' : '  [dry run — rolled back]'}\n`);

    const before = new Map<string, Snapshot>();
    for (const h of holders) before.set(h.id, await snapshot(h.id));

    const result = await applySplit(client, {
      symbol: SYMBOL,
      numerator: 2,
      denominator: 1,
      exDate: today,
    });

    console.log(
      `price ${new Decimal(result.priceBeforeCents).div(100).toFixed(4)} -> ` +
        `${new Decimal(result.priceAfterCents).div(100).toFixed(4)}\n`,
    );

    for (const h of holders) {
      const b = before.get(h.id)!;
      const a = await snapshot(h.id);
      console.log(`${h.legal_name}`);
      console.log(
        `  units        ${b.units.toFixed(6)} -> ${a.units.toFixed(6)}\n` +
          `  value        ${formatCents(b.positionsValue)} -> ${formatCents(a.positionsValue)}\n` +
          `  cost basis   ${formatCents(b.costBasis)} -> ${formatCents(a.costBasis)}\n` +
          `  portfolio    ${formatCents(b.total)} -> ${formatCents(a.total)}\n` +
          `  TWR          ${formatPercent(b.twr)} -> ${formatPercent(a.twr)}\n`,
      );

      check(
        a.units.equals(b.units.times(2)),
        'units doubled',
        `${b.units.toFixed(6)} x 2 = ${a.units.toFixed(6)}`,
      );
      check(
        a.positionsValue === b.positionsValue,
        'market value UNCHANGED',
        `${formatCents(b.positionsValue)} either side`,
      );
      check(
        a.costBasis === b.costBasis,
        'total cost basis UNCHANGED',
        `${formatCents(b.costBasis)} either side — per-unit basis halves as a consequence`,
      );
      check(a.total === b.total, 'portfolio value UNCHANGED', formatCents(a.total));
      check(
        a.twr.toFixed(12) === b.twr.toFixed(12),
        'time-weighted return UNCHANGED to 12dp',
        `${b.twr.toFixed(12)} either side`,
      );
      check(
        a.lotUnits.equals(b.lotUnits.times(2)),
        'tax lot units doubled',
        `${b.lotUnits.toFixed(6)} -> ${a.lotUnits.toFixed(6)}`,
      );
      check(
        a.lotCost === b.lotCost,
        'tax lot cost UNCHANGED — lots replaced, never mutated',
        `${formatCents(b.lotCost)} either side`,
      );
      console.log('');
    }

    // The ledger must still balance in the instrument, and the split must not
    // have touched USD at all.
    const { rows: tb } = await client.query<{ commodity: string; units: string | null }>(
      `SELECT commodity, sum(units) AS units FROM journal_lines
        WHERE commodity = $1 GROUP BY 1`,
      [SYMBOL],
    );
    check(
      new Decimal(tb[0]?.units ?? 0).isZero(),
      `${SYMBOL} still nets to zero across all accounts`,
      `sum(units) = ${tb[0]?.units ?? 0}`,
    );

    const { rows: cash } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.kind = 'corporate_action.split' AND l.commodity = 'USD'`,
    );
    check(
      cash[0].n === 0,
      'the split entry contains NO USD line',
      'cost is untouched because there is nothing there to touch',
    );

    console.log('='.repeat(72));
    if (failures > 0) {
      console.log(`\n${failures} check(s) FAILED\n`);
      await client.query('ROLLBACK');
      process.exit(1);
    }
    if (COMMIT) {
      await client.query('COMMIT');
      console.log('\nSplit applied and committed.\n');
    } else {
      await client.query('ROLLBACK');
      console.log('\nAll checks passed. Rolled back — pass --commit to keep it.\n');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nsplit test failed:\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
