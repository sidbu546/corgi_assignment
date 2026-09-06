/**
 * agent/tools.ts — what an agent may do, and what it may never do.
 *
 * Three read tools and one write tool. The write tool does not write money: it
 * creates a PROPOSAL that a human must approve. That asymmetry is the whole
 * design, and it is enforced in three independent places:
 *
 *   1. here            — the agent surface has no function that posts a journal
 *                        entry, places an order, or approves anything
 *   2. the queue       — every agent proposal is stamped
 *                        requested_by_kind = 'agent'
 *   3. the database    — `approvals_no_self_approval` is a CHECK constraint, so
 *                        even a compromised caller cannot approve its own
 *                        request, and the executor refuses any approval whose
 *                        decider is an agent identity
 *
 * WHAT I WOULD NEVER HAND AN AUTONOMOUS AGENT, and why. This list is the point
 * of the exercise, not a footnote:
 *
 *   Approving or executing anything it proposed.
 *     Maker-checker collapses the moment the maker can also check. An agent
 *     that can approve its own proposal is not a controlled agent, it is an
 *     unsupervised one with extra steps.
 *
 *   Moving money out — withdrawals, transfers, payouts.
 *     Irreversible, and the failure mode is unbounded. Proposing is safe
 *     because a human sees the amount and the destination before it moves.
 *
 *   Placing orders directly.
 *     A fill is irreversible and moves real positions. A mispriced or
 *     misquantified order cannot be recalled, and "the model said so" is not a
 *     defence to a customer.
 *
 *   Writing journal entries.
 *     The ledger is the record of truth. Anything that can write to it
 *     unsupervised can rewrite what is true, which defeats every other control
 *     in this system.
 *
 *   Issuing corrected prices or restating published figures.
 *     A restatement changes what a customer was told. That is a decision with
 *     regulatory weight and it needs a name attached to it.
 *
 *   Changing KYC status, or anything that opens the transacting gate.
 *     The gate exists to stop unverified people moving money. An agent that can
 *     open it has removed the control entirely.
 *
 *   Disabling a provider, or any configuration that changes what is real.
 *     The kill switch is an operational decision with customer impact.
 *
 *   Resolving reconciliation breaks.
 *     Reading them is useful; closing them is how a genuine break gets buried.
 *     An agent that can mark a break resolved can hide the exact thing the
 *     screen exists to surface.
 *
 * The general rule the list encodes: an agent may READ anything and PROPOSE
 * anything, but may not DECIDE, MOVE or ERASE.
 */

import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { accountBalances, cashPosition, positions, linesFor } from '../ledger/read';
import { performance } from '../performance';
import { formatCents, formatUnits, dollarsToCents } from '../money';
import { assertAboveThreshold } from '../approvals';
import { formatPercent } from '../returns';
import { resolvePrice } from '../providers/marketdata';
import { marketDateOf, type MarketDate } from '../calendar';

export const AGENT_IDENTITY_PREFIX = 'agent:';

/** Operations deliberately absent from this surface, surfaced to the UI. */
export const NEVER_FOR_AGENTS: Array<{ operation: string; why: string }> = [
  {
    operation: 'Approve or execute anything',
    why:
      'Maker-checker collapses the moment the maker can also check. An agent ' +
      'that can approve its own proposal is an unsupervised agent with extra steps.',
  },
  {
    operation: 'Move money out — withdrawals, transfers, payouts',
    why:
      'Irreversible, with an unbounded failure mode. Proposing is safe because a ' +
      'human sees the amount and the destination before anything moves.',
  },
  {
    operation: 'Place an order directly',
    why:
      'A fill is irreversible and moves real positions. A mispriced order cannot ' +
      'be recalled, and "the model said so" is not a defence to a customer.',
  },
  {
    operation: 'Write a journal entry',
    why:
      'The ledger is the record of truth. Anything that writes to it unsupervised ' +
      'can rewrite what is true, defeating every other control in the system.',
  },
  {
    operation: 'Issue a corrected price or restate a published figure',
    why:
      'A restatement changes what a customer was told. That decision carries ' +
      'regulatory weight and needs a human name attached to it.',
  },
  {
    operation: 'Change KYC status, or anything that opens the transacting gate',
    why:
      'The gate exists to stop unverified people moving money. An agent that can ' +
      'open it has removed the control entirely.',
  },
  {
    operation: 'Disable a provider or change what is real vs simulated',
    why: 'An operational decision with direct customer impact.',
  },
  {
    operation: 'Resolve a reconciliation break',
    why:
      'Reading breaks is useful; closing them is how a genuine break gets buried. ' +
      'An agent that can mark a break resolved can hide the thing the screen ' +
      'exists to surface.',
  },
];

// -----------------------------------------------------------------------------
// Read tools
// -----------------------------------------------------------------------------

