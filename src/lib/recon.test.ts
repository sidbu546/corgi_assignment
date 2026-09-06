/**
 * recon.test.ts — the breaks screen must not lose a break.
 *
 * WHY THIS FILE EXISTS. I shipped the reconciliation ENGINE with good tests
 * (a clean run finds zero breaks, a planted run finds exactly two per
 * customer) and shipped a SCREEN that silently showed a subset of what the
 * engine found. Twice:
 *
 *   DISTINCT ON (as_of_date)              -> one customer, everyone else hidden
 *   DISTINCT ON (customer_id, as_of_date) -> one break per customer, rest hidden
 *
 * Neither errored. Both looked entirely plausible. Correct logic behind a lossy
 * query is indistinguishable, from the outside, from broken logic — and for a
 * screen whose entire purpose is that a break must not get lost, that is the
 * worst available failure.
 *
 * So the selection logic is extracted and tested here as a pure function over
 * rows, with no database. The page uses the equivalent SQL; this pins the
 * behaviour it has to have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Row {
  breakId: string;
  customerId: string;
  runId: string;
  runStartedAt: number;
  asOfDate: string;
  classification: string;
}

/**
 * The rule, stated once: for the latest as-of date, take the latest RUN per
 * customer, then take EVERY break belonging to those runs.
 */
export function selectVisibleBreaks(rows: readonly Row[]): Row[] {
  if (rows.length === 0) return [];

  const latestDate = rows.reduce(
    (max, r) => (r.asOfDate > max ? r.asOfDate : max),
    rows[0].asOfDate,
  );
  const onLatestDate = rows.filter((r) => r.asOfDate === latestDate);

  // Latest run per customer.
  const latestRunFor = new Map<string, { runId: string; startedAt: number }>();
  for (const row of onLatestDate) {
    const current = latestRunFor.get(row.customerId);
    if (!current || row.runStartedAt > current.startedAt) {
      latestRunFor.set(row.customerId, {
        runId: row.runId,
        startedAt: row.runStartedAt,
      });
    }
  }

  // EVERY break from those runs — not one per customer.
  return onLatestDate.filter(
    (row) => latestRunFor.get(row.customerId)?.runId === row.runId,
  );
}

const row = (
  breakId: string,
  customerId: string,
  runId: string,
  runStartedAt: number,
  classification = 'genuine.position',
  asOfDate = '2026-09-06',
): Row => ({ breakId, customerId, runId, runStartedAt, asOfDate, classification });

test('every break from a customer’s latest run is shown, not just one', () => {
  // Dana has TWO breaks in one run. Both must appear.
  const rows = [
    row('b1', 'dana', 'run-dana', 100, 'genuine.position'),
    row('b2', 'dana', 'run-dana', 100, 'unbooked.corporate_action'),
  ];
  const visible = selectVisibleBreaks(rows);
  assert.deepEqual(
    visible.map((r) => r.breakId).sort(),
    ['b1', 'b2'],
    'a customer with two breaks must show two breaks',
  );
});

test('every customer is shown, not just the last one reconciled', () => {
  // reconcile() creates one run PER CUSTOMER — the shape that caused the
  // original bug.
  const rows = [
    row('b1', 'dana', 'run-dana', 100),
    row('b2', 'marcus', 'run-marcus', 200),
    row('b3', 'robin', 'run-robin', 300),
  ];
  const visible = selectVisibleBreaks(rows);
  assert.deepEqual(
    [...new Set(visible.map((r) => r.customerId))].sort(),
    ['dana', 'marcus', 'robin'],
    'all three customers must appear even though each has its own run',
  );
});

test('both bugs at once: three customers, two breaks each, all six shown', () => {
  const rows = [
    row('d1', 'dana', 'run-dana', 100, 'genuine.position'),
    row('d2', 'dana', 'run-dana', 100, 'unbooked.corporate_action'),
    row('m1', 'marcus', 'run-marcus', 200, 'genuine.position'),
    row('m2', 'marcus', 'run-marcus', 200, 'unbooked.corporate_action'),
    row('r1', 'robin', 'run-robin', 300, 'genuine.position'),
    row('r2', 'robin', 'run-robin', 300, 'unbooked.corporate_action'),
  ];
  assert.equal(
    selectVisibleBreaks(rows).length,
    6,
    'six breaks exist and six must be visible',
  );
});

test('a re-run supersedes the earlier run for that customer only', () => {
  const rows = [
    // Dana reconciled twice today; only the later run counts.
    row('stale', 'dana', 'run-dana-1', 100, 'genuine.position'),
    row('fresh', 'dana', 'run-dana-2', 400, 'genuine.position'),
    // Marcus reconciled once; his run must survive Dana's re-run.
    row('m1', 'marcus', 'run-marcus', 200, 'genuine.position'),
  ];
  const visible = selectVisibleBreaks(rows).map((r) => r.breakId).sort();
  assert.deepEqual(visible, ['fresh', 'm1']);
});

test('only the latest as-of date is shown', () => {
  const rows = [
    row('yesterday', 'dana', 'run-y', 100, 'genuine.position', '2026-09-05'),
    row('today', 'dana', 'run-t', 200, 'genuine.position', '2026-09-06'),
  ];
  assert.deepEqual(
    selectVisibleBreaks(rows).map((r) => r.breakId),
    ['today'],
  );
});

test('no breaks means no breaks, not a crash', () => {
  assert.deepEqual(selectVisibleBreaks([]), []);
});
