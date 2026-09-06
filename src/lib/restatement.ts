/**
 * restatement.ts — history is restated, never rewritten.
 *
 * The scenario, which is the whole reason this track exists:
 *
 *   1. We value the book each day and PUBLISH a return for a period. The
 *      customer sees a number. That number is now a fact about what we told
 *      them, and it must remain answerable forever.
 *   2. Days later, a corrected closing price arrives for a date inside that
 *      period.
 *   3. The return has to be restated to the correct figure — and the originally
 *      published figure has to stay queryable, because "what did you tell the
 *      customer on the 3rd" is a question a regulator asks.
 *
 * NOTHING IS UPDATED ANYWHERE IN THIS FILE. The corrected price is a new
 * `prices` row superseding the old. The revalued day is a new `valuation_runs`
 * row superseding the old. The corrected return is a new `published_returns`
 * row pointing at the one it restates. Three append-only supersessions, and the
 * original of each survives.
 *
 * Which means as-published and as-corrected are the same query with a different
 * `recorded_at` bound. That is not a coincidence — it is the reason the schema
 * carries two time axes.
 */

import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { publishCorrection, resolvePrice } from './providers/marketdata';
import { runValuation } from './valuation';
import { performance } from './performance';
import { price as toPrice } from './money';
import { calendarDaysBetween, marketDateOf, type MarketDate } from './calendar';

export interface PublishedReturn {
  id: string;
  customerId: string;
  periodStart: MarketDate;
  periodEnd: MarketDate;
  twr: Decimal;
  endValueCents: bigint;
  publishedAt: Date;
  restatesId: string | null;
  restatementReason: string | null;
}

/**
 * Publish the return for a period — i.e. record what we told the customer.
 *
 * This is a first-class fact, not a cache. Without it there is no answer to
 * "what did we report", only "what would we report now", and those are
 * different questions.
 */
export async function publishReturn(
  client: PoolClient,
  input: {
    customerId: string;
    periodStart: MarketDate;
    periodEnd: MarketDate;
    restatesId?: string | null;
    reason?: string | null;
    knownAt?: Date;
  },
): Promise<PublishedReturn> {
  const perf = await performance(client, {
    customerId: input.customerId,
    from: input.periodStart,
    to: input.periodEnd,
    knownAt: input.knownAt,
  });

  const { rows: runRows } = await client.query<{ id: string }>(
    `SELECT r.id
       FROM valuation_runs r
       JOIN valuation_totals t ON t.run_id = r.id
      WHERE t.customer_id = $1::uuid AND r.as_of_date = $2::date
        AND r.recorded_at <= coalesce($3::timestamptz, 'infinity')
      ORDER BY r.recorded_at DESC LIMIT 1`,
    [input.customerId, input.periodEnd, input.knownAt ?? null],
  );
  if (!runRows[0]) {
    throw new Error(
      `cannot publish a return for ${input.periodEnd}: no valuation exists for that date`,
    );
  }

  const { rows } = await client.query<{ id: string; published_at: Date }>(
    `INSERT INTO published_returns
       (customer_id, period_start, period_end, twr, end_value_cents, run_id,
        restates_id, restatement_reason)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8)
     RETURNING id, published_at`,
    [
      input.customerId,
      input.periodStart,
      input.periodEnd,
      perf.twr.toFixed(12),
      perf.endValueCents.toString(),
      runRows[0].id,
      input.restatesId ?? null,
      input.reason ?? null,
    ],
  );

  return {
    id: rows[0].id,
    customerId: input.customerId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    twr: perf.twr,
    endValueCents: perf.endValueCents,
    publishedAt: rows[0].published_at,
    restatesId: input.restatesId ?? null,
    restatementReason: input.reason ?? null,
  };
}

export interface RestatementResult {
  symbol: string;
  correctedDate: MarketDate;
  previousPriceCents: string | null;
  correctedPriceCents: string;
  priceRowId: string;
  revaluedDates: MarketDate[];
  restated: Array<{
    customerId: string;
    customerName: string;
    periodStart: MarketDate;
    periodEnd: MarketDate;
    asPublishedTwr: Decimal;
    asCorrectedTwr: Decimal;
    asPublishedEndValueCents: bigint;
    asCorrectedEndValueCents: bigint;
    newPublishedReturnId: string;
    supersededReturnId: string;
  }>;
}

/**
 * A corrected close lands. Restate everything downstream of it.
 *
 * The revaluation deliberately covers every date from the corrected date
 * FORWARD, not just the corrected date itself. A wrong price on the 3rd makes
 * the 3rd wrong, and it also makes the 3rd-to-4th sub-period return wrong,
 * which makes every chained return after it wrong. Restating only the one day
 * would leave the cumulative figure quietly incorrect — the subtlest possible
 * way to fail this test.
 */
