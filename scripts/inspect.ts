/**
 * inspect.ts — read the seeded ledger from the terminal.
 *
 * A debugging and demo-prep tool. Everything it prints is derived from journal
 * lines, so if a number here disagrees with the UI, one of them is reading the
 * ledger wrong and that is worth knowing immediately.
 *
 * Run: npx tsx scripts/inspect.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { formatCents } from '../src/lib/money';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });
  const client = await pool.connect();
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await client.query(sql, params)).rows as T[];

  try {
    console.log('\n=== customers ===\n');
    const customers = await q<{ id: string; legal_name: string; email: string; kyc: string }>(
      `SELECT c.id, c.legal_name, c.email,
              (SELECT status FROM kyc_events k
                WHERE k.customer_id = c.id ORDER BY effective_at DESC, recorded_at DESC, id DESC LIMIT 1) AS kyc
         FROM customers c ORDER BY c.created_at`,
    );
    for (const c of customers) {
      console.log(`  ${c.legal_name.padEnd(20)} ${c.email.padEnd(30)} kyc=${c.kyc}`);
    }

    for (const c of customers) {
      const cash = await q<{ account_code: string; cents: bigint }>(
        `SELECT l.account_code, sum(l.amount_cents)::bigint AS cents
           FROM journal_lines l
          WHERE l.customer_id = $1::uuid AND l.commodity = 'USD'
          GROUP BY 1 HAVING sum(l.amount_cents) <> 0 ORDER BY 1`,
        [c.id],
      );
      const positions = await q<{ commodity: string; units: string; cost: bigint | null }>(
        `SELECT u.commodity, u.units, k.cost
           FROM (SELECT commodity, sum(units) AS units FROM journal_lines
                  WHERE customer_id = $1::uuid AND account_code = 'assets:positions'
                  GROUP BY 1) u
           LEFT JOIN (SELECT related_symbol AS s, sum(amount_cents)::bigint AS cost
                        FROM journal_lines
                       WHERE customer_id = $1::uuid
                         AND account_code = 'assets:positions:cost'
                       GROUP BY 1) k ON k.s = u.commodity
          WHERE u.units <> 0 ORDER BY 1`,
        [c.id],
      );
      if (cash.length === 0 && positions.length === 0) continue;

      console.log(`\n  --- ${c.legal_name} ---`);
      for (const row of cash) {
        console.log(`    ${row.account_code.padEnd(34)} ${formatCents(row.cents).padStart(14)}`);
      }
      let mv = 0n;
      for (const p of positions) {
        const [price] = await q<{ price_cents: string }>(
          `SELECT price_cents FROM prices WHERE symbol = $1
            ORDER BY price_date DESC, recorded_at DESC LIMIT 1`,
          [p.commodity],
        );
        const value = BigInt(
          new Decimal(p.units).times(price.price_cents).toDecimalPlaces(0).toFixed(0),
        );
        mv += value;
        const cost = p.cost ?? 0n;
        const pnl = value - cost;
        console.log(
          `    ${p.commodity.padEnd(6)} ${String(p.units).padStart(14)} units  ` +
            `cost ${formatCents(cost).padStart(12)}  ` +
            `mkt ${formatCents(value).padStart(12)}  ` +
            `unrealised ${formatCents(pnl).padStart(11)}`,
        );
      }
      if (positions.length) console.log(`    ${''.padEnd(34)} positions ${formatCents(mv)}`);
    }

    console.log('\n=== tax lots ===\n');
    const lots = await q<{
      name: string; symbol: string; units: string; cost_cents: bigint;
      acquired: Date; consumed: string; remaining: string;
    }>(
      `SELECT cu.legal_name AS name, l.symbol, l.units, l.cost_cents,
              l.acquired_at AS acquired,
              coalesce(sum(tc.units), 0) AS consumed,
              l.units - coalesce(sum(tc.units), 0) AS remaining
         FROM tax_lots l
         JOIN customers cu ON cu.id = l.customer_id
         LEFT JOIN tax_lot_consumptions tc ON tc.lot_id = l.id
        GROUP BY cu.legal_name, l.id, l.symbol, l.units, l.cost_cents, l.acquired_at
        ORDER BY cu.legal_name, l.symbol, l.acquired_at`,
    );
    for (const l of lots) {
      const flag = Number(l.remaining) === 0 ? ' (exhausted)' : '';
      console.log(
        `  ${l.name.split(' ')[0].padEnd(8)} ${l.symbol.padEnd(6)} ` +
          `${String(l.acquired).slice(4, 15)}  opened ${String(l.units).padStart(12)}  ` +
          `remaining ${String(l.remaining).padStart(12)}  ` +
          `basis ${formatCents(l.cost_cents).padStart(12)}${flag}`,
      );
    }

    console.log('\n=== realised disposals ===\n');
    const disposals = await q<{
      name: string; symbol: string; units: string; cost_cents: bigint;
      proceeds_cents: bigint; realized_gain_cents: bigint; disposed_at: Date;
    }>(
      `SELECT cu.legal_name AS name, l.symbol, tc.units, tc.cost_cents,
              tc.proceeds_cents, tc.realized_gain_cents, tc.disposed_at
         FROM tax_lot_consumptions tc
         JOIN tax_lots l ON l.id = tc.lot_id
         JOIN customers cu ON cu.id = l.customer_id
        ORDER BY tc.disposed_at, l.symbol`,
    );
    if (disposals.length === 0) console.log('  (none)');
    for (const d of disposals) {
      console.log(
        `  ${d.name.split(' ')[0].padEnd(8)} ${d.symbol.padEnd(6)} ` +
          `${String(d.disposed_at).slice(4, 15)}  ${String(d.units).padStart(12)} units  ` +
          `basis ${formatCents(d.cost_cents).padStart(11)}  ` +
          `proceeds ${formatCents(d.proceeds_cents).padStart(11)}  ` +
          `realised ${formatCents(d.realized_gain_cents).padStart(10)}`,
      );
    }

    console.log('\n=== dividends ===\n');
    const divs = await q<{ kind: string; narrative: string }>(
      `SELECT kind, narrative FROM journal_entries
        WHERE kind LIKE 'dividend%' ORDER BY effective_at, kind`,
    );
    if (divs.length === 0) console.log('  (none)');
    for (const d of divs) console.log(`  ${d.kind.padEnd(20)} ${d.narrative}`);

    console.log('\n=== trial balance ===\n');
    const totals = await q<{ commodity: string; cents: bigint | null; units: string | null }>(
      `SELECT commodity, sum(amount_cents)::bigint AS cents, sum(units) AS units
         FROM journal_lines GROUP BY 1 ORDER BY 1`,
    );
    for (const t of totals) {
      const ok = (t.cents ?? 0n) === 0n && new Decimal(t.units ?? 0).isZero();
      console.log(
        `  ${t.commodity.padEnd(6)} cents=${String(t.cents ?? 0n).padStart(4)} ` +
          `units=${String(t.units ?? 0).padStart(10)}  ${ok ? 'OK' : '*** OUT OF BALANCE ***'}`,
      );
    }
    console.log('');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
