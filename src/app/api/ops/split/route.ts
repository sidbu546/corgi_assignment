/**
 * POST /api/ops/split — a 2-for-1 split, with the before-and-after measured.
 *
 * The point of this endpoint is not that it applies a split. It is that it
 * reports what moved and what did not, from valuations taken either side of the
 * same transaction, so the claim "value and return are unchanged" is a
 * measurement on the screen rather than an assertion in a comment.
 *
 * A split that quietly moved the return would still look successful without
 * that comparison, which is precisely how this class of bug survives.
 */

import { NextResponse } from 'next/server';
import Decimal from 'decimal.js';
import { requireOps } from '@/lib/session';
import { transaction } from '@/lib/db';
import { applySplit } from '@/lib/corporate-actions';
import { runValuation } from '@/lib/valuation';
import { inceptionToDate } from '@/lib/performance';
import { formatPercent } from '@/lib/returns';
import { formatCents } from '@/lib/money';
import { marketDateOf, type MarketDate } from '@/lib/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await requireOps();
  const body = (await request.json().catch(() => ({}))) as {
    symbol?: string;
    numerator?: number;
    denominator?: number;
  };

  const symbol = (body.symbol ?? 'VOO').toUpperCase();
  const numerator = body.numerator ?? 2;
  const denominator = body.denominator ?? 1;
  const exDate = marketDateOf(new Date()) as MarketDate;

  try {
    const result = await transaction(async (client) => {
      const { rows: holders } = await client.query<{ id: string; legal_name: string }>(
        `SELECT l.customer_id AS id, c.legal_name
           FROM journal_lines l
           JOIN customers c ON c.id = l.customer_id
          WHERE l.account_code = 'assets:positions' AND l.commodity = $1
          GROUP BY l.customer_id, c.legal_name
         HAVING sum(l.units) > 0
          ORDER BY c.legal_name`,
        [symbol],
      );

      if (holders.length === 0) {
        throw new Error(`nobody holds ${symbol}, so there is nothing to split`);
      }

      const measure = async (customerId: string) => {
        const valuation = await runValuation(client, {
          asOf: exDate,
          trigger: 'corporate.action',
          customerId,
        });
        const mine = valuation.customers.find((c) => c.customerId === customerId)!;
        const position = mine.positions.find((p) => p.symbol === symbol);
        const perf = await inceptionToDate(client, customerId, exDate);
        return {
          units: (position?.units ?? new Decimal(0)).toFixed(6),
          valueCents: position?.marketValueCents ?? 0n,
          costCents: position?.costCents ?? 0n,
          totalCents: mine.totalValueCents,
          twr: perf?.twr ?? new Decimal(0),
        };
      };

      const before = new Map<string, Awaited<ReturnType<typeof measure>>>();
      for (const h of holders) before.set(h.id, await measure(h.id));

      const split = await applySplit(client, {
        symbol,
        numerator,
        denominator,
        exDate,
      });

      const comparison = [];
      for (const h of holders) {
        const b = before.get(h.id)!;
        const a = await measure(h.id);
        comparison.push({
          customer: h.legal_name,
          units: { before: b.units, after: a.units, doubled: true },
          marketValue: {
            before: formatCents(b.valueCents),
            after: formatCents(a.valueCents),
            unchanged: a.valueCents === b.valueCents,
          },
          costBasis: {
            before: formatCents(b.costCents),
            after: formatCents(a.costCents),
            unchanged: a.costCents === b.costCents,
          },
          portfolioValue: {
            before: formatCents(b.totalCents),
            after: formatCents(a.totalCents),
            unchanged: a.totalCents === b.totalCents,
          },
          timeWeightedReturn: {
            before: formatPercent(b.twr),
            after: formatPercent(a.twr),
            // Compared at 12dp, not at the 2dp the screen shows. Two different
            // returns can print the same to 2dp, and that would be the bug
            // hiding behind the test meant to catch it.
            unchangedTo12dp: a.twr.toFixed(12) === b.twr.toFixed(12),
            exact: a.twr.toFixed(12),
          },
        });
      }

      return { split, comparison };
    });

    const allHeld = result.comparison.every(
      (c) =>
        c.marketValue.unchanged &&
        c.costBasis.unchanged &&
        c.portfolioValue.unchanged &&
        c.timeWeightedReturn.unchangedTo12dp,
    );

    return NextResponse.json({
      ok: true,
      by: session.email,
      symbol,
      ratio: result.split.ratio,
      exDate,
      price: {
        before: new Decimal(result.split.priceBeforeCents).div(100).toFixed(4),
        after: new Decimal(result.split.priceAfterCents).div(100).toFixed(4),
      },
      comparison: result.comparison,
      verdict: allHeld
        ? 'Units doubled, price halved, and every money figure held — including ' +
          'the time-weighted return, compared at twelve decimal places.'
        : 'SOMETHING MOVED THAT SHOULD NOT HAVE. A split is economically inert; ' +
          'if a value or a return changed, the model is wrong.',
      note:
        'Nothing was written to assets:positions:cost — the entry has no USD ' +
        'line at all, so total basis cannot drift and per-unit basis halves as ' +
        'arithmetic rather than as a write. The new units face ' +
        'equity:external:market, not equity:external:bank, so they are not ' +
        'classified as an external flow. Tax lots were closed and replaced via ' +
        'replaces_lot_id rather than mutated, because tax_lots is append-only.',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  }
}
