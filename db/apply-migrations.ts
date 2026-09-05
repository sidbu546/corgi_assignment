/**
 * apply-migrations.ts — shared migration runner.
 *
 * Used by `npm run migrate` and by `npm run seed -- --reset`, so there is one
 * implementation of "bring the schema up to date" rather than two that can
 * disagree.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Client } from 'pg';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

export async function applyMigrations(
  client: Client,
  log: (line: string) => void = () => {},
): Promise<number> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const { rows: applied } = await client.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  const appliedByName = new Map(applied.map((r) => [r.filename, r.checksum]));

  let ran = 0;

  for (const filename of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const previous = appliedByName.get(filename);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `${filename} has already been applied but its contents have changed ` +
            `(was ${previous}, now ${checksum}).\n` +
            `Applied migrations are immutable. Write a new migration instead.`,
        );
      }
      log(`  = ${filename} (already applied)`);
      continue;
    }

    log(`  + ${filename}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum],
      );
      await client.query('COMMIT');
      ran++;
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `${filename} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  return ran;
}