async function resolveCustomer(
  client: PoolClient,
  identifier: string,
): Promise<{ id: string; legal_name: string; email: string }> {
  const { rows } = await client.query<{
    id: string;
    legal_name: string;
    email: string;
  }>(
    `SELECT id, legal_name, email FROM customers
      WHERE email = $1 OR legal_name ILIKE $1
         OR ($1 ~ '^[0-9a-f-]{36}$' AND id = $1::uuid)
      LIMIT 1`,
    [identifier],
  );
  if (!rows[0]) throw new Error(`no customer matching "${identifier}"`);
  return rows[0];
}

/** TOOL 1 — what does this customer hold, and what is it worth? */
export async function getPortfolio(
  client: PoolClient,
  input: { customer: string; asOf?: MarketDate },
): Promise<Record<string, unknown>> {
  const customer = await resolveCustomer(client, input.customer);
  const asOf = input.asOf ?? marketDateOf(new Date());

  const cash = await cashPosition(customer.id, { asOf: new Date(`${asOf}T23:59:59Z`) });
  const held = await positions(customer.id, { asOf: new Date(`${asOf}T23:59:59Z`) });

  const rows = [];
  let marketValue = 0n;
  for (const p of held) {
    const price = await resolvePrice(client, { symbol: p.symbol, asOf });
    const value = price
      ? BigInt(p.units.times(price.priceCents).toDecimalPlaces(0).toFixed(0))
      : null;
    if (value !== null) marketValue += value;
    rows.push({
      symbol: p.symbol,
      units: formatUnits(p.units),
      costBasis: formatCents(p.costCents),
      price: price ? `$${price.priceCents.div(100).toFixed(4)}` : null,
      priceDate: price?.priceDate ?? null,
      priceAgeDays: price?.ageDays ?? null,
      marketValue: value !== null ? formatCents(value) : 'unpriced',
      unrealised: value !== null ? formatCents(value - p.costCents) : null,
    });
  }

  const perf = await performance(client, {
    customerId: customer.id,
    from: '2026-06-01' as MarketDate,
    to: asOf,
  }).catch(() => null);

  return {
    customer: { name: customer.legal_name, email: customer.email },
    asOf,
    cash: {
      settled: formatCents(cash.settled),
      unsettledProceeds: formatCents(cash.unsettledProceeds),
      pendingDeposits: formatCents(cash.pendingDeposits),
      withdrawable: formatCents(cash.withdrawable),
      investable: formatCents(cash.investable),
      note:
        'Withdrawable is settled cash only. Pending deposits are excluded from ' +
        'portfolio value — money that has not cleared is not money.',
    },
    positions: rows,
    positionsMarketValue: formatCents(marketValue),
    totalValue: formatCents(marketValue + cash.settled + cash.unsettledProceeds),
    timeWeightedReturn: perf ? formatPercent(perf.twr) : null,
  };
}

