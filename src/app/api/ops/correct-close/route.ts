/**
 * POST /api/ops/correct-close — a corrected closing price arrives.
 *
 * Ops-only. This is the trigger for the whole restatement machinery, and it is
 * a route rather than a script so the scenario can be run from a screen in
 * front of an audience instead of from a terminal.
 *
 * What it does NOT do is update anything. The corrected price supersedes the
 * old one, every affected day is revalued into a NEW run, and each affected
 * published return gets a NEW row pointing at the one it restates. Three
 * append-only supersessions; the original of each survives and stays
 * queryable.
 */

import { NextResponse } from 'next/server';
import { transaction } from '@/lib/db';
import { requireOps } from '@/lib/session';
import { applyCorrectedClose, publishReturn, restoreOriginalClose } from '@/lib/restatement';
import { resolvePrice } from '@/lib/providers/marketdata';
import { formatPercent } from '@/lib/returns';
import { formatCents } from '@/lib/money';
import Decimal from 'decimal.js';
import type { MarketDate } from '@/lib/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await requireOps();
  const body = (await request.json().catch(() => ({}))) as {
    action?: 'publish' | 'correct';
    symbol?: string;
    date?: string;
    /** Percentage move to apply to the existing close, e.g. -3.5 */
    pct?: number;
    periodStart?: string;
    note?: string;
  };

  const symbol = body.symbol ?? 'VOO';
  const date = (body.date ?? '2026-08-31') as MarketDate;

  try {
    // ---- publish the "before" figure ------------------------------------
    // Something must have been told to the customer before it can be restated.
    if (body.action === 'publish') {
      const periodStart = (body.periodStart ?? '2026-08-01') as MarketDate;

      const outcome = await transaction(async (client) => {
        // Publishing must record the figure as it stood BEFORE any correction,
        // or the correction that follows has nothing to change. If a previous
        // run left the corrected price in effect, put the original back first —
        // recorded as a scenario reset, never as a custodian correction.
        const reset = await restoreOriginalClose(client, { symbol, date });

        const { rows: customers } = await client.query<{
          id: string;
          legal_name: string;
        }>(
          `SELECT DISTINCT c.id, c.legal_name
             FROM customers c
             JOIN journal_lines l ON l.customer_id = c.id
            WHERE l.account_code = 'assets:positions' AND l.commodity = $1
              AND c.legal_name <> 'Invariant Probe'
            ORDER BY c.legal_name`,
          [symbol],
        );

        const out = [];
        for (const customer of customers) {
          const result = await publishReturn(client, {
            customerId: customer.id,
            periodStart,
            periodEnd: date,
          });
          out.push({
            customer: customer.legal_name,
            twr: formatPercent(result.twr),
            endValue: formatCents(result.endValueCents),
          });
        }
        return { published: out, reset };
      });

      return NextResponse.json({
        ok: true,
        action: 'publish',
        period: `${body.periodStart ?? '2026-08-01'} .. ${date}`,
        published: outcome.published,
        restoredOriginalClose: outcome.reset.restored
          ? {
              symbol,
              date,
              fromCents: outcome.reset.fromCents,
              toCents: outcome.reset.toCents,
              daysRevalued: outcome.reset.revalued,
              why:
                'A previous run had left the corrected close in effect. It was ' +
                'restored to the original so this published figure is a genuine ' +
                'pre-correction number. Recorded as a scenario reset, not as a ' +
                'custodian correction, and no already-published figure was restated.',
            }
          : null,
        note:
          'This is now what we have told the customer. It must remain answerable ' +
          'forever, whatever we learn afterwards.',
      });
    }

    // ---- the correction --------------------------------------------------
    const result = await transaction(async (client) => {
      const before = await resolvePrice(client, { symbol, asOf: date });
      if (!before) throw new Error(`no price for ${symbol} on ${date}`);

      const pct = body.pct ?? -3.5;

      // ANCHOR THE CORRECTION TO THE ORIGINAL CLOSE, NOT THE CURRENT ONE.
      //
      // "The custodian says the close was wrong by -3.5%" means wrong relative
      // to what was originally published. Computing it from the current price
      // instead made every press compound: pressing this button ten times
      // walked VOO's 2026-08-31 close from 56,405.97 down to 39,500.10 cents,
      // a 30% drift, and wrote eleven versions claiming the custodian had
      // corrected the same close ten separate times. Each individual row was
      // honest; the sequence described something that never happened.
      //
      // Anchored this way the operation is idempotent in value: press it once
      // or twenty times and the corrected close is the same number, so the
      // scenario can be demonstrated repeatedly without the demo drifting.
      const { rows: originalRows } = await client.query<{ price_cents: string }>(
        `SELECT price_cents FROM prices
          WHERE symbol = $1 AND price_date = $2::date AND NOT is_correction
          ORDER BY recorded_at ASC LIMIT 1`,
        [symbol, date],
      );
      const anchor = originalRows[0]
        ? new Decimal(originalRows[0].price_cents)
        : before.priceCents;

      const corrected = anchor.times(1 + pct / 100).toDecimalPlaces(6);

      // Already at the corrected value: say so rather than writing an identical
      // row that claims a fresh correction arrived.
      if (corrected.equals(before.priceCents)) {
        return {
          symbol,
          date,
          wasPrice: before.priceCents.div(100).toFixed(4),
          nowPrice: corrected.div(100).toFixed(4),
          pct,
          revaluedDays: 0,
          restated: [],
          alreadyCorrected: true,
          note:
            `${symbol}'s close on ${date} is already the corrected value ` +
            `(${corrected.div(100).toFixed(4)}, which is ${pct}% off the original ` +
            `${anchor.div(100).toFixed(4)}). Nothing was written: a second identical ` +
            `correction would claim the custodian reported again when it did not.`,
        };
      }

      const restatement = await applyCorrectedClose(client, {
        symbol,
        date,
        correctedPriceCents: corrected.toFixed(6),
        // State the percentage against the ORIGINAL, which is what it is
        // measured from. Saying "(-3.5%)" beside a transition that reads
        // 39500 -> 54431 invited exactly the question it should have answered.
        note:
          body.note ??
          `Custodian issued a corrected closing price: ${pct}% off the original ` +
            `close of ${anchor.div(100).toFixed(4)}.`,
      });

      return {
        symbol,
        date,
        wasPrice: before.priceCents.div(100).toFixed(4),
        nowPrice: corrected.div(100).toFixed(4),
        pct,
        revaluedDays: restatement.revaluedDates.length,
        restated: restatement.restated.map((r) => ({
          customer: r.customerName,
          period: `${r.periodStart} .. ${r.periodEnd}`,
          asPublished: formatPercent(r.asPublishedTwr),
          asCorrected: formatPercent(r.asCorrectedTwr),
          delta: formatPercent(r.asCorrectedTwr.minus(r.asPublishedTwr)),
          valueDelta: formatCents(
            r.asCorrectedEndValueCents - r.asPublishedEndValueCents,
          ),
        })),
      };
    });

    return NextResponse.json({
      ok: true,
      action: 'correct',
      by: session.email,
      ...result,
      note:
        'alreadyCorrected' in result && result.alreadyCorrected
          ? result.note
          : result.restated.length === 0
          ? 'Nothing had been published for a period ending on this date, so there ' +
            'was nothing to restate. Publish a return first.'
          : 'Nothing was updated. The corrected price supersedes the old row, each ' +
            'revalued day is a new run, and each restated return is a new row ' +
            'pointing at the one it replaces.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Exposed so the page can show a sensible default without hardcoding twice. */
export async function GET() {
  await requireOps();
  return NextResponse.json({
    defaults: { symbol: 'VOO', date: '2026-08-31', periodStart: '2026-08-01', pct: -3.5 },
    explanation:
      'The corrected date is the PERIOD END on purpose. Time-weighted return ' +
      'telescopes: with no external flows the chain collapses to ' +
      'end-value / start-value, so a correction to an interior date cannot move ' +
      'the cumulative figure. A correction to the period end can, and that is ' +
      'also the case that happens in practice.',
  });
}
