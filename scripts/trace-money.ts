/**
 * trace-money.ts — follow the money end to end, from the ledger.
 *
 * Prints every journal entry for one customer in economic order, with the
 * running cash and position balances after each, so the whole path is visible
 * in one screen:
 *
 *   deposit initiated -> settled -> buy -> settlement -> dividend accrued ->
 *   paid -> sell (FIFO) -> settlement -> withdrawal
 *
 * Nothing here is a summary table maintained alongside the ledger. Every figure
 * is folded from journal_lines at that point in time, which is the claim this
 * project makes and this script is the proof: if the narrative and the balances
 * disagree, the ledger is wrong.
 *
 * Run: npm run trace [customer-email]
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import Decimal from 'decimal.js';
import { formatCents, formatUnits } from '../src/lib/money';

const EMAIL = process.argv[2] ?? 'dana@demo.ledgerly.app';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** Short, human labels for the account codes. */
const LABEL: Record<string, string> = {
  'assets:cash:settled': 'settled cash',
  'assets:cash:unsettled_proceeds': 'unsettled proceeds',
  'assets:cash:pending_deposit': 'deposit in flight',
  'assets:positions': 'position',
  'assets:positions:cost': 'cost basis',
  'assets:receivable:dividend': 'dividend receivable',
  'liabilities:trade_payable': 'owed to broker',
  'income:realized_gain': 'realised gain',
  'income:dividend': 'dividend income',
  'equity:external:bank': '→ bank',
  'equity:external:market': '→ market',
  'expenses:fees': 'fees',
};

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });
  const client = await pool.connect();

  try {
    const { rows: customers } = await client.query<{ id: string; legal_name: string }>(
      `SELECT id, legal_name FROM customers WHERE email = $1`,
      [EMAIL],
    );
    if (!customers[0]) throw new Error(`no customer ${EMAIL}`);
    const customer = customers[0];

    const { rows: lines } = await client.query<{
      entry_id: string;
      kind: string;
      narrative: string;
      effective_at: Date;
      recorded_at: Date;
      created_by: string;
      source: string;
      account_code: string;
      commodity: string;
      amount_cents: bigint | null;
      units: string | null;
      related_symbol: string | null;
      customer_id: string | null;
    }>(
      `SELECT e.id AS entry_id, e.kind, e.narrative, e.effective_at, e.recorded_at,
              e.created_by, e.source,
              l.account_code, l.commodity, l.amount_cents, l.units,
              l.related_symbol, l.customer_id
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.id IN (
              SELECT DISTINCT entry_id FROM journal_lines WHERE customer_id = $1::uuid
        )
        ORDER BY e.effective_at, e.recorded_at, l.id`,
      [customer.id],
    );

    // Group into entries, preserving order.
    const entries: Array<{ header: (typeof lines)[number]; legs: typeof lines }> = [];
    for (const line of lines) {
      const last = entries[entries.length - 1];
      if (last && last.header.entry_id === line.entry_id) last.legs.push(line);
      else entries.push({ header: line, legs: [line] });
    }

    console.log(`\n${C.bold(`Money path — ${customer.legal_name}`)}`);
    console.log(
      C.dim(
        'Every balance below is folded from journal lines at that point in time.\n' +
          'Nothing is read from a summary table, because there is not one.\n',
      ),
    );

    // Running balances, rebuilt entry by entry.
    const cash = {
      'assets:cash:settled': 0n,
      'assets:cash:unsettled_proceeds': 0n,
      'assets:cash:pending_deposit': 0n,
    } as Record<string, bigint>;
    const units = new Map<string, Decimal>();

    let n = 0;
    for (const { header, legs } of entries) {
      n++;
      const date = new Date(header.effective_at).toISOString().slice(0, 10);

      console.log(
        `${C.cyan(String(n).padStart(2))}  ${C.bold(date)}  ${C.bold(header.kind)}`,
      );
      console.log(`    ${header.narrative}`);
      console.log(
        C.dim(`    by ${header.created_by} via ${header.source}`),
      );

      for (const leg of legs) {
        const mine = leg.customer_id === customer.id;
        const label = LABEL[leg.account_code] ?? leg.account_code;

        if (leg.commodity === 'USD') {
          const amount = leg.amount_cents ?? 0n;
          if (mine && leg.account_code in cash) cash[leg.account_code] += amount;
          const sign = amount >= 0n ? '+' : '−';
          const colour = amount >= 0n ? C.green : C.red;
          console.log(
            `      ${mine ? ' ' : C.dim('·')} ${label.padEnd(22)} ` +
              colour(`${sign}${formatCents(amount < 0n ? -amount : amount).padStart(12)}`) +
              (leg.related_symbol ? C.dim(`  ${leg.related_symbol}`) : ''),
          );
        } else {
          const qty = new Decimal(leg.units ?? 0);
          if (mine) {
            units.set(
              leg.commodity,
              (units.get(leg.commodity) ?? new Decimal(0)).plus(qty),
            );
          }
          const colour = qty.isNegative() ? C.red : C.green;
          console.log(
            `      ${mine ? ' ' : C.dim('·')} ${(label + ' ' + leg.commodity).padEnd(22)} ` +
              colour(`${qty.isNegative() ? '' : '+'}${formatUnits(qty).padStart(12)}`) +
              C.dim('  units'),
          );
        }
      }

      const held = [...units.entries()]
        .filter(([, q]) => !q.isZero())
        .map(([sym, q]) => `${sym} ${formatUnits(q)}`)
        .join('  ');

      console.log(
        C.dim(
          `    after: settled ${formatCents(cash['assets:cash:settled'])}` +
            `  ·  unsettled ${formatCents(cash['assets:cash:unsettled_proceeds'])}` +
            `  ·  in flight ${formatCents(cash['assets:cash:pending_deposit'])}` +
            (held ? `\n           holding ${held}` : ''),
        ),
      );
      console.log('');
    }

    // ---- the invariant, restated at the end ------------------------------
    const { rows: check } = await client.query<{
      account_code: string;
      cents: bigint;
    }>(
      `SELECT l.account_code, sum(l.amount_cents)::bigint AS cents
         FROM journal_lines l
        WHERE l.customer_id = $1::uuid AND l.commodity = 'USD'
          AND l.account_code LIKE 'assets:cash%'
        GROUP BY 1 ORDER BY 1`,
      [customer.id],
    );

    console.log(C.bold('Cross-check — the same numbers, queried straight from the ledger\n'));
    let ok = true;
    for (const row of check) {
      const traced = cash[row.account_code] ?? 0n;
      const matches = traced === row.cents;
      if (!matches) ok = false;
      console.log(
        `  ${matches ? C.green('OK  ') : C.red('MISMATCH')} ${LABEL[row.account_code].padEnd(22)} ` +
          `traced ${formatCents(traced).padStart(12)}   queried ${formatCents(row.cents).padStart(12)}`,
      );
    }

    const { rows: tb } = await client.query<{ commodity: string; cents: bigint | null; units: string | null }>(
      `SELECT commodity, sum(amount_cents)::bigint AS cents, sum(units) AS units
         FROM journal_lines GROUP BY 1 ORDER BY 1`,
    );
    const balanced = tb.every(
      (t) => (t.cents ?? 0n) === 0n && new Decimal(t.units ?? 0).isZero(),
    );

    console.log(
      `\n  ${balanced ? C.green('OK  ') : C.red('FAIL')} firm-wide trial balance nets to zero in ` +
        `${tb.length} commodities`,
    );

    console.log(
      `\n${'='.repeat(74)}\n` +
        (ok && balanced
          ? C.green('The narrative and the ledger agree. That is the whole claim.')
          : C.red('The narrative and the ledger DISAGREE — the ledger is wrong.')),
    );
    if (!ok || !balanced) process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\ntrace failed:\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
