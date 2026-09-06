/**
 * POST /api/ops/run-recon — the morning reconciliation, on demand.
 *
 * WHY THIS EXISTS. Valuation runs on every /portfolio load and restatement has
 * had buttons since it was built, so both can be watched happening. Recon could
 * only ever be run from a terminal, which meant the one step the brief
 * describes as a daily operation — "reconcile against the custodian every
 * morning" — was the one step nobody could see performed. A screen that only
 * ever shows yesterday's stored rows looks like a report, not an operation.
 *
 *   { mode: 'clean' }   ask the custodian for the real picture. Should agree.
 *   { mode: 'plant' }   inject the anomalies from the debrief, so the
 *                       classifier has something to classify.
 *
 * THE CLEAN RUN IS THE IMPORTANT ONE. A reconciliation that reports noise when
 * nothing is wrong trains everyone to ignore it, and then it is worthless on
 * the morning something is genuinely broken. So both modes are offered and the
 * clean one is the default.
 *
 * This writes recon_runs and recon_breaks. It touches no money row: recon
 * observes the ledger, it never corrects it. Deciding what to do about a break
 * is a separate, human, maker-checker decision.
 */

import { NextResponse } from 'next/server';
import { requireOps } from '@/lib/session';
import { transaction } from '@/lib/db';
import { marketDateOf } from '@/lib/calendar';
import { debriefAnomalies, generateFile } from '@/lib/providers/custodian';
import { reconcile, severity } from '@/lib/recon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await requireOps();
  const body = (await request.json().catch(() => ({}))) as { mode?: 'clean' | 'plant' };
  const plant = body.mode === 'plant';
  const asOf = marketDateOf(new Date());

  try {
    const result = await transaction(async (client) => {
      const { rows: customers } = await client.query<{ id: string; legal_name: string }>(
        `SELECT DISTINCT c.id, c.legal_name
           FROM customers c
           JOIN journal_lines l ON l.customer_id = c.id
          WHERE c.legal_name <> 'Invariant Probe'
          ORDER BY c.legal_name`,
      );

      const perCustomer: Array<{
        customer: string;
        positionsChecked: number;
        clean: boolean;
        planted: string[];
        breaks: Array<{ severity: string; classification: string; detail: string }>;
      }> = [];

      let totalBreaks = 0;
      let totalPositions = 0;

      for (const customer of customers) {
        const file = await generateFile(client, {
          customerId: customer.id,
          asOf,
          anomalies: plant ? debriefAnomalies('VOO') : undefined,
        });

        const run = await reconcile(client, { customerId: customer.id, asOf, file });

        totalBreaks += run.breaks.length;
        totalPositions += run.positionsChecked;

        perCustomer.push({
          customer: customer.legal_name,
          positionsChecked: run.positionsChecked,
          clean: run.clean,
          planted: file._injected,
          breaks: run.breaks.map((b) => ({
            severity: severity(b.classification),
            classification: b.classification,
            detail: b.detail,
          })),
        });
      }

      return { asOf, customers: perCustomer, totalBreaks, totalPositions };
    });

    return NextResponse.json({
      ok: true,
      asOf: result.asOf,
      mode: plant ? 'plant' : 'clean',
      ranBy: session.email,
      customersReconciled: result.customers.length,
      positionsChecked: result.totalPositions,
      breaksFound: result.totalBreaks,
      summary:
        result.totalBreaks === 0
          ? 'No breaks. Our ledger and the custodian agree.'
          : `${result.totalBreaks} break(s) surfaced and classified.`,
      note: plant
        ? 'Anomalies were injected into the custodian file before diffing, so the ' +
          'classifier has something to classify. The injections are listed per ' +
          'customer below — nothing was hidden.'
        : 'The custodian file was generated from the real position picture. A clean ' +
          'run producing zero breaks is the important half: a reconciliation that ' +
          'cries wolf is ignored on the morning it matters.',
      detail: result.customers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
