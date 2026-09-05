/**
 * verify-invariants.ts — CLI wrapper around the invariant suite.
 *
 * The checks themselves live in src/lib/ledger/invariants.ts so that the exact
 * same code runs from the terminal and from the /invariants page. One
 * implementation, two surfaces — otherwise the page could drift into claiming
 * something the CLI does not actually test.
 *
 * Run: npm run verify
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { runInvariants } from '../src/lib/ledger/invariants';

async function main() {
  const report = await runInvariants();

  let group = '';
  for (const check of report.checks) {
    if (check.group !== group) {
      group = check.group;
      console.log(`\n=== ${group} ===\n`);
    }
    console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`        ${check.evidence}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(
    `${report.passed}/${report.total} invariants hold (${report.durationMs}ms).`,
  );

  if (!report.allHold) {
    console.log('\nFAILED:');
    for (const c of report.checks.filter((x) => !x.passed)) {
      console.log(`  - ${c.name}: ${c.evidence}`);
    }
    process.exit(1);
  }
  console.log('Transaction rolled back; the database is unchanged.');
}

main().catch((error) => {
  console.error('\nverification crashed:', error);
  process.exit(1);
});