export async function applyCorrectedClose(
  client: PoolClient,
  input: {
    symbol: string;
    date: MarketDate;
    correctedPriceCents: string;
    note: string;
  },
): Promise<RestatementResult> {
  // --- 1. the corrected price supersedes the old one -----------------------
  const correction = await publishCorrection(client, {
    symbol: input.symbol,
    date: input.date,
    correctedPriceCents: toPrice(input.correctedPriceCents),
    note: input.note,
  });

  // Everything published BEFORE this moment is the as-published view.
  const asPublishedCutoff = new Date();
  await new Promise((r) => setTimeout(r, 5));

  // --- 2. who is affected, and what did we tell them? ----------------------
  const { rows: affected } = await client.query<{
    id: string;
    legal_name: string;
  }>(
    `SELECT DISTINCT c.id, c.legal_name
       FROM customers c
       JOIN journal_lines l ON l.customer_id = c.id
      WHERE l.account_code = 'assets:positions'
        AND l.commodity = $1
        AND c.legal_name <> 'Invariant Probe'`,
    [input.symbol],
  );

  // --- 3. revalue every day from the corrected date forward ---------------
  const today = marketDateOf(new Date());
  const dates = calendarDaysBetween(input.date, today);
  const revalued: MarketDate[] = [];

  for (const date of dates) {
    const { rows: previous } = await client.query<{ id: string }>(
      `SELECT id FROM valuation_runs
        WHERE as_of_date = $1::date ORDER BY recorded_at DESC LIMIT 1`,
      [date],
    );
    // Only revalue days we had actually valued. Inventing valuations for days
    // the book was never valued would fabricate history rather than correct it.
    if (!previous[0]) continue;

    await runValuation(client, {
      asOf: date,
      trigger: 'restatement',
      note: `corrected close for ${input.symbol} on ${input.date}`,
      supersedesId: previous[0].id,
    });
    revalued.push(date);
  }

  // --- 4. restate each affected published return ---------------------------
  const restated: RestatementResult['restated'] = [];

  for (const customer of affected) {
    const { rows: priorReturns } = await client.query<{
      id: string;
      period_start: string;
      period_end: string;
      twr: string;
      end_value_cents: bigint;
    }>(
      `SELECT DISTINCT ON (period_start, period_end)
              id, to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end, 'YYYY-MM-DD') AS period_end,
              twr, end_value_cents
         FROM published_returns
        WHERE customer_id = $1::uuid
          AND published_at <= $2::timestamptz
          AND period_end >= $3::date
        ORDER BY period_start, period_end, published_at DESC`,
      [customer.id, asPublishedCutoff, input.date],
    );

    for (const prior of priorReturns) {
      // WHY THE REASON IS BUILT FROM THE OUTCOME, NOT ASSUMED.
      //
      // This used to assert that the price correction caused the change, for
      // every prior figure it touched. That is not always true. A figure
      // published before a fix to the RETURN CALCULATION will move even when
      // the corrected price leaves the end value untouched — and then the
      // screen states a cause that the numbers themselves contradict: the end
      // value is identical, so the price cannot be what moved the return.
      //
      // A restatement that misattributes its own cause is worse than no
      // restatement, because it is the record an auditor trusts. So the reason
      // reports what is observably true and says plainly when the price is not
      // the explanation.
      //
      // The figures are computed BEFORE publishing, because the reason depends
      // on them and `published_returns` is append-only: there is no second
      // chance to go back and correct the wording.
      const recomputed = await performance(client, {
        customerId: customer.id,
        from: prior.period_start as MarketDate,
        to: prior.period_end as MarketDate,
      });
      const endValueMoved = recomputed.endValueCents !== prior.end_value_cents;
      const twrMoved = !recomputed.twr.equals(new Decimal(prior.twr));

      const reason =
        `Corrected closing price for ${input.symbol} on ${input.date}: ` +
        `${correction.previousCents ?? 'unknown'} -> ${input.correctedPriceCents} cents. ` +
        `${input.note}` +
        (twrMoved && !endValueMoved
          ? ` NOTE: the end value is unchanged, so this price correction does not ` +
            `explain the change in the return. The earlier figure was published ` +
            `before a correction to the return calculation itself — external ` +
            `flows were not recognised when a deposit settled, so settling cash ` +
            `was counted as performance. It is restated here rather than left ` +
            `standing.`
          : '');

      const fresh = await publishReturn(client, {
        customerId: customer.id,
        periodStart: prior.period_start as MarketDate,
        periodEnd: prior.period_end as MarketDate,
        restatesId: prior.id,
        reason,
      });

      restated.push({
        customerId: customer.id,
        customerName: customer.legal_name,
        periodStart: prior.period_start as MarketDate,
        periodEnd: prior.period_end as MarketDate,
        asPublishedTwr: new Decimal(prior.twr),
        asCorrectedTwr: fresh.twr,
        asPublishedEndValueCents: prior.end_value_cents,
        asCorrectedEndValueCents: fresh.endValueCents,
        newPublishedReturnId: fresh.id,
        supersededReturnId: prior.id,
      });
    }
  }

  return {
    symbol: input.symbol,
    correctedDate: input.date,
    previousPriceCents: correction.previousCents,
    correctedPriceCents: input.correctedPriceCents,
    priceRowId: correction.id,
    revaluedDates: revalued,
    restated,
  };
}

/**
 * What a price for a date looked like then, and looks like now.
 *
 * Used by the UI to show a correction as a before/after rather than as a single
 * number that silently changed.
 */
export async function priceAsPublishedAndCorrected(
  client: PoolClient,
  symbol: string,
  date: MarketDate,
  asPublishedAt: Date,
): Promise<{ asPublished: string | null; asCorrected: string | null }> {
  const published = await resolvePrice(client, {
    symbol,
    asOf: date,
    knownAt: asPublishedAt,
  });
  const corrected = await resolvePrice(client, { symbol, asOf: date });
  return {
    asPublished: published?.priceCents.toFixed(6) ?? null,
    asCorrected: corrected?.priceCents.toFixed(6) ?? null,
  };
}
