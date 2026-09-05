/**
 * verify-invariants.ts — prove the ledger's guarantees against real Postgres.
 *
 * Every claim this system makes about immutability and double-entry is checked
 * here by ATTEMPTING THE FORBIDDEN THING and requiring the database to refuse.
 * A README that says "money rows are append-only" is a promise. This is
 * evidence.
 *
 * Runs entirely inside a transaction that is rolled back at the end, with a
 * savepoint around every probe, so it leaves nothing behind and can be run
 * against the deployed database at any time — including in front of an
 * audience.
 *
 * Note on the deferred balance trigger: it fires at COMMIT, so to observe it
 * without actually committing, each probe builds its entry and then issues
 * SET CONSTRAINTS ALL IMMEDIATE, which forces the check early. The savepoint
 * wraps the WHOLE probe — entry, lines and the forced check — so a rejected
 * entry leaves no residue for the next probe to trip over.
 */

import { Client } from 'pg';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });

interface Check {
  name: string;
  passed: boolean;
  evidence: string;
}

const checks: Check[] = [];
let probeCounter = 0;

function record(name: string, passed: boolean, evidence: string) {
  checks.push({ name, passed, evidence });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        ${evidence}`);
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 130);
}

/**
 * Run `fn` inside a savepoint. Always unwinds, so nothing a probe does can
 * affect the next probe, and resets constraint timing in case the probe forced
 * it to IMMEDIATE.
 */
async function probe(
  client: Client,
  fn: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const name = `probe_${++probeCounter}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    return { ok: true };
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    return { ok: false, error };
  }
}

/**
 * Passes only if the database raises, AND the message matches what we are
 * actually testing for — otherwise a typo in the probe's SQL would look like a
 * passing security control.
 */
async function expectRejection(
  client: Client,
  name: string,
  expected: RegExp,
  fn: () => Promise<void>,
) {
  const result = await probe(client, fn);
  if (result.ok) {
    record(name, false, 'the database ALLOWED it — this is a real problem');
    return;
  }
  const message = firstLine(result.error);
  const matched = expected.test(message);
  record(
    name,
    matched,
    matched ? `refused: ${message}` : `refused for the WRONG reason: ${message}`,
  );
}

