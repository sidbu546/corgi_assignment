/**
 * run-recon.ts — the morning reconciliation.
 *
 *   npx tsx scripts/run-recon.ts             clean run: we should agree
 *   npx tsx scripts/run-recon.ts --plant     plant the debrief's breaks
 *
 * A clean run producing zero breaks is the important half of this test. If the
 * reconciliation reports noise when nothing is wrong, nobody will believe it
 * when something is.
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import { marketDateOf } from '../src/lib/calendar';
import { debriefAnomalies, generateFile } from '../src/lib/providers/custodian';
import { reconcile, severity } from '../src/lib/recon';

const PLANT = process.argv.includes('--plant');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 4,
  });
  const client = await pool.connect();
  const asOf = marketDateOf(new Date());

  try {
    const { rows: customers } = await client.query<{ id: string; legal_name: string }>(
      `SELECT DISTINCT c.id, c.legal_name
         FROM customers c
         JOIN journal_lines l ON l.customer_id = c.id
        WHERE c.legal_name <> 'Invariant Probe'
        ORDER BY c.legal_name`,
    );

    console.log(
      `\nMorning reconciliation for ${asOf}` +
        (PLANT ? '  [--plant: injecting breaks]' : '  [clean run]') +
        '\n',
    );

    let totalBreaks = 0;

    for (const customer of customers) {
      const file = await generateFile(client, {
        customerId: customer.id,
        asOf,
        anomalies: PLANT ? debriefAnomalies('VOO') : undefined,
      });

      await client.query('BEGIN');
      const result = await reconcile(client, {
        customerId: customer.id,
        asOf,
        file,
      });
      await client.query('COMMIT');

      totalBreaks += result.breaks.length;

      console.log(
        `${customer.legal_name.padEnd(20)} ${result.positionsChecked} position(s) checked  ` +
          (result.clean
            ? 'CLEAN'
            : `${result.breaks.length} break(s)`),
      );

      if (file._injected.length > 0) {
        console.log(`  simulator planted: ${file._injected.join('; ')}`);
      }

      for (const b of result.breaks) {
        const sev = severity(b.classification).toUpperCase();
        console.log(`  [${sev.padEnd(8)}] ${b.classification}`);
        console.log(`             ${b.detail}`);
        if (b.expectedClearDate) {
          console.log(`             expected to clear: ${b.expectedClearDate}`);
        }
        console.log(`             age: ${b.ageDays} day(s)`);
      }
      if (result.breaks.length) console.log('');
    }

    console.log(`${'='.repeat(72)}`);
    console.log(
      totalBreaks === 0
        ? 'No breaks. Our ledger and the custodian agree.'
        : `${totalBreaks} break(s) surfaced and classified.`,
    );
    if (!PLANT && totalBreaks > 0) {
      console.log(
        '\nA CLEAN run should produce zero breaks. Noise here would make the\n' +
          'screen unusable on the day a real break appears.',
      );
      process.exitCode = 1;
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
  console.error('\nReconciliation failed:\n', error);
  process.exit(1);
});
