/**
 * POST /api/approvals — decide or execute a queued instruction. Ops only.
 *
 * The identity that decides is taken from the SESSION, never from the request
 * body. A caller-supplied "decidedBy" would make maker-checker decorative:
 * anyone could claim to be someone else and satisfy the "different identity"
 * rule trivially.
 */

import { NextResponse } from 'next/server';
import { transaction } from '@/lib/db';
import { requireOps } from '@/lib/session';
import { ApprovalError, decideApproval, executeApproval } from '@/lib/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await requireOps();
  const body = (await request.json().catch(() => ({}))) as {
    approvalId?: string;
    action?: 'approve' | 'reject' | 'execute';
    note?: string;
  };

  if (!body.approvalId || !body.action) {
    return NextResponse.json(
      { error: 'approvalId and action are required' },
      { status: 400 },
    );
  }

  try {
    if (body.action === 'execute') {
      const result = await transaction((client) =>
        executeApproval(client, {
          approvalId: body.approvalId!,
          // From the session. Never from the body.
          executedBy: session.email,
        }),
      );
      return NextResponse.json({
        ok: true,
        ...result,
        note:
          'Money moved, and the journal entry names both the requester and the ' +
          'approver. Executing again is refused — the approval carries the id of ' +
          'the entry it produced.',
      });
    }

    const decision = body.action === 'approve' ? 'approved' : 'rejected';
    const result = await transaction((client) =>
      decideApproval(client, {
        approvalId: body.approvalId!,
        decidedBy: session.email,
        decision,
        note: body.note,
      }),
    );

    return NextResponse.json({
      ok: true,
      approvalId: result.id,
      status: result.status,
      decidedBy: result.decided_by,
      requestedBy: result.requested_by,
      requestedByKind: result.requested_by_kind,
      note:
        decision === 'approved'
          ? 'Approved but NOT paid. Execution is a separate step and re-checks the ' +
            'balance, because cash can move between approval and payment.'
          : 'Rejected. Nothing moved.',
    });
  } catch (error) {
    if (error instanceof ApprovalError) {
      const status =
        error.code === 'not_found'
          ? 404
          : error.code === 'self_approval' || error.code === 'agent_cannot_decide'
            ? 403
            : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
