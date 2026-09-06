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

/** A reconciliation run. One per customer, and it knows which customer. */
interface Run {
  runId: string;
  customerId: string;
  runStartedAt: number;
  asOfDate: string;
}

interface Row {
  breakId: string;
  runId: string;
  classification: string;
}

/**
 * The rule, stated once: for the latest as-of date, take the latest RUN per
 * customer, then take EVERY break belonging to those runs.
 *
 * Runs are an INDEPENDENT input, not something derived from the breaks. That
 * distinction is the whole third bug: when the latest run was inferred from
 * the breaks it produced, a run that produced none was invisible, so a clean
 * reconciliation could never clear the previous morning's breaks.
 */
export function selectVisibleBreaks(
  runs: readonly Run[],
  breaks: readonly Row[],
): Row[] {
  if (runs.length === 0) return [];

  const latestDate = runs.reduce(
    (max, r) => (r.asOfDate > max ? r.asOfDate : max),
    runs[0].asOfDate,
  );
  const onLatestDate = runs.filter((r) => r.asOfDate === latestDate);

  // Latest run per customer, chosen from the runs themselves.
  const latestRunFor = new Map<string, Run>();
  for (const run of onLatestDate) {
    const current = latestRunFor.get(run.customerId);
    if (!current || run.runStartedAt > current.runStartedAt) {
      latestRunFor.set(run.customerId, run);
    }
  }
  const visibleRunIds = new Set([...latestRunFor.values()].map((r) => r.runId));

  // EVERY break from those runs — not one per customer.
  return breaks.filter((b) => visibleRunIds.has(b.runId));
}

/** Build the run + break pair a single break implies, for terse tests. */
const run = (
  runId: string,
  customerId: string,
  runStartedAt: number,
  asOfDate = '2026-09-06',
): Run => ({ runId, customerId, runStartedAt, asOfDate });

const brk = (
  breakId: string,
  runId: string,
  classification = 'genuine.position',
): Row => ({ breakId, runId, classification });

test('every break from a customer’s latest run is shown, not just one', () => {
  // Dana has TWO breaks in one run. Both must appear.
  const runs = [run('run-dana', 'dana', 100)];
  const rows = [
    brk('b1', 'run-dana', 'genuine.position'),
    brk('b2', 'run-dana', 'unbooked.corporate_action'),
  ];
  const visible = selectVisibleBreaks(runs, rows);
  assert.deepEqual(
    visible.map((r) => r.breakId).sort(),
    ['b1', 'b2'],
    'a customer with two breaks must show two breaks',
  );
});

test('every customer is shown, not just the last one reconciled', () => {
  // reconcile() creates one run PER CUSTOMER — the shape that caused the
  // original bug.
  const runs = [
    run('run-dana', 'dana', 100),
    run('run-marcus', 'marcus', 200),
    run('run-robin', 'robin', 300),
  ];
  const rows = [
    brk('b1', 'run-dana'),
    brk('b2', 'run-marcus'),
    brk('b3', 'run-robin'),
  ];
  const visible = selectVisibleBreaks(runs, rows);
  assert.deepEqual(
    [...new Set(visible.map((r) => r.runId))].sort().map((id) => id.replace('run-', '')),
    ['dana', 'marcus', 'robin'],
    'all three customers must appear even though each has its own run',
  );
});

test('both bugs at once: three customers, two breaks each, all six shown', () => {
  const runs = [
    run('run-dana', 'dana', 100),
    run('run-marcus', 'marcus', 200),
    run('run-robin', 'robin', 300),
  ];
  const rows = [
    brk('d1', 'run-dana', 'genuine.position'),
    brk('d2', 'run-dana', 'unbooked.corporate_action'),
    brk('m1', 'run-marcus', 'genuine.position'),
    brk('m2', 'run-marcus', 'unbooked.corporate_action'),
    brk('r1', 'run-robin', 'genuine.position'),
    brk('r2', 'run-robin', 'unbooked.corporate_action'),
  ];
  assert.equal(
    selectVisibleBreaks(runs, rows).length,
    6,
    'six breaks exist and six must be visible',
  );
});

test('a re-run supersedes the earlier run for that customer only', () => {
  const runs = [
    // Dana reconciled twice today; only the later run counts.
    run('run-dana-1', 'dana', 100),
    run('run-dana-2', 'dana', 400),
    // Marcus reconciled once; his run must survive Dana's re-run.
    run('run-marcus', 'marcus', 200),
  ];
  const rows = [
    brk('stale', 'run-dana-1'),
    brk('fresh', 'run-dana-2'),
    brk('m1', 'run-marcus'),
  ];
  const visible = selectVisibleBreaks(runs, rows).map((r) => r.breakId).sort();
  assert.deepEqual(visible, ['fresh', 'm1']);
});

test('only the latest as-of date is shown', () => {
  const runs = [
    run('run-y', 'dana', 100, '2026-09-05'),
    run('run-t', 'dana', 200, '2026-09-06'),
  ];
  const rows = [
    brk('yesterday', 'run-y'),
    brk('today', 'run-t'),
  ];
  assert.deepEqual(
    selectVisibleBreaks(runs, rows).map((r) => r.breakId),
    ['today'],
  );
});

test('no breaks means no breaks, not a crash', () => {
  assert.deepEqual(selectVisibleBreaks([], []), []);
});

// -----------------------------------------------------------------------------
// The third bug: a clean run must be able to clear the board
// -----------------------------------------------------------------------------

test('a clean re-run clears that customer’s breaks', () => {
  // Dana was reconciled at 100 and had two breaks. She was reconciled again at
  // 400 and it found nothing. Nothing is what must be shown.
  //
  // The earlier implementation derived runs from breaks, so run-dana-2 did not
  // exist as far as the query was concerned and the two stale breaks stayed on
  // screen — while the run that had just finished reported zero.
  const runs = [run('run-dana-1', 'dana', 100), run('run-dana-2', 'dana', 400)];
  const rows = [
    brk('stale-1', 'run-dana-1', 'genuine.position'),
    brk('stale-2', 'run-dana-1', 'unbooked.corporate_action'),
  ];
  assert.deepEqual(
    selectVisibleBreaks(runs, rows),
    [],
    'a reconciliation that finds nothing must show nothing',
  );
});

test('one customer going clean does not hide another’s breaks', () => {
  const runs = [
    run('run-dana-1', 'dana', 100),
    run('run-dana-2', 'dana', 400), // clean re-run
    run('run-marcus', 'marcus', 200),
  ];
  const rows = [
    brk('stale', 'run-dana-1'),
    brk('m1', 'run-marcus'),
  ];
  assert.deepEqual(
    selectVisibleBreaks(runs, rows).map((r) => r.breakId),
    ['m1'],
    'Dana clearing must not clear Marcus',
  );
});

test('a clean run across every customer shows an empty board', () => {
  const runs = [
    run('d1', 'dana', 100),
    run('m1', 'marcus', 100),
    run('d2', 'dana', 500),
    run('m2', 'marcus', 500),
  ];
  const rows = [brk('old-d', 'd1'), brk('old-m', 'm1')];
  assert.deepEqual(selectVisibleBreaks(runs, rows), []);
});
