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
  APPROVAL_THRESHOLD_CENTS,
  ApprovalError,
  decideApproval,
  executeApproval,
} from '../src/lib/approvals';
import { formatCents } from '../src/lib/money';

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
      amount: '250.00',
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

    // A human raises one, so the threshold can be tested on the human path in
    // BOTH directions. It is not enough to prove the control refuses; a control
    // that refuses everything is indistinguishable from one that is stuck on.
    const raiseHuman = async (amountCents: bigint): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO approvals
           (action_type, payload, amount_cents, customer_id, requested_by,
            requested_by_kind, status)
         SELECT 'withdrawal', '{"note":"human-raised"}'::jsonb, $3, c.id, $1,
                'human', 'pending'
           FROM customers c WHERE c.email = $2
         RETURNING id`,
        [MAKER, CUSTOMER, amountCents.toString()],
      );
      return rows[0].id;
    };

    const overThreshold = await raiseHuman(APPROVAL_THRESHOLD_CENTS + 1n);
    await expectRefusal(
      `above ${formatCents(APPROVAL_THRESHOLD_CENTS)}, a human cannot approve their own request`,
      'self_approval',
      () =>
        decideApproval(client, {
          approvalId: overThreshold,
          decidedBy: MAKER,
          decision: 'approved',
        }),
    );

    const underThreshold = await raiseHuman(APPROVAL_THRESHOLD_CENTS);
    const selfDecided = await decideApproval(client, {
      approvalId: underThreshold,
      decidedBy: MAKER,
      decision: 'approved',
      note: 'At or under the threshold, one pair of eyes is the stated policy.',
    });
    check(
      `at or under ${formatCents(APPROVAL_THRESHOLD_CENTS)}, one human may decide their own request`,
      selfDecided.status === 'approved' && selfDecided.decided_by === MAKER,
      'the threshold relaxes as well as refuses — otherwise it is not a threshold',
    );

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

    // ---------------------------------------------------------------------
    // Leave one behind, PENDING, for the browser.
    //
    // Everything above proves the boundaries and then consumes its own
    // evidence: the agent's proposal is approved and executed as part of the
    // happy path, so nothing agent-raised survives in the queue. The single
    // most important state to be able to SHOW — an agent has asked, a human
    // must decide — was the one state /approvals could never display.
    // ---------------------------------------------------------------------
    const standing = await proposeWithdrawal(client, {
      customer: CUSTOMER,
      amount: '150',
      reason: 'left pending on purpose, so the queue always has a live example',
      agentId: AGENT,
    });
    check(
      'a pending agent proposal is left in the queue for the browser',
      standing.status === 'pending',
      'visit /approvals as ops to approve and execute it — that is the maker-checker demo',
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
      `\nOne agent proposal for $150.00 is now PENDING in /approvals. Sign in as` +
        `\n${MAKER} and you will be able to approve it: you did not raise it, the` +
        `\nagent did, and an agent proposal always needs a human at any amount.`,
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
