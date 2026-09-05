/**
 * sql-hygiene.test.ts — catch a whole class of bug rather than its instances.
 *
 * THE BUG THIS EXISTS FOR:
 *
 * In Postgres, `sum()` over a `bigint` column returns **numeric**, not bigint.
 * Our type parser deliberately maps numeric to a JavaScript string (it belongs
 * in Decimal, and parseFloat on a numeric is the units-versus-money bug wearing
 * a hat). So an un-cast aggregate over a money column arrives as a string, and
 * then either:
 *
 *   - throws "Cannot mix BigInt and other types" — the lucky case, or
 *   - silently concatenates: 500n + "300" would be a disaster if the types
 *     lined up, and `'0' === 0n` is quietly false, which is how a trial balance
 *     can report OUT OF BALANCE (or, worse, balanced) for the wrong reason.
 *
 * I hit this three times in a row — in accountBalances, in externalFlowsByDay,
 * and in loadLots — before writing this. Fixing instances of a bug you keep
 * making is not fixing the bug; the fix is a check that fails the build.
 *
 * THE RULE: every `sum(...)` over a money column must be cast `::bigint` in
 * the SQL, at the query, so exactness is guaranteed in one place rather than
 * being coerced back in JavaScript afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Columns that hold money, in integer cents. */
const MONEY_COLUMNS = [
  'amount_cents',
  'cost_cents',
  'proceeds_cents',
  'realized_gain_cents',
  'market_value_cents',
  'total_value_cents',
  'settled_cash_cents',
  'end_value_cents',
  'begin_value_cents',
  'external_flow_cents',
];

const ROOTS = ['src', 'db', 'scripts'];

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      yield* walk(full);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.sql')) {
      yield full;
    }
  }
}

test('every sum() over a money column is cast to ::bigint in the SQL', async () => {
  // sum( ... money_column ... )  not immediately followed by ::bigint
  const pattern = new RegExp(
    String.raw`\bsum\s*\(\s*[^()]*?\b(${MONEY_COLUMNS.join('|')})\b[^()]*?\)(?!\s*::\s*bigint)`,
    'gi',
  );

  const offenders: string[] = [];

  for (const root of ROOTS) {
    for await (const file of walk(path.join(process.cwd(), root))) {
      // This file necessarily contains the column names it is checking for.
      if (file.endsWith('sql-hygiene.test.ts')) continue;

      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, i) => {
        pattern.lastIndex = 0;
        // A HAVING clause compares inside SQL and never crosses into JS, so it
        // does not need the cast. Everything in a SELECT list does.
        if (/\bHAVING\b/i.test(line)) return;
        if (pattern.test(line)) {
          offenders.push(
            `${path.relative(process.cwd(), file)}:${i + 1}  ${line.trim()}`,
          );
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Un-cast money aggregate(s) found. sum() over a bigint column returns ` +
      `numeric, which arrives in JavaScript as a string:\n\n${offenders.join('\n')}\n`,
  );
});

test('no money column is read through parseFloat or Number()', async () => {
  const banned = new RegExp(
    String.raw`(parseFloat|Number)\s*\(\s*[^)]*\b(${MONEY_COLUMNS.join('|')})\b`,
    'gi',
  );
  const offenders: string[] = [];

  for (const root of ROOTS) {
    for await (const file of walk(path.join(process.cwd(), root))) {
      if (file.endsWith('sql-hygiene.test.ts')) continue;
      const source = await readFile(file, 'utf8');
      source.split('\n').forEach((line, i) => {
        banned.lastIndex = 0;
        if (banned.test(line)) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Money must never pass through a float:\n\n${offenders.join('\n')}\n`,
  );
});
