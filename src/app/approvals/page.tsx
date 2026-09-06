import { withClient } from '@/lib/db';
import { requireOps } from '@/lib/session';
import { listApprovals, APPROVAL_THRESHOLD_CENTS } from '@/lib/approvals';
import { NEVER_FOR_AGENTS } from '@/lib/agent/tools';
import { formatCents } from '@/lib/money';
import ApprovalsClient, { type QueueRow } from './ApprovalsClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await requireOps();

  const rows = await withClient((client) => listApprovals(client, 50));

  const queue: QueueRow[] = rows.map((r) => ({
    id: r.id,
    action_type: r.action_type,
    amount: r.amount_cents !== null ? formatCents(r.amount_cents) : null,
    customer_name: r.customer_name,
    requested_by: r.requested_by,
    requested_by_kind: r.requested_by_kind,
    status: r.status,
    decided_by: r.decided_by,
    decision_note: r.decision_note,
    executed_entry_id: r.executed_entry_id,
    requested_at: new Date(r.requested_at).toISOString(),
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));

  const pending = queue.filter((q) => q.status === 'pending').length;
  const fromAgents = queue.filter((q) => q.requested_by_kind === 'agent').length;

  return (
    <>
      <h1>Approvals</h1>
      <p className="lede">
        Money-out above{' '}
        <span className="mono">{formatCents(APPROVAL_THRESHOLD_CENTS)}</span> needs a
        second pair of eyes, and that threshold is a CHECK constraint rather than a
        sentence on this page — the database refuses it, so it holds from{' '}
        <span className="mono">psql</span> too. At or under it, one human may decide
        their own request. Above it, or raised by an agent at{' '}
        <em>any</em> amount, a different person must decide. And an agent can never
        approve anything at all — it may propose, and that is the entire extent of
        its authority.
      </p>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat">{pending}</div>
          <div className="stat-label">Awaiting a checker</div>
        </div>
        <div className="card">
          <div className="stat">{fromAgents}</div>
          <div className="stat-label">Raised by an agent</div>
        </div>
        <div className="card">
          <div className="stat" style={{ fontSize: 14, lineHeight: 1.5 }}>
            {session.email}
          </div>
          <div className="stat-label">You are signed in as</div>
        </div>
      </div>

      <div className="callout">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          <strong>Three separate controls, not one.</strong>{' '}
          <span className="mono">approvals_no_self_approval</span> is a CHECK
          constraint, so the database refuses{' '}
          <span className="mono">decided_by = requested_by</span> even from psql —{' '}
          <a href="/invariants">the invariants page proves it by trying</a>. The
          executor separately refuses any decider whose identity begins{' '}
          <span className="mono">agent:</span>. And approval is not execution:
          executing re-checks the balance, because cash can move between a reviewer
          clicking approve and money actually leaving.
        </p>
      </div>

      <h2>Queue</h2>
      <ApprovalsClient rows={queue} me={session.email} />

      <h2>What an agent is never allowed to do</h2>
      <p>
        The rule this list encodes: an agent may <strong>read</strong> anything and{' '}
        <strong>propose</strong> anything, but may not <strong>decide</strong>,{' '}
        <strong>move</strong> or <strong>erase</strong>. The MCP surface has no
        function for any of the below — they are absent, not merely guarded.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th>Why not</th>
            </tr>
          </thead>
          <tbody>
            {NEVER_FOR_AGENTS.map((item) => (
              <tr key={item.operation}>
                <td style={{ fontWeight: 550, minWidth: 220 }}>{item.operation}</td>
                <td className="dim">{item.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>The agent surface</h2>
      <p>
        A working MCP server over stdio — <span className="mono">npm run mcp</span> —
        with three read tools and one write tool.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Kind</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">get_portfolio</td>
              <td>
                <span className="badge badge-muted">read</span>
              </td>
              <td className="dim">
                Positions, cost basis, the three cash buckets, time-weighted return.
              </td>
            </tr>
            <tr>
              <td className="mono">explain_balance</td>
              <td>
                <span className="badge badge-muted">read</span>
              </td>
              <td className="dim">
                The journal lines behind a figure, so an agent can check a number
                rather than trust it.
              </td>
            </tr>
            <tr>
              <td className="mono">list_reconciliation_breaks</td>
              <td>
                <span className="badge badge-muted">read</span>
              </td>
              <td className="dim">
                Open breaks, classified and aged. It cannot resolve one.
              </td>
            </tr>
            <tr>
              <td className="mono">propose_withdrawal</td>
              <td>
                <span className="badge badge-info">write</span>
              </td>
              <td className="dim">
                Creates a <strong>pending approval</strong>. No journal entry, no
                transfer, no money. Lands in this queue.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
