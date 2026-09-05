/**
 * db.ts — Postgres access.
 *
 * Deliberately thin. Everything that touches money is hand-written SQL in
 * src/lib/ledger, because one of the automatic fails on this project is "code
 * you cannot explain line by line" and generated SQL is exactly that.
 *
 * Two things worth knowing:
 *
 *  1. bigint comes back from `pg` as a string by default, because a Postgres
 *     bigint does not fit in a JS number. We parse it to a native bigint rather
 *     than to a number, so a cent amount can never silently lose precision by
 *     passing through a float. This is configured globally below.
 *
 *  2. `numeric` also comes back as a string, which is correct and we keep it
 *     that way — it is handed to Decimal, never to parseFloat.
 */

import { Pool, types, type PoolClient } from 'pg';

// OID 20 = int8/bigint. Without this, cents come back as JS strings and get
// coerced to Number somewhere downstream, which is how you get $0.01 errors
// that nobody can reproduce.
types.setTypeParser(20, (value: string) => BigInt(value));

// OID 1700 = numeric. Left as a string on purpose: it goes straight into
// Decimal. parseFloat on a numeric is the units-vs-money bug wearing a hat.
types.setTypeParser(1700, (value: string) => value);

declare global {
  // Next.js dev server hot-reloads modules; without this the pool is recreated
  // on every reload until Postgres refuses new connections.
  // eslint-disable-next-line no-var
  var __corgiPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.',
    );
  }
  return new Pool({
    connectionString,
    // Neon terminates idle connections; keep the pool small and let it recycle.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function pool(): Pool {
  if (!global.__corgiPool) global.__corgiPool = createPool();
  return global.__corgiPool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool().query(text, params as unknown[]);
  return result.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  if (rows.length > 1) {
    throw new Error(`expected at most one row, got ${rows.length}`);
  }
  return rows[0] ?? null;
}

/**
 * Run a function inside a transaction.
 *
 * This is the ONLY way money is written. The ledger's balance check is a
 * DEFERRABLE INITIALLY DEFERRED constraint trigger, which means it fires at
 * COMMIT — so an entry whose legs do not balance will throw here, at the end,
 * and the whole transaction rolls back. A half-written trade cannot exist.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    // If the entry does not balance, COMMIT is where we find out.
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* the connection is already broken; the original error is the useful one */
    });
    throw error;
  } finally {
    client.release();
  }
}
