/**
 * agent-demo.ts — exercise the agent surface and prove its boundaries.
 *
 * Calls all four MCP tools directly (same functions the MCP server exposes),
 * then asserts the things that must NOT be possible:
 *
 *   - an agent cannot approve its own proposal
 *   - an agent cannot approve anything at all
 *   - a human cannot approve their own request either
 *   - an approved instruction still has to be executed, and execution
 *     re-checks the balance
 *   - executing twice is refused
 *
 * Run: npm run agent-demo
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import {
  explainBalance,
  getPortfolio,
  listBreaks,
  proposeWithdrawal,
} from '../src/lib/agent/tools';
import {
  ApprovalError,
  decideApproval,
  executeApproval,
} from '../src/lib/approvals';

const CUSTOMER = process.argv[2] ?? 'dana@demo.ledgerly.app';
const AGENT = 'agent:demo';
const MAKER = 'ops@demo.ledgerly.app';
const CHECKER = 'approver@demo.ledgerly.app';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

async function expectRefusal(
  label: string,
  expectedCode: string,
  fn: () => Promise<unknown>,
) {
  try {
    await fn();
    check(label, false, 'it was ALLOWED — this is a real problem');
  } catch (error) {
    const code = error instanceof ApprovalError ? error.code : 'unknown';
    check(
      label,
      code === expectedCode,
      `${code}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 4,
  });
  const client = await pool.connect();

  try {
    console.log('\n=== READ TOOLS ===\n');

    const portfolio = await getPortfolio(client, { customer: CUSTOMER });
    check('get_portfolio returns holdings and cash', Array.isArray(portfolio.positions));
    console.log(
      `        ${(portfolio.customer as { name: string }).name} · ` +
        `total ${portfolio.totalValue} · TWR ${portfolio.timeWeightedReturn}`,
    );
    console.log(
      `        cash: ${JSON.stringify(
        (portfolio.cash as Record<string, string>).withdrawable,
      )} withdrawable, ` +
        `${(portfolio.cash as Record<string, string>).pendingDeposits} in flight`,
    );

    const explained = await explainBalance(client, {
      customer: CUSTOMER,
      account: 'assets:cash:settled',
      limit: 3,
    });
    check(
      'explain_balance returns the journal lines behind a figure',
      Array.isArray(explained.entries),
      `${(explained.entries as unknown[]).length} entries returned`,
    );

    const breaks = await listBreaks(client, {});
    check(
      'list_reconciliation_breaks returns classified breaks',
      Array.isArray(breaks.breaks),
      `${(breaks.breaks as unknown[]).length} open break(s)`,
    );

    console.log('\n=== WRITE TOOL — proposes, does not move money ===\n');

    const before = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries`,
    );

    const proposal = await proposeWithdrawal(client, {
      customer: CUSTOMER,
      amount: '2500.00',
      reason: 'Customer asked to withdraw spare cash',
      agentId: AGENT,
    });

    const after = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM journal_entries`,
    );

    check('propose_withdrawal creates a PENDING approval', proposal.status === 'pending');
    check(
      'it wrote NO journal entry',
      before.rows[0].n === after.rows[0].n,
      `journal entries before ${before.rows[0].n}, after ${after.rows[0].n}`,
    );
    check('it is flagged as requiring human approval', proposal.requiresHumanApproval === true);

    console.log('\n=== THE BOUNDARIES ===\n');

    await expectRefusal(
      'an agent cannot approve its own proposal',
      'agent_cannot_decide',
      () =>
        decideApproval(client, {
          approvalId: proposal.approvalId,
          decidedBy: AGENT,
          decision: 'approved',
        }),
    );

    await expectRefusal(
      'an agent cannot approve anything, even another party’s request',
      'agent_cannot_decide',
      () =>
        decideApproval(client, {
          approvalId: proposal.approvalId,
          decidedBy: 'agent:someone-else',
          decision: 'approved',
        }),
    );

    await expectRefusal(
      'an unapproved instruction cannot be executed',
      'not_approved',
      () =>
        executeApproval(client, {
          approvalId: proposal.approvalId,
          executedBy: CHECKER,
        }),
    );

    // A human raises one, so self-approval can be tested on the human path too.
    //
    // The row is deleted again once the probe has run. It needs to exist for
    // the constraint to refuse a decision on it; the queue does not need to
    // keep it. Leaving it behind put HUMAN cards into a console whose only way
    // to raise anything is the agent, so the screen contradicted the very rule
    // it was demonstrating. Deleting is safe here and only here: the row was
    // never decided and never executed, so no journal entry refers to it.
    const { rows: humanRows } = await client.query<{ id: string }>(
      `INSERT INTO approvals
         (action_type, payload, amount_cents, customer_id, requested_by,
          requested_by_kind, status)
       SELECT 'withdrawal', '{"note":"human-raised"}'::jsonb, 150000, c.id, $1,
              'human', 'pending'
         FROM customers c WHERE c.email = $2
       RETURNING id`,
      [MAKER, CUSTOMER],
    );

    await expectRefusal(
      'a human cannot approve their own request',
      'self_approval',
      () =>
        decideApproval(client, {
          approvalId: humanRows[0].id,
          decidedBy: MAKER,
          decision: 'approved',
        }),
    );
    await client.query('DELETE FROM approvals WHERE id = $1::uuid', [humanRows[0].id]);

    console.log('\n=== THE HAPPY PATH: a different human approves, then executes ===\n');

    const decided = await decideApproval(client, {
      approvalId: proposal.approvalId,
      decidedBy: CHECKER,
      decision: 'approved',
      note: 'Reviewed; within withdrawable cash.',
    });
    check(
      'a different human can approve an agent’s proposal',
      decided.status === 'approved',
      `requested by ${decided.requested_by} (${decided.requested_by_kind}), approved by ${decided.decided_by}`,
    );

    // Inside an explicit transaction, because executeApproval posts a journal
    // entry and the balance trigger is DEFERRED — it fires at COMMIT. Run in
    // autocommit, each line inserts and commits on its own and the trigger sees
    // a one-legged entry. Production goes through db.transaction() for exactly
    // this reason; the harness has to do the same.
    await client.query('BEGIN');
    const executed = await executeApproval(client, {
      approvalId: proposal.approvalId,
      executedBy: CHECKER,
    });
    await client.query('COMMIT');
    check(
      'execution posts a journal entry',
      Boolean(executed.entryId),
      `${executed.amount} — entry ${executed.entryId}`,
    );

    await expectRefusal(
      'executing the same approval twice is refused',
      'already_executed',
      async () => {
        await client.query('BEGIN');
        try {
          await executeApproval(client, {
            approvalId: proposal.approvalId,
            executedBy: CHECKER,
          });
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    );

    const { rows: tb } = await client.query<{ cents: bigint | null }>(
      `SELECT sum(amount_cents)::bigint AS cents FROM journal_lines WHERE commodity = 'USD'`,
    );
    check(
      'the ledger still balances after the payout',
      (tb[0].cents ?? 0n) === 0n,
      `USD nets to ${tb[0].cents}`,
    );

    console.log(`\n${'='.repeat(72)}`);
    if (failures > 0) {
      console.log(`${failures} check(s) FAILED`);
      process.exit(1);
    }
    console.log(
      'An agent may read anything and propose anything. It may not decide, move, or erase.',
    );
    console.log(
      `\nThe queue is left clean: the human-raised probe is deleted once it has` +
        `\nbeen refused, so no HUMAN card is left in a console whose only way to` +
        `\nraise anything is the agent. To put a real request in front of a` +
        `\nchecker, use the ops console — enter an amount and the agent raises it.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nagent demo crashed:\n', error);
  process.exit(1);
});
