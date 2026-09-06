/**
 * invariants.ts — the ledger's guarantees, checked by attempting to break them.
 *
 * Every claim this system makes about immutability and double-entry is verified
 * here by ATTEMPTING THE FORBIDDEN THING and requiring Postgres to refuse it.
 * A README that says "money rows are append-only" is a promise. This is
 * evidence.
 *
 * Runs inside a transaction that is always rolled back, with a savepoint around
 * every probe, so it changes nothing and can be run against the production
 * database at any time — including live, in front of an audience, which is the
 * entire point. It is exposed both as `npm run verify` and as a page.
 */

import '../pg-types';
import { Client } from 'pg';

export interface InvariantCheck {
  group: string;
  name: string;
  passed: boolean;
  evidence: string;
}

export interface InvariantReport {
  checks: InvariantCheck[];
  passed: number;
  total: number;
  allHold: boolean;
  ranAt: string;
  durationMs: number;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 200);
}

export async function runInvariants(connectionString?: string): Promise<InvariantReport> {
  const started = Date.now();
  const checks: InvariantCheck[] = [];
  let probeCounter = 0;

  const client = new Client({
    connectionString:
      connectionString ?? process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
  });

  const record = (group: string, name: string, passed: boolean, evidence: string) =>
    checks.push({ group, name, passed, evidence });

  /** Always unwinds, so no probe can affect the next one. */
  const probe = async (
    fn: () => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    const sp = `probe_${++probeCounter}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      await fn();
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      return { ok: true };
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      return { ok: false, error };
    }
  };

  /**
   * Passes only if the database raises AND the message matches what we are
   * testing for — otherwise a typo in the probe's SQL would look like a passing
   * security control.
   */
  const expectRejection = async (
    group: string,
    name: string,
    expected: RegExp,
    fn: () => Promise<void>,
  ) => {
    const result = await probe(fn);
    if (result.ok) {
      record(group, name, false, 'the database ALLOWED it — this is a real problem');
      return;
    }
    const message = firstLine(result.error);
    const matched = expected.test(message);
    record(
      group,
      name,
      matched,
      matched ? `refused: ${message}` : `refused for the WRONG reason: ${message}`,
    );
  };

  const expectAccepted = async (
    group: string,
    name: string,
    evidence: string,
    fn: () => Promise<void>,
  ) => {
    const result = await probe(fn);
    record(
      group,
      name,
      result.ok,
      result.ok ? evidence : `unexpectedly refused: ${firstLine(result.error)}`,
    );
  };

  await client.connect();
  await client.query('BEGIN');

  try {
    const {
      rows: [customer],
    } = await client.query<{ id: string }>(
      `INSERT INTO customers (legal_name, email)
       VALUES ('Invariant Probe', $1) RETURNING id`,
      [`probe-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`],
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
         VALUES ($1, now(), 'invariants', 'invariant probe', 'verifier') RETURNING id`,
        [kind],
      );
      return entry.id;
    };

    const line = (entryId: string, cols: string, vals: string, params: unknown[] = []) =>
      client.query(`INSERT INTO journal_lines (entry_id, ${cols}) VALUES ($1, ${vals})`, [
        entryId,
        ...params,
      ]);

    // The balance trigger is DEFERRED and fires at COMMIT. Forcing it to
    // IMMEDIATE lets us observe the refusal without actually committing.
    const forceBalanceCheck = () => client.query('SET CONSTRAINTS ALL IMMEDIATE');

    // ---- group 1: double entry -------------------------------------------
    const G1 = 'Double entry';

    await expectRejection(G1, 'an entry off by one cent is refused', /does not balance/i, async () => {
      const id = await newEntry();
      await line(id, 'account_code, customer_id, commodity, amount_cents',
        `'assets:cash:settled', $2, 'USD', 10000`, [customer.id]);
      await line(id, 'account_code, commodity, amount_cents',
        `'equity:external:bank', 'USD', -9999`);
      await forceBalanceCheck();
    });

    await expectRejection(G1, 'balanced in USD but not in units is refused', /does not balance in PROBE/i, async () => {
      const id = await newEntry();
      await line(id, 'account_code, customer_id, commodity, units',
        `'assets:positions', $2, 'PROBE', 10.000000`, [customer.id]);
      await line(id, 'account_code, commodity, units',
        `'equity:external:market', 'PROBE', -9.000000`);
      await forceBalanceCheck();
    });

    await expectRejection(G1, 'a single-legged entry is refused', /at least two legs|does not balance/i, async () => {
      const id = await newEntry();
      await line(id, 'account_code, customer_id, commodity, amount_cents',
        `'assets:cash:settled', $2, 'USD', 10000`, [customer.id]);
      await forceBalanceCheck();
    });

    await expectAccepted(
      G1,
      'a balanced two-commodity buy is accepted',
      '+10/-10 PROBE and +150100/-150100 USD: each commodity sums to zero on its own',
      async () => {
        const id = await newEntry('trade.buy');
        await line(id, 'account_code, customer_id, commodity, units',
          `'assets:positions', $2, 'PROBE', 10.000000`, [customer.id]);
        await line(id, 'account_code, commodity, units',
          `'equity:external:market', 'PROBE', -10.000000`);
        await line(id, 'account_code, customer_id, commodity, amount_cents, related_symbol',
          `'assets:positions:cost', $2, 'USD', 150100, 'PROBE'`, [customer.id]);
        await line(id, 'account_code, customer_id, commodity, amount_cents',
          `'liabilities:trade_payable', $2, 'USD', -150100`, [customer.id]);
        await forceBalanceCheck();
      },
    );

    // ---- group 2: dimensions ---------------------------------------------
    const G2 = 'Units and money never mix';

    const dim = async (cols: string, vals: string, params: unknown[] = []) => {
      const id = await newEntry();
      await line(id, cols, vals, params);
    };

    await expectRejection(G2, 'a USD line cannot carry units', /usd_uses_cents|instrument_uses_units/i, () =>
      dim('account_code, customer_id, commodity, units', `'assets:cash:settled', $2, 'USD', 5.000000`, [customer.id]));

    await expectRejection(G2, 'an instrument line cannot carry cents', /usd_uses_cents|instrument_uses_units/i, () =>
      dim('account_code, customer_id, commodity, amount_cents', `'assets:positions', $2, 'PROBE', 15000`, [customer.id]));

    await expectRejection(G2, 'a units-only account rejects a USD line', /holds instrument units only|usd_uses_cents|instrument_uses_units/i, () =>
      dim('account_code, customer_id, commodity, amount_cents', `'assets:positions', $2, 'USD', 15000`, [customer.id]));

    await expectRejection(G2, 'a house account rejects a customer id', /house account/i, () =>
      dim('account_code, customer_id, commodity, units', `'equity:external:market', $2, 'PROBE', 1.000000`, [customer.id]));

    await expectRejection(G2, 'a customer-book account requires a customer id', /requires customer_id/i, () =>
      dim('account_code, commodity, amount_cents', `'assets:cash:settled', 'USD', 100`));

    await expectRejection(G2, 'a zero-quantity line is refused', /journal_lines_nonzero/i, () =>
      dim('account_code, customer_id, commodity, amount_cents', `'assets:cash:settled', $2, 'USD', 0`, [customer.id]));

    // ---- group 3: append-only --------------------------------------------
    const G3 = 'Money rows are append-only';

    const victim = await newEntry('victim');
    await line(victim, 'account_code, customer_id, commodity, amount_cents',
      `'assets:cash:settled', $2, 'USD', 500`, [customer.id]);
    await line(victim, 'account_code, commodity, amount_cents',
      `'equity:external:bank', 'USD', -500`);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    await expectRejection(G3, 'UPDATE on journal_entries is refused', /append-only/i, async () => {
      await client.query(`UPDATE journal_entries SET narrative = 'tampered' WHERE id = $1`, [victim]);
    });
    await expectRejection(G3, 'UPDATE on journal_lines is refused', /append-only/i, async () => {
      await client.query(`UPDATE journal_lines SET amount_cents = 999999 WHERE entry_id = $1`, [victim]);
    });
    await expectRejection(G3, 'DELETE on journal_lines is refused', /append-only/i, async () => {
      await client.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [victim]);
    });
    await expectRejection(G3, 'DELETE on journal_entries is refused', /append-only/i, async () => {
      await client.query(`DELETE FROM journal_entries WHERE id = $1`, [victim]);
    });
    await expectRejection(G3, 'TRUNCATE on journal_lines is refused', /append-only/i, async () => {
      await client.query(`TRUNCATE journal_lines`);
    });
    await expectRejection(G3, 'UPDATE on prices is refused', /append-only/i, async () => {
      await client.query(
        `INSERT INTO prices (symbol, price_date, price_cents, source)
         VALUES ('PROBE', current_date, 10000, 'probe')`);
      await client.query(`UPDATE prices SET price_cents = 1 WHERE symbol = 'PROBE'`);
    });
    await expectRejection(G3, 'UPDATE on tax_lots is refused', /append-only/i, async () => {
      await client.query(
        `INSERT INTO tax_lots (customer_id, symbol, units, cost_cents, acquired_at, entry_id)
         VALUES ($1, 'PROBE', 1, 100, now(), $2)`, [customer.id, victim]);
      await client.query(`UPDATE tax_lots SET cost_cents = 0 WHERE symbol = 'PROBE'`);
    });

    // ---- group 4: maker-checker ------------------------------------------
    const G4 = 'Maker-checker';

    await expectRejection(G4, 'nobody can approve their own action', /approvals_no_self_approval/i, async () => {
      await client.query(
        `INSERT INTO approvals (action_type, payload, requested_by, requested_by_kind, decided_by, status)
         VALUES ('withdrawal', '{}'::jsonb, 'ops@example.test', 'human', 'ops@example.test', 'approved')`);
    });

    await expectAccepted(G4, 'a different approver is accepted', 'maker and checker are distinct identities', async () => {
      await client.query(
        `INSERT INTO approvals (action_type, payload, requested_by, requested_by_kind, decided_by, status)
         VALUES ('withdrawal', '{}'::jsonb, 'maker@example.test', 'human', 'checker@example.test', 'approved')`);
    });

    // Self-EXECUTION is a separate constraint from self-approval. Approving and
    // executing are two acts and both belong to the checker; without this the
    // maker could not approve their own withdrawal but could still press
    // "execute" on it once somebody else had approved.
    await expectRejection(
      G4,
      'the initiator cannot execute their own request either',
      /approvals_no_self_execution/i,
      async () => {
        await client.query(
          `INSERT INTO approvals (action_type, payload, amount_cents, requested_by,
                                  requested_by_kind, decided_by, executed_by, status)
           VALUES ('withdrawal', '{}'::jsonb, 150000, 'maker@example.test', 'human',
                   'checker@example.test', 'maker@example.test', 'executed')`,
        );
      },
    );

    await expectAccepted(
      G4,
      'the checker may both approve and execute',
      'one different person does both halves; the maker does neither',
      async () => {
        await client.query(
          `INSERT INTO approvals (action_type, payload, amount_cents, requested_by,
                                  requested_by_kind, decided_by, executed_by, status)
           VALUES ('withdrawal', '{}'::jsonb, 150000, 'maker@example.test', 'human',
                   'checker@example.test', 'checker@example.test', 'executed')`,
        );
      },
    );

    // ---- group 5: trial balance ------------------------------------------
    const G5 = 'Trial balance';

    const { rows: totals } = await client.query<{
      commodity: string; cents: string | null; units: string | null;
    }>(`SELECT commodity, sum(amount_cents)::bigint AS cents, sum(units) AS units
          FROM journal_lines GROUP BY commodity ORDER BY commodity`);

    for (const row of totals) {
      const cents = BigInt(row.cents ?? '0');
      const units = Number(row.units ?? 0);
      record(G5, `nets to zero in ${row.commodity}`, cents === 0n && units === 0,
        `sum(cents)=${cents}, sum(units)=${units}`);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }

  const passed = checks.filter((c) => c.passed).length;
  return {
    checks,
    passed,
    total: checks.length,
    allHold: passed === checks.length,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}
