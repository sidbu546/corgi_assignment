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
import { applyCorrectedClose, publishReturn } from '@/lib/restatement';
import { resolvePrice } from '@/lib/providers/marketdata';
import { formatPercent } from '@/lib/returns';
import { formatCents } from '@/lib/money';
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

      const published = await transaction(async (client) => {
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
        return out;
      });

      return NextResponse.json({
        ok: true,
        action: 'publish',
        period: `${body.periodStart ?? '2026-08-01'} .. ${date}`,
        published,
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
      const corrected = before.priceCents.times(1 + pct / 100).toDecimalPlaces(6);

      const restatement = await applyCorrectedClose(client, {
        symbol,
        date,
        correctedPriceCents: corrected.toFixed(6),
        note: body.note ?? `Custodian issued a corrected closing price (${pct}%).`,
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
        result.restated.length === 0
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
