/**
 * migrate.ts — apply SQL migrations in order, exactly once each.
 *
 * Deliberately boring and dependency-free. Migrations are plain .sql files that
 * I wrote and can read aloud; there is no migration DSL to explain.
 *
 * Each file runs inside its own transaction, so a failed migration leaves the
 * database on the last good state rather than half-applied. The checksum guard
 * catches the specific mistake of editing a migration that has already run on
 * the deployed database, which is how schemas silently diverge between local
 * and production.
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

async function main() {
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set.\n' +
        'Copy .env.example to .env.local and paste your Neon connection string.',
    );
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

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
        console.log(`  = ${filename} (already applied)`);
        continue;
      }

      process.stdout.write(`  + ${filename} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, checksum],
        );
        await client.query('COMMIT');
        console.log('ok');
        ran++;
      } catch (error) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw error;
      }
    }

    console.log(
      ran === 0
        ? '\nSchema already up to date.'
        : `\nApplied ${ran} migration${ran === 1 ? '' : 's'}.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('\nMigration failed:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
