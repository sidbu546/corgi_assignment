/**
 * recon.ts — diff the custodian against our ledger, and classify what differs.
 *
 * Detecting a difference is trivial. The work is deciding what KIND of
 * difference it is, because an ops team that gets a flat list of every mismatch
 * every morning stops reading it by Thursday. A real breaks screen has to
 * separate:
 *
 *   TIMING          we book on trade date, the custodian moves on settlement.
 *                   Nothing is wrong. It clears itself on T+1, and the screen
 *                   should say when.
 *
 *   UNBOOKED        the custodian knows something we do not — a dividend paid,
 *                   a fee charged. Actionable: book it. This is also the thing
 *                   that forces a restatement when it lands for a period we
 *                   have already reported.
 *
 *   GENUINE         no benign explanation. Escalate.
 *
 * The classification is derived, never asserted: each candidate explanation is
 * tested against the ledger and only accepted if it accounts for the difference
 * exactly. A break explained "approximately" is still a genuine break.
 *
 * AGING carries across runs. A break seen for the first time this morning is
 * very different from the same break on its fifth day, and the screen shows
 * which by matching on a stable signature rather than a row id.
 */

import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import type { MarketDate } from './calendar';
import { nextTradingDay } from './calendar';
import { formatCents } from './money';
import {
  ourSnapshot,
  type CustodianFile,
  CUSTODIAN_SOURCE,
} from './providers/custodian';

export type BreakClassification =
  | 'timing.unsettled_trade'
  | 'timing.pending_deposit'
  | 'unbooked.corporate_action'
  | 'genuine.position'
  | 'genuine.cash';

export interface ReconBreak {
  breakType: 'position' | 'cash' | 'transaction';
  classification: BreakClassification;
  symbol: string | null;
  oursUnits: string | null;
  theirsUnits: string | null;
  oursCents: bigint | null;
  theirsCents: bigint | null;
  detail: string;
  expectedClearDate: MarketDate | null;
  /** Stable across runs, so aging survives. */
  signature: string;
}

export interface ReconResult {
  runId: string;
  asOf: MarketDate;
  positionsChecked: number;
  breaks: Array<ReconBreak & { firstSeenAt: Date; ageDays: number }>;
  clean: boolean;
}

/**
 * Reconcile one customer for one date.
 *
 * Writes a run and its breaks, and carries `first_seen_at` forward for any
 * break whose signature was already open — so the screen can age them.
 */