async function expectAccepted(
  client: Client,
  name: string,
  evidence: string,
  fn: () => Promise<void>,
) {
  const result = await probe(client, fn);
  record(
    name,
    result.ok,
    result.ok ? evidence : `unexpectedly refused: ${firstLine(result.error)}`,
  );
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
  });
  await client.connect();
  await client.query('BEGIN');

  try {
    const {
      rows: [customer],
    } = await client.query<{ id: string }>(
      `INSERT INTO customers (legal_name, email)
       VALUES ('Invariant Probe', 'probe-${Date.now()}@example.test')
       RETURNING id`,
    );
    await client.query(
      `INSERT INTO instruments (symbol, name, asset_class)
       VALUES ('PROBE', 'Probe Instrument', 'equity')
       ON CONFLICT (symbol) DO NOTHING`,
    );

    const newEntry = async (kind = 'probe'): Promise<string> => {
      const {
        rows: [entry],
      } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries (kind, effective_at, source, narrative, created_by)
         VALUES ($1, now(), 'verify-invariants', 'invariant probe', 'verifier')
         RETURNING id`,
        [kind],
      );
      return entry.id;
    };

    const line = (entryId: string, cols: string, vals: string, params: unknown[] = []) =>
      client.query(
        `INSERT INTO journal_lines (entry_id, ${cols}) VALUES ($1, ${vals})`,
        [entryId, ...params],
      );

    // Force the deferred balance check to run now rather than at COMMIT.
    const forceBalanceCheck = () => client.query('SET CONSTRAINTS ALL IMMEDIATE');

    console.log('\n=== 1. Double entry: every entry balances, per commodity ===\n');

    await expectRejection(
      client,
      'an entry that is off by one cent is refused',
      /does not balance/i,
      async () => {
        const id = await newEntry();
        await line(
          id,
          'account_code, customer_id, commodity, amount_cents',
          `'assets:cash:settled', $2, 'USD', 10000`,
          [customer.id],
        );
        await line(
          id,
          'account_code, commodity, amount_cents',
          `'equity:external:bank', 'USD', -9999`,
        );
        await forceBalanceCheck();
      },
    );

    await expectRejection(
      client,
      'an entry balanced in USD but not in units is refused',
      /does not balance in PROBE/i,
      async () => {
        const id = await newEntry();
        await line(
          id,
          'account_code, customer_id, commodity, units',
          `'assets:positions', $2, 'PROBE', 10.000000`,
          [customer.id],
        );
        await line(
          id,
          'account_code, commodity, units',
          `'equity:external:market', 'PROBE', -9.000000`,
        );
        await forceBalanceCheck();
      },
    );

    await expectRejection(
      client,
      'a single-legged entry is refused',
      /needs at least two legs|does not balance/i,
      async () => {
        const id = await newEntry();
        await line(
          id,
          'account_code, customer_id, commodity, amount_cents',
          `'assets:cash:settled', $2, 'USD', 10000`,
          [customer.id],
        );
        await forceBalanceCheck();
      },
    );

    await expectAccepted(
      client,
      'a balanced two-commodity buy is accepted',
      '+10/-10 PROBE and +150100/-150100 USD: each commodity sums to zero on its own',
      async () => {
        const id = await newEntry('trade.buy');
        await line(
          id,
          'account_code, customer_id, commodity, units',
          `'assets:positions', $2, 'PROBE', 10.000000`,
          [customer.id],
        );
        await line(
          id,
          'account_code, commodity, units',
          `'equity:external:market', 'PROBE', -10.000000`,
        );
        await line(
          id,
          'account_code, customer_id, commodity, amount_cents, related_symbol',
          `'assets:positions:cost', $2, 'USD', 150100, 'PROBE'`,
          [customer.id],
        );
        await line(
          id,
          'account_code, customer_id, commodity, amount_cents',
          `'liabilities:trade_payable', $2, 'USD', -150100`,
          [customer.id],
        );
        await forceBalanceCheck();
      },
    );

    console.log('\n=== 2. The two dimensions cannot mix ===\n');

    const dimensionProbe = async (cols: string, vals: string, params: unknown[] = []) => {
      const id = await newEntry();
      await line(id, cols, vals, params);
    };

    await expectRejection(
      client,
      'a USD line cannot carry units',
      /usd_uses_cents|instrument_uses_units/i,
      () =>
        dimensionProbe(
          'account_code, customer_id, commodity, units',
          `'assets:cash:settled', $2, 'USD', 5.000000`,
          [customer.id],
        ),
    );

    await expectRejection(
      client,
      'an instrument line cannot carry cents',
      /usd_uses_cents|instrument_uses_units/i,
      () =>
        dimensionProbe(
          'account_code, customer_id, commodity, amount_cents',
          `'assets:positions', $2, 'PROBE', 15000`,
          [customer.id],
        ),
    );

    await expectRejection(
      client,
      'a units-only account rejects a USD line',
      /holds instrument units only|usd_uses_cents|instrument_uses_units/i,
      () =>
        dimensionProbe(
          'account_code, customer_id, commodity, amount_cents',
          `'assets:positions', $2, 'USD', 15000`,
          [customer.id],
        ),
    );

    await expectRejection(
      client,
      'a house account rejects a customer id',
      /house account/i,
      () =>
        dimensionProbe(
          'account_code, customer_id, commodity, units',
          `'equity:external:market', $2, 'PROBE', 1.000000`,
          [customer.id],
        ),
    );

    await expectRejection(
      client,
      'a customer-book account requires a customer id',
      /requires customer_id/i,
      () =>
        dimensionProbe(
          'account_code, commodity, amount_cents',
          `'assets:cash:settled', 'USD', 100`,
        ),
    );

    await expectRejection(
      client,
      'a zero-quantity line is refused',
      /journal_lines_nonzero/i,
      () =>
        dimensionProbe(
          'account_code, customer_id, commodity, amount_cents',
          `'assets:cash:settled', $2, 'USD', 0`,
          [customer.id],
        ),
    );

    console.log('\n=== 3. Money rows are append-only ===\n');

    // One real, balanced entry to attack. Committed into the transaction (not
    // rolled back) so the mutation probes have a live row to aim at.
    const victim = await newEntry('victim');
    await line(
      victim,
      'account_code, customer_id, commodity, amount_cents',
      `'assets:cash:settled', $2, 'USD', 500`,
      [customer.id],
    );
    await line(
      victim,
      'account_code, commodity, amount_cents',
      `'equity:external:bank', 'USD', -500`,
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    await expectRejection(
      client,
      'UPDATE on journal_entries is refused',
      /append-only/i,
      async () => {
        await client.query(
          `UPDATE journal_entries SET narrative = 'tampered' WHERE id = $1`,
          [victim],
        );
      },
    );

    await expectRejection(
      client,
      'UPDATE on journal_lines is refused',
      /append-only/i,
      async () => {
        await client.query(
          `UPDATE journal_lines SET amount_cents = 999999 WHERE entry_id = $1`,
          [victim],
        );
      },
    );

    await expectRejection(
      client,
      'DELETE on journal_lines is refused',
      /append-only/i,
      async () => {
        await client.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [victim]);
      },
    );

    await expectRejection(
      client,
      'DELETE on journal_entries is refused',
      /append-only/i,
      async () => {
        await client.query(`DELETE FROM journal_entries WHERE id = $1`, [victim]);
      },
    );

    await expectRejection(
      client,
      'TRUNCATE on journal_lines is refused',
      /append-only/i,
      async () => {
        await client.query(`TRUNCATE journal_lines`);
      },
    );

    await expectRejection(
      client,
      'UPDATE on prices is refused (a corrected close supersedes, never overwrites)',
      /append-only/i,
      async () => {
        await client.query(
          `INSERT INTO prices (symbol, price_date, price_cents, source)
           VALUES ('PROBE', current_date, 10000, 'probe')`,
        );
        await client.query(`UPDATE prices SET price_cents = 1 WHERE symbol = 'PROBE'`);
      },
    );

    await expectRejection(
      client,
      'UPDATE on tax_lots is refused (a lot is never mutated as it is consumed)',
      /append-only/i,
      async () => {
        await client.query(
          `INSERT INTO tax_lots (customer_id, symbol, units, cost_cents, acquired_at, entry_id)
           VALUES ($1, 'PROBE', 1, 100, now(), $2)`,
          [customer.id, victim],
        );
        await client.query(`UPDATE tax_lots SET cost_cents = 0 WHERE symbol = 'PROBE'`);
      },
    );

    console.log('\n=== 4. Maker-checker: nobody approves their own action ===\n');

    await expectRejection(
      client,
      'self-approval is refused by the schema, not by a code path',
      /approvals_no_self_approval/i,
      async () => {
        await client.query(
          `INSERT INTO approvals
             (action_type, payload, requested_by, requested_by_kind, decided_by, status)
           VALUES ('withdrawal', '{}'::jsonb, 'ops@example.test', 'human',
                   'ops@example.test', 'approved')`,
        );
      },
    );

    await expectAccepted(
      client,
      'a different approver is accepted',
      'maker and checker are distinct identities',
      async () => {
        await client.query(
          `INSERT INTO approvals
             (action_type, payload, requested_by, requested_by_kind, decided_by, status)
           VALUES ('withdrawal', '{}'::jsonb, 'maker@example.test', 'human',
                   'checker@example.test', 'approved')`,
        );
      },
    );

    console.log('\n=== 5. Trial balance nets to zero ===\n');

    const { rows: totals } = await client.query<{
      commodity: string;
      cents: string | null;
      units: string | null;
    }>(
      `SELECT commodity, sum(amount_cents) AS cents, sum(units) AS units
         FROM journal_lines GROUP BY commodity ORDER BY commodity`,
    );

    if (totals.length === 0) {
      record('trial balance', false, 'no lines found — the probe wrote nothing');
    }
    for (const row of totals) {
      const cents = BigInt(row.cents ?? '0');
      const units = Number(row.units ?? 0);
      record(
        `trial balance nets to zero in ${row.commodity}`,
        cents === 0n && units === 0,
        `sum(cents)=${cents}, sum(units)=${units}`,
      );
    }
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${checks.length - failed.length}/${checks.length} invariants hold.`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.evidence}`);
    process.exit(1);
  }
  console.log('Transaction rolled back; the database is unchanged.');
}

main().catch((error) => {
  console.error('\nverification crashed:', error);
  process.exit(1);
});