/** TOOL 2 — the journal lines behind a balance. The drill-down, for agents. */
export async function explainBalance(
  client: PoolClient,
  input: { customer?: string; account?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const customer = input.customer
    ? await resolveCustomer(client, input.customer)
    : null;

  const lines = await linesFor({
    customerId: customer?.id,
    accounts: input.account ? [input.account] : undefined,
    limit: Math.min(input.limit ?? 25, 100),
  });

  // accountBalances, not trialBalance: a trial balance nets to zero across the
  // whole firm, so one scoped to a single customer is a category error — the
  // house accounts that make it balance are, correctly, not theirs.
  const balances = await accountBalances({
    customerId: customer?.id,
    accounts: input.account ? [input.account] : undefined,
  });

  return {
    customer: customer?.legal_name ?? 'all customers',
    account: input.account ?? 'all accounts',
    balances: balances.map((r) => ({
      account: r.account,
      commodity: r.commodity,
      amount: r.commodity === 'USD' ? formatCents(r.cents) : formatUnits(r.units),
    })),
    entries: lines.map((l) => ({
      entryId: l.entryId,
      kind: l.kind,
      effectiveAt: l.effectiveAt,
      recordedAt: l.recordedAt,
      account: l.account,
      commodity: l.commodity,
      amount:
        l.commodity === 'USD'
          ? formatCents(l.cents ?? 0n)
          : formatUnits(l.units ?? new Decimal(0)),
      narrative: l.narrative,
      isReversal: l.reversesEntryId !== null,
      isRebook: l.correctsEntryId !== null,
    })),
    note:
      'Every balance in this system is a fold over these lines. effective_at is ' +
      'when it economically happened; recorded_at is when we learned it.',
  };
}

/** TOOL 3 — open reconciliation breaks, classified and aged. */
export async function listBreaks(
  client: PoolClient,
  input: { includeResolved?: boolean } = {},
): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{
    legal_name: string;
    break_type: string;
    classification: string;
    symbol: string | null;
    ours_units: string | null;
    theirs_units: string | null;
    ours_cents: bigint | null;
    theirs_cents: bigint | null;
    first_seen_at: Date;
    expected_clear_date: string | null;
    detail: string;
    resolved_at: Date | null;
  }>(
    `SELECT c.legal_name, b.break_type, b.classification, b.symbol,
            b.ours_units, b.theirs_units, b.ours_cents, b.theirs_cents,
            b.first_seen_at,
            to_char(b.expected_clear_date, 'YYYY-MM-DD') AS expected_clear_date,
            b.detail, b.resolved_at
       FROM recon_breaks b
       JOIN customers c ON c.id = b.customer_id
       JOIN recon_runs r ON r.id = b.run_id
      WHERE r.id IN (SELECT DISTINCT ON (as_of_date) id FROM recon_runs
                      ORDER BY as_of_date DESC, started_at DESC)
        AND ($1::boolean OR b.resolved_at IS NULL)
      ORDER BY
        CASE WHEN b.classification LIKE 'genuine.%' THEN 0
             WHEN b.classification LIKE 'unbooked.%' THEN 1 ELSE 2 END,
        b.first_seen_at`,
    [input.includeResolved ?? false],
  );

  return {
    breaks: rows.map((b) => ({
      customer: b.legal_name,
      classification: b.classification,
      severity: b.classification.startsWith('genuine.')
        ? 'critical'
        : b.classification.startsWith('unbooked.')
          ? 'actionable'
          : 'timing',
      symbol: b.symbol,
      ours: b.ours_units ?? (b.ours_cents !== null ? formatCents(b.ours_cents) : null),
      custodian:
        b.theirs_units ?? (b.theirs_cents !== null ? formatCents(b.theirs_cents) : null),
      ageDays: Math.floor((Date.now() - b.first_seen_at.getTime()) / 86_400_000),
      expectedClearDate: b.expected_clear_date,
      detail: b.detail,
    })),
    note:
      'Read-only. An agent cannot resolve a break — closing them is how a genuine ' +
      'break gets buried.',
  };
}

// -----------------------------------------------------------------------------
// The one write tool. It does not move money.
// -----------------------------------------------------------------------------

export interface ProposalResult {
  approvalId: string;
  status: 'pending';
  requiresHumanApproval: true;
  [key: string]: unknown;
}

/**
 * TOOL 4 — propose a withdrawal. Creates a PENDING approval and nothing else.
 *
 * No journal entry is written, no transfer is created, no money moves. A human
 * with a different identity must approve it, and only then does the executor
 * post anything.
 */
export async function proposeWithdrawal(
  client: PoolClient,
  input: { customer: string; amount: string; reason?: string; agentId: string },
): Promise<ProposalResult> {
  if (!input.agentId.startsWith(AGENT_IDENTITY_PREFIX)) {
    throw new Error(
      `agent identity must start with "${AGENT_IDENTITY_PREFIX}" so the approval ` +
        `queue can tell a proposal from a human request`,
    );
  }

  const customer = await resolveCustomer(client, input.customer);
  // The same rule the human path uses, and the same the CHECK constraint
  // enforces: money-out enters the queue only above the threshold.
  const amountCents = dollarsToCents(input.amount);
  assertAboveThreshold(amountCents);

  // Check it against withdrawable cash NOW, so the proposal carries the
  // information a reviewer needs rather than making them go and look.
  const cash = await cashPosition(customer.id);
  const exceedsWithdrawable = amountCents > cash.withdrawable;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO approvals
       (action_type, payload, amount_cents, customer_id, requested_by,
        requested_by_kind, status)
     VALUES ('withdrawal', $1::jsonb, $2, $3::uuid, $4, 'agent', 'pending')
     RETURNING id`,
    [
      JSON.stringify({
        customer: customer.legal_name,
        customerEmail: customer.email,
        amount: formatCents(amountCents),
        amountCents: amountCents.toString(),
        reason: input.reason ?? null,
        withdrawableAtProposalTime: formatCents(cash.withdrawable),
        exceedsWithdrawable,
      }),
      amountCents.toString(),
      customer.id,
      input.agentId,
    ],
  );

  return {
    approvalId: rows[0].id,
    status: 'pending',
    requiresHumanApproval: true,
    customer: customer.legal_name,
    amount: formatCents(amountCents),
    withdrawableNow: formatCents(cash.withdrawable),
    warning: exceedsWithdrawable
      ? `This exceeds withdrawable cash of ${formatCents(cash.withdrawable)}. ` +
        `It has still been queued — the reviewer decides, not the agent — but it ` +
        `will be refused at execution unless funds settle first.`
      : null,
    note:
      'Nothing has moved. No journal entry was written and no transfer was ' +
      'created. A human with a different identity must approve this, and the ' +
      'database refuses self-approval as a CHECK constraint.',
  };
}
