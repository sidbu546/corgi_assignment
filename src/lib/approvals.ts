/**
 * approvals.ts — maker-checker, with the execution path.
 *
 * Four rules, each enforced somewhere it cannot be bypassed:
 *
 *   1. THE INITIATOR CANNOT APPROVE. A CHECK constraint
 *      (`approvals_no_self_approval`) refuses `decided_by = requested_by` at the
 *      database. Not a code path — the invariants page proves it by trying.
 *
 *   2. AN AGENT CAN NEVER DECIDE. Enforced here: any decider identity prefixed
 *      `agent:` is refused. An agent may propose; it may not approve, and it may
 *      not approve a *human's* request either.
 *
 *   3. APPROVAL IS NOT EXECUTION. They are separate steps with separate
 *      timestamps. An approved withdrawal still has to be executed, and
 *      execution re-checks the funds — because cash can move between the moment
 *      a reviewer clicks approve and the moment money actually leaves.
 *
 *   4. EXECUTION IS IDEMPOTENT. An approval carries the id of the entry it
 *      produced. Executing twice is refused, so a double-click or a retried
 *      request cannot pay twice.
 */

import type { PoolClient } from 'pg';
import { postEntry, usd } from './ledger/post';
import { cashPosition } from './ledger/read';
import { formatCents, type Cents } from './money';

export const AGENT_PREFIX = 'agent:';

/** Money-out above this needs a second pair of eyes. */
export const APPROVAL_THRESHOLD_CENTS: Cents = 1_000_00n;

export class ApprovalError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'not_pending'
      | 'self_approval'
      | 'agent_cannot_decide'
      | 'already_executed'
      | 'insufficient_funds'
      | 'not_approved',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface ApprovalRow {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  amount_cents: bigint | null;
  customer_id: string | null;
  requested_by: string;
  requested_by_kind: 'human' | 'agent';
  status: string;
  decided_by: string | null;
  executed_entry_id: string | null;
}

async function load(client: PoolClient, id: string): Promise<ApprovalRow> {
  const { rows } = await client.query<ApprovalRow>(
    `SELECT id, action_type, payload, amount_cents, customer_id, requested_by,
            requested_by_kind, status::text AS status, decided_by,
            executed_entry_id
       FROM approvals WHERE id = $1::uuid`,
    [id],
  );
  if (!rows[0]) throw new ApprovalError('not_found', `no approval ${id}`);
  return rows[0];
}

/**
 * Approve or reject. Records WHO decided, and refuses the two identities that
 * must never decide: the requester, and any agent.
 */
export async function decideApproval(
  client: PoolClient,
  input: {
    approvalId: string;
    decidedBy: string;
    decision: 'approved' | 'rejected';
    note?: string;
  },
): Promise<ApprovalRow> {
  const approval = await load(client, input.approvalId);

  if (approval.status !== 'pending') {
    throw new ApprovalError(
      'not_pending',
      `approval is already ${approval.status}; a decision cannot be revisited`,
    );
  }

  // Rule 2, enforced before touching the database. The DB stops self-approval;
  // this stops an agent deciding at all, including on someone else's request.
  if (input.decidedBy.startsWith(AGENT_PREFIX)) {
    throw new ApprovalError(
      'agent_cannot_decide',
      'an agent may propose, never decide — this is the whole point of the queue',
    );
  }

  if (input.decidedBy === approval.requested_by) {
    // The CHECK constraint would refuse this anyway; failing here gives a
    // legible message instead of a constraint violation.
    throw new ApprovalError(
      'self_approval',
      `${input.decidedBy} raised this request and cannot also approve it`,
    );
  }

  const { rows } = await client.query<ApprovalRow>(
    `UPDATE approvals
        SET status = $2::approval_status, decided_by = $3, decided_at = now(),
            decision_note = $4
      WHERE id = $1::uuid AND status = 'pending'
      RETURNING id, action_type, payload, amount_cents, customer_id, requested_by,
                requested_by_kind, status::text AS status, decided_by,
                executed_entry_id`,
    [input.approvalId, input.decision, input.decidedBy, input.note ?? null],
  );

  if (!rows[0]) {
    throw new ApprovalError('not_pending', 'approval was decided by someone else first');
  }
  return rows[0];
}

