/**
 * correct-provenance.ts — a one-off correction of my own mistake, using the
 * mechanism this system exists to demonstrate.
 *
 * THE MISTAKE. The rail simulator produced settlement events that the webhook
 * handler booked with `source: 'alpaca.events'` and `created_by:
 * 'bridge:alpaca'`. That is false: Alpaca never reported those settlements. The
 * money movement was right, the provenance was a lie, and provenance in a
 * ledger is not a cosmetic field — it is the answer to "who told us this".
 *
 * WHY THIS SCRIPT RATHER THAN AN UPDATE. Because an UPDATE is impossible, by
 * design, and would be wrong even if it were not. Correcting a ledger means
 * reversing the original and re-booking the truth, leaving three rows that tell
 * the whole story: what we recorded, that we withdrew it, and what we recorded
 * instead. The original stays exactly as written.
 *
 * The cash effect is zero. Only the record of who said so changes.
 *
 * Run: npx tsx scripts/correct-provenance.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import { postEntry, reverseEntry, usd } from '../src/lib/ledger/post';
import { formatCents } from '../src/lib/money';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });
  const client = await pool.connect();

  try {
    // Settlement entries attributed to Alpaca that Alpaca never sent. They are
    // identifiable because the transfer they reference is still SENT_TO_CLEARING
    // at Alpaca — but rather than call Alpaca for each, the simulator's own
    // event ids are recorded on cash_transfer_events, so match on those.
    const { rows: suspect } = await client.query<{
      id: string;
      narrative: string;
      source_ref: string | null;
      customer_id: string;
      amount_cents: bigint;
    }>(
      `SELECT DISTINCT e.id, e.narrative, e.source_ref,
              l.customer_id, abs(l.amount_cents) AS amount_cents
         FROM journal_entries e
         JOIN journal_lines l
           ON l.entry_id = e.id AND l.account_code = 'assets:cash:settled'
        WHERE e.kind = 'deposit.settled'
          AND e.source = 'alpaca.events'
          AND EXISTS (
                SELECT 1 FROM cash_transfer_events cte
                 WHERE cte.entry_id = e.id
                   AND cte.provider_event_id LIKE 'simulated-%'
          )
          AND NOT EXISTS (
                SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id
          )`,
    );

    if (suspect.length === 0) {
      console.log('\nNothing to correct. No settlement entry misattributes its source.\n');
      return;
    }

    console.log(
      `\nFound ${suspect.length} settlement entr${suspect.length === 1 ? 'y' : 'ies'} ` +
        `attributed to Alpaca that the rail simulator produced.\n`,
    );

    for (const entry of suspect) {
      console.log(`  original ${entry.id}`);
      console.log(`    ${entry.narrative.slice(0, 100)}`);

      await client.query('BEGIN');

      const reversal = await reverseEntry(client, entry.id, {
        reason:
          'provenance was wrong: recorded as reported by Alpaca, but produced by ' +
          'our own rail simulator',
        createdBy: 'correction:provenance',
        source: 'correction',
      });

      const rebook = await postEntry(client, {
        kind: 'deposit.settled.simulated',
        effectiveAt: new Date(),
        source: 'simulator:rail',
        sourceRef: entry.source_ref,
        createdBy: 'simulator:rail',
        correctsEntryId: entry.id,
        narrative:
          `ACH deposit of ${formatCents(entry.amount_cents)} treated as good funds. ` +
          `[SIMULATED NOTIFICATION — the transfer and its Alpaca id are real and ` +
          `held at SENT_TO_CLEARING; Alpaca has not reported completion. Its ` +
          `sandbox settles ACH on trading days only.]`,
        lines: [
          usd('assets:cash:pending_deposit', -entry.amount_cents, {
            customerId: entry.customer_id,
          }),
          usd('assets:cash:settled', entry.amount_cents, {
            customerId: entry.customer_id,
            memo: 'simulated settlement notification',
          }),
        ],
      });

      await client.query('COMMIT');

      console.log(`    reversal ${reversal.id}`);
      console.log(`    re-book  ${rebook.id}  (deposit.settled.simulated)\n`);
    }

    const { rows: tb } = await client.query<{ commodity: string; cents: bigint | null }>(
      `SELECT commodity, sum(amount_cents)::bigint AS cents
         FROM journal_lines GROUP BY 1 ORDER BY 1`,
    );
    const balanced = tb.every((t) => (t.cents ?? 0n) === 0n || t.commodity !== 'USD');
    console.log(`Trial balance USD: ${tb.find((t) => t.commodity === 'USD')?.cents ?? 0n}`);
    console.log(
      balanced
        ? 'Corrected. Cash effect zero; only the record of who said so changed.\n'
        : 'OUT OF BALANCE — investigate.\n',
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
  console.error('\ncorrection failed:\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