export async function reconcile(
  client: PoolClient,
  input: { customerId: string; asOf: MarketDate; file: CustodianFile },
): Promise<ReconResult> {
  const { file, asOf, customerId } = input;
  const ours = await ourSnapshot(client, customerId, asOf);
  const breaks: ReconBreak[] = [];

  const { rows: runRows } = await client.query<{ id: string }>(
    // customer_id is recorded on the RUN, not inferred from the breaks it
    // produced. A run that finds nothing has to be findable too, or a clean
    // reconciliation can never clear the previous morning's breaks.
    `INSERT INTO recon_runs (as_of_date, source, file_ref, customer_id)
     VALUES ($1, $2, $3, $4::uuid) RETURNING id`,
    [asOf, CUSTODIAN_SOURCE, `${file.account_ref}:${asOf}`, customerId],
  );
  const runId = runRows[0].id;

  // ---------------------------------------------------------------------------
  // 1. transactions the custodian reports that we have not booked
  //    Done FIRST, because an unbooked dividend also explains a cash difference,
  //    and reporting the same fact twice as two breaks would be noise.
  // ---------------------------------------------------------------------------
  let unbookedCashCents = 0n;

  for (const transaction of file.transactions) {
    const amount = BigInt(Math.round(transaction.amount_cents));

    if (transaction.type === 'dividend' && transaction.symbol) {
      // Has THIS distribution been booked?
      //
      // Matching on the transaction's own settlement date, not on cumulative
      // dividend income for the symbol. An earlier version compared the
      // custodian's single transaction against the sum of every dividend we had
      // ever booked for that ticker, which is comparing a transaction to a
      // running total — it made a fully-explained cash difference look like an
      // unexplained one, which is the exact failure this screen exists to avoid.
      const { rows } = await client.query<{ cents: bigint }>(
        `SELECT coalesce(sum(l.amount_cents), 0)::bigint AS cents
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.customer_id = $1::uuid
            AND l.account_code = 'income:dividend'
            AND l.related_symbol = $2
            AND (e.effective_at AT TIME ZONE 'America/New_York')::date = $3::date`,
        [customerId, transaction.symbol, transaction.settled_on],
      );
      // Income increases negative, so booked income is the negation.
      const bookedCents = -(rows[0]?.cents ?? 0n);

      if (bookedCents < amount) {
        const missing = amount - bookedCents;
        unbookedCashCents += missing;
        breaks.push({
          breakType: 'transaction',
          classification: 'unbooked.corporate_action',
          symbol: transaction.symbol,
          oursUnits: null,
          theirsUnits: null,
          oursCents: bookedCents,
          theirsCents: amount,
          detail:
            `Custodian reports a ${transaction.symbol} distribution of ` +
            `${formatCents(amount)} settling ${transaction.settled_on} ` +
            `(${transaction.reference}); we have booked ` +
            `${formatCents(bookedCents)} for that date. Actionable: record the ` +
            `dividend. If it belongs to a period already reported, booking it ` +
            `triggers a restatement of that period's return.`,
          expectedClearDate: null,
          signature: `unbooked:dividend:${transaction.symbol}:${transaction.reference}`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. positions
  // ---------------------------------------------------------------------------
  const theirPositions = new Map(
    file.positions.map((p) => [p.symbol, new Decimal(p.units)]),
  );
  const symbols = new Set([...ours.positions.keys(), ...theirPositions.keys()]);

  for (const symbol of [...symbols].sort()) {
    const oursUnits = ours.positions.get(symbol) ?? new Decimal(0);
    const theirsUnits = theirPositions.get(symbol) ?? new Decimal(0);
    if (oursUnits.equals(theirsUnits)) continue;

    const difference = oursUnits.minus(theirsUnits);

    // Is the difference exactly a trade that has not settled yet? If so it is
    // timing, not a break — and we can say when it will clear.
    const { rows: unsettled } = await client.query<{ units: string | null }>(
      `SELECT sum(oe.fill_units) AS units
         FROM order_events oe
         JOIN orders o ON o.id = oe.order_id
        WHERE o.customer_id = $1::uuid
          AND o.symbol = $2
          AND oe.kind IN ('fill', 'partial_fill')
          AND oe.settlement_date > $3::date
          AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.order_event_id = oe.id)`,
      [customerId, symbol, asOf],
    );
    const unsettledUnits = new Decimal(unsettled[0]?.units ?? 0);

    if (!unsettledUnits.isZero() && difference.equals(unsettledUnits)) {
      breaks.push({
        breakType: 'position',
        classification: 'timing.unsettled_trade',
        symbol,
        oursUnits: oursUnits.toFixed(6),
        theirsUnits: theirsUnits.toFixed(6),
        oursCents: null,
        theirsCents: null,
        detail:
          `We hold ${oursUnits.toFixed(6)} on a trade-date basis; the custodian ` +
          `settles T+1 and reports ${theirsUnits.toFixed(6)}. The ` +
          `${unsettledUnits.toFixed(6)} difference is an unsettled trade and ` +
          `will clear on its own.`,
        expectedClearDate: nextTradingDay(asOf),
        signature: `timing:position:${symbol}`,
      });
      continue;
    }

    breaks.push({
      breakType: 'position',
      classification: 'genuine.position',
      symbol,
      oursUnits: oursUnits.toFixed(6),
      theirsUnits: theirsUnits.toFixed(6),
      oursCents: null,
      theirsCents: null,
      detail:
        `Position mismatch with no benign explanation. We hold ` +
        `${oursUnits.toFixed(6)}, the custodian reports ${theirsUnits.toFixed(6)}, ` +
        `a difference of ${difference.toFixed(6)} units. No unsettled trade ` +
        `accounts for it. Escalate.`,
      expectedClearDate: null,
      signature: `genuine:position:${symbol}`,
    });
  }

  // ---------------------------------------------------------------------------
  // 3. cash
  // ---------------------------------------------------------------------------
  const theirCash = BigInt(Math.round(file.cash.settled_cents));
  const cashDifference = theirCash - ours.settledCents;

  if (cashDifference !== 0n) {
    // Work through the benign explanations in order, subtracting each only if
    // it accounts for the difference EXACTLY. "Approximately explained" is not
    // explained.
    const explanations: string[] = [];
    let residual = cashDifference;

    if (unbookedCashCents !== 0n && residual === unbookedCashCents) {
      explanations.push(
        `${formatCents(unbookedCashCents)} is the unbooked distribution above`,
      );
      residual = 0n;
    }

    if (residual !== 0n && ours.pendingDepositCents !== 0n) {
      if (residual === ours.pendingDepositCents) {
        breaks.push({
          breakType: 'cash',
          classification: 'timing.pending_deposit',
          symbol: null,
          oursUnits: null,
          theirsUnits: null,
          oursCents: ours.settledCents,
          theirsCents: theirCash,
          detail:
            `Cash differs by exactly the deposit in flight ` +
            `(${formatCents(ours.pendingDepositCents)}). The custodian has ` +
            `received it; we hold it as pending until the rail confirms good ` +
            `funds. Clears on settlement.`,
          expectedClearDate: nextTradingDay(asOf),
          signature: `timing:cash:pending_deposit`,
        });
        residual = 0n;
      }
    }

    if (residual !== 0n) {
      breaks.push({
        breakType: 'cash',
        classification: 'genuine.cash',
        symbol: null,
        oursUnits: null,
        theirsUnits: null,
        oursCents: ours.settledCents,
        theirsCents: theirCash,
        detail:
          `Settled cash mismatch. We show ${formatCents(ours.settledCents)}, the ` +
          `custodian shows ${formatCents(theirCash)}, a difference of ` +
          `${formatCents(cashDifference)}` +
          (explanations.length
            ? ` of which ${explanations.join('; ')}, leaving ` +
              `${formatCents(residual)} unexplained.`
            : ` with no benign explanation.`) +
          ` Escalate.`,
        expectedClearDate: null,
        signature: `genuine:cash`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // persist, carrying aging forward
  // ---------------------------------------------------------------------------
  const persisted: ReconResult['breaks'] = [];

  for (const b of breaks) {
    // Has this exact break been open before? If so keep its original
    // first_seen_at so the screen can age it.
    const { rows: prior } = await client.query<{ first_seen_at: Date }>(
      `SELECT first_seen_at FROM recon_breaks
        WHERE customer_id = $1::uuid
          AND detail LIKE '%'
          AND resolved_at IS NULL
          AND break_type = $2
          AND coalesce(symbol, '') = coalesce($3, '')
          AND classification = $4
        ORDER BY first_seen_at ASC LIMIT 1`,
      [customerId, b.breakType, b.symbol, b.classification],
    );
    const firstSeenAt = prior[0]?.first_seen_at ?? new Date();

    await client.query(
      `INSERT INTO recon_breaks
         (run_id, customer_id, break_type, classification, symbol,
          ours_units, theirs_units, ours_cents, theirs_cents,
          first_seen_at, expected_clear_date, detail)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        runId,
        customerId,
        b.breakType,
        b.classification,
        b.symbol,
        b.oursUnits,
        b.theirsUnits,
        b.oursCents?.toString() ?? null,
        b.theirsCents?.toString() ?? null,
        firstSeenAt,
        b.expectedClearDate,
        b.detail,
      ],
    );

    persisted.push({
      ...b,
      firstSeenAt,
      ageDays: Math.floor((Date.now() - firstSeenAt.getTime()) / 86_400_000),
    });
  }

  await client.query(
    `UPDATE recon_runs
        SET finished_at = now(), positions_checked = $2, breaks_found = $3
      WHERE id = $1::uuid`,
    [runId, symbols.size, breaks.length],
  );

  return {
    runId,
    asOf,
    positionsChecked: symbols.size,
    breaks: persisted,
    clean: breaks.length === 0,
  };
}

/** How bad is a break? Drives ordering and colour on the screen. */
export function severity(classification: BreakClassification): 'info' | 'warn' | 'critical' {
  if (classification.startsWith('timing.')) return 'info';
  if (classification.startsWith('unbooked.')) return 'warn';
  return 'critical';
}
