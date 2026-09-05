/**
 * migrate.ts — apply SQL migrations in order, exactly once each.
 *
 * The runner lives in apply-migrations.ts so `npm run seed -- --reset` uses the
 * same code path. Migrations are plain .sql files I wrote and can read aloud;
 * there is no migration DSL to explain.
 *
 * Run: npm run migrate
 */

import { Client } from 'pg';
import { config } from 'dotenv';
import { applyMigrations } from './apply-migrations';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

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
    const ran = await applyMigrations(client, (line) => console.log(line));
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
