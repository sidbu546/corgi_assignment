'use client';

import { useState } from 'react';

export interface QueueRow {
  id: string;
  action_type: string;
  amount: string | null;
  customer_name: string | null;
  requested_by: string;
  requested_by_kind: string;
  status: string;
  decided_by: string | null;
  decision_note: string | null;
  executed_entry_id: string | null;
  requested_at: string;
  payload: Record<string, unknown>;
  executed_by: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'badge-info',
  approved: 'badge-sim',
  executed: 'badge-live',
  rejected: 'badge-down',
  expired: 'badge-muted',
};

export default function ApprovalsClient({
  rows,
  me,
  threshold,
}: {
  rows: QueueRow[];
  me: string;
  threshold: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ ok: boolean; title: string; body: string }>>([]);
  const [customer, setCustomer] = useState('dana@demo.ledgerly.app');
  const [amount, setAmount] = useState('1500');

  async function raise() {
    setBusy('raise');
    try {
      const response = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'raise', customer, amount, note: 'raised by ops' }),
      });
      const json = await response.json();
      setLog((prev) => [
        {
          ok: response.ok,
          title: `Raise request — HTTP ${response.status}`,
          body: JSON.stringify(json, null, 2),
        },
        ...prev,
      ]);
      if (response.ok) setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setLog((prev) => [
        { ok: false, title: 'Raise request — network error', body: String(error) },
        ...prev,
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function act(approvalId: string, action: string, label: string) {
    setBusy(`${approvalId}:${action}`);
    try {
      const response = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, action }),
      });
      const json = await response.json();
      setLog((prev) => [
        { ok: response.ok, title: `${label} — HTTP ${response.status}`, body: JSON.stringify(json, null, 2) },
        ...prev,
      ]);
      if (response.ok) setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      setLog((prev) => [{ ok: false, title: `${label} — network error`, body: String(error) }, ...prev]);
    } finally {
      setBusy(null);
    }
  }

  const actionable = rows.filter(
    (r) => r.status === 'pending' || r.status === 'approved',
  );
  const history = rows.filter(
    (r) => r.status !== 'pending' && r.status !== 'approved',
  );

  const input: React.CSSProperties = {
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid var(--border-strong)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    fontSize: 13,
  };

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <strong style={{ fontSize: 13 }}>Raise a request — you are the maker</strong>
        <p className="dim" style={{ fontSize: 12.5, margin: '6px 0 10px' }}>
          Only money-out <strong>above {threshold}</strong> comes through this
          queue. Anything at or under it is refused here rather than quietly
          taking a different path. Whatever you raise, you will not be able to
          approve or execute — that is the point.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>
            <div className="stat-label" style={{ marginBottom: 4 }}>Customer</div>
            <input
              style={{ ...input, width: 250 }}
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="dana@demo.ledgerly.app"
            />
          </label>
          <label>
            <div className="stat-label" style={{ marginBottom: 4 }}>Amount (USD)</div>
            <input
              style={{ ...input, width: 140 }}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1500"
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => raise()}
          >
            {busy === 'raise' ? 'Raising…' : 'Raise the request'}
          </button>
        </div>
      </div>

      {actionable.length === 0 && (
        <p className="dim">
          Nothing awaiting a decision. Raise one above, or run{' '}
          <span className="mono">npm run agent-demo</span> to have the agent
          propose one.
        </p>
      )}

      {actionable.map((r) => {
        // One rule: whoever raised it neither approves nor executes it.
        const isMine = r.requested_by === me;
        const pending = r.status === 'pending';
        const approved = r.status === 'approved';
        return (
          <div className="card" key={r.id} style={{ marginBottom: 10 }}>
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                flexWrap: 'wrap',
                marginBottom: 8,
              }}
            >
              <span className={`badge ${STATUS_BADGE[r.status] ?? 'badge-muted'}`}>
                {r.status}
              </span>
              <strong style={{ fontSize: 13 }}>
                {r.action_type} {r.amount ? `· ${r.amount}` : ''}
              </strong>
              {r.customer_name && <span className="dim">{r.customer_name}</span>}
              <span
                className={`badge ${
                  r.requested_by_kind === 'agent' ? 'badge-sim' : 'badge-muted'
                }`}
                title={
                  r.requested_by_kind === 'agent'
                    ? 'Raised by an agent. It may propose; it may never decide.'
                    : 'Raised by a human.'
                }
              >
                {r.requested_by_kind}
              </span>
              <span className="spacer" />
              <span className="dim mono" style={{ fontSize: 11.5 }}>
                {new Date(r.requested_at).toISOString().slice(0, 19)}Z
              </span>
            </div>

            <dl style={{ margin: '0 0 10px' }}>
              <div className="kv">
                <dt>requested by</dt>
                <dd>{r.requested_by}</dd>
              </div>
              {r.decided_by && (
                <div className="kv">
                  <dt>decided by</dt>
                  <dd>{r.decided_by}</dd>
                </div>
              )}
              {r.executed_entry_id && (
                <div className="kv">
                  <dt>journal entry</dt>
                  <dd>{r.executed_entry_id}</dd>
                </div>
              )}
              {Object.entries(r.payload ?? {}).map(([k, v]) => (
                <div className="kv" key={k}>
                  <dt>{k}</dt>
                  <dd style={{ textAlign: 'right', maxWidth: '48ch' }}>{String(v)}</dd>
                </div>
              ))}
            </dl>

            {isMine && (pending || approved) && (
              <div className="callout callout-warn">
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  <strong>You raised this request, so it is not yours to decide.</strong>{' '}
                  The checker both approves and executes it. Sign in as the other ops
                  user. The database refuses self-approval AND self-execution as CHECK
                  constraints — the buttons below are hidden as a courtesy, not as the
                  control.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {pending && !isMine && (
                <>
                  <button
                    className="btn btn-primary"
                    disabled={busy !== null}
                    onClick={() => act(r.id, 'approve', 'Approve')}
                  >
                    {busy === `${r.id}:approve` ? 'Approving…' : 'Approve'}
                  </button>
                  <button
                    className="btn"
                    disabled={busy !== null}
                    onClick={() => act(r.id, 'reject', 'Reject')}
                  >
                    Reject
                  </button>
                </>
              )}
              {pending && isMine && (
                <button className="btn" disabled title="You raised this request">
                  Approve (blocked — you raised it)
                </button>
              )}
              {approved && isMine && (
                <button className="btn" disabled title="You raised this request">
                  Execute (blocked — you raised it)
                </button>
              )}
              {approved && !isMine && (
                <button
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => act(r.id, 'execute', 'Execute')}
                >
                  {busy === `${r.id}:execute` ? 'Executing…' : 'Execute — move the money'}
                </button>
              )}
            </div>

            {approved && (
              <p className="dim" style={{ fontSize: 12, margin: '8px 0 0' }}>
                Approved but not paid. Execution re-checks the balance, because cash
                can move between a reviewer clicking approve and money leaving.
              </p>
            )}
          </div>
        );
      })}

      {log.map((entry, i) => (
        <div className="card" key={i} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <span className={`badge ${entry.ok ? 'badge-live' : 'badge-down'}`}>
              {entry.ok ? 'ok' : 'refused'}
            </span>
            <strong style={{ fontSize: 13 }}>{entry.title}</strong>
          </div>
          <pre
            className="mono"
            style={{
              margin: 0,
              fontSize: 11.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-2)',
              maxHeight: 300,
              overflow: 'auto',
            }}
          >
            {entry.body}
          </pre>
        </div>
      ))}
    </>
  );
}