export interface ExecutionResult {
  approvalId: string;
  entryId: string;
  amount: string;
  customerId: string;
}

/**
 * Execute an approved withdrawal.
 *
 * Deliberately a separate step from approval, and it re-checks the funds. Cash
 * can move between a reviewer clicking approve and money actually leaving —
 * a sell might settle, or another withdrawal might drain the balance — so the
 * balance is verified against the ledger at the moment of execution, not the
 * moment of approval.
 */
export async function executeApproval(
  client: PoolClient,
  input: { approvalId: string; executedBy: string },
): Promise<ExecutionResult> {
  const approval = await load(client, input.approvalId);

  if (approval.executed_entry_id) {
    throw new ApprovalError(
      'already_executed',
      `already executed as entry ${approval.executed_entry_id}; ` +
        `executing twice would pay twice`,
    );
  }
  if (approval.status !== 'approved') {
    throw new ApprovalError(
      'not_approved',
      `approval is ${approval.status}; only an approved request may be executed`,
    );
  }
  if (input.executedBy.startsWith(AGENT_PREFIX)) {
    throw new ApprovalError(
      'agent_cannot_decide',
      'an agent may not execute a money-out instruction',
    );
  }
  if (!approval.customer_id || approval.amount_cents === null) {
    throw new ApprovalError('not_found', 'approval is missing a customer or amount');
  }

  const amount = approval.amount_cents;

  // Re-check at execution time, against the ledger.
  const cash = await cashPosition(approval.customer_id);
  if (amount > cash.withdrawable) {
    throw new ApprovalError(
      'insufficient_funds',
      `withdrawable cash is ${formatCents(cash.withdrawable)}, ` +
        `but this instruction is for ${formatCents(amount)}. Approved, not paid — ` +
        `the balance is checked when money moves, not when it is approved.`,
    );
  }

  // Settled cash leaves; a payable to the customer is raised and immediately
  // discharged to the bank. Two entries would be more faithful if the rail were
  // slow, but the withdrawal payable is created and settled in the same breath
  // here because the instruction is what we are recording.
  const entry = await postEntry(client, {
    kind: 'withdrawal.executed',
    effectiveAt: new Date(),
    source: 'approval',
    sourceRef: approval.id,
    createdBy: input.executedBy,
    narrative:
      `Withdrawal of ${formatCents(amount)} executed. Requested by ` +
      `${approval.requested_by} (${approval.requested_by_kind}), approved by ` +
      `${approval.decided_by}.`,
    lines: [
      usd('assets:cash:settled', -amount, {
        customerId: approval.customer_id,
        memo: `approval ${approval.id}`,
      }),
      usd('equity:external:bank', amount),
    ],
  });

  await client.query(
    `UPDATE approvals SET status = 'executed', executed_entry_id = $2::uuid
      WHERE id = $1::uuid`,
    [approval.id, entry.id],
  );

  return {
    approvalId: approval.id,
    entryId: entry.id,
    amount: formatCents(amount),
    customerId: approval.customer_id,
  };
}

/** Everything in the queue, newest first, for the ops screen. */
export async function listApprovals(
  client: PoolClient,
  limit = 50,
): Promise<
  Array<{
    id: string;
    action_type: string;
    payload: Record<string, unknown>;
    amount_cents: bigint | null;
    customer_name: string | null;
    requested_by: string;
    requested_by_kind: string;
    status: string;
    decided_by: string | null;
    decided_at: Date | null;
    decision_note: string | null;
    executed_entry_id: string | null;
    requested_at: Date;
  }>
> {
  const { rows } = await client.query(
    `SELECT a.id, a.action_type, a.payload, a.amount_cents,
            c.legal_name AS customer_name,
            a.requested_by, a.requested_by_kind, a.status::text AS status,
            a.decided_by, a.decided_at, a.decision_note, a.executed_entry_id,
            a.requested_at
       FROM approvals a
       LEFT JOIN customers c ON c.id = a.customer_id
      ORDER BY a.requested_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows as never;
}
