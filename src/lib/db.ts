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

import { Pool, type PoolClient } from 'pg';

// Registers the bigint/numeric parsers. Imported explicitly rather than relied
// on as a side effect of importing this file — see pg-types.ts for why that
// distinction cost me a bug.
import './pg-types';

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
 * Borrow a client for a read that spans several queries.
 *
 * No transaction: these are reads, and wrapping them in one would take a
 * snapshot that is no more correct here — every query already pins its own
 * point in time explicitly through the `effective_at` / `recorded_at`
 * predicates, which is a stronger guarantee than transaction isolation and one
 * the caller chooses deliberately.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
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
