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
  /**
   * Whether a DIFFERENT person must decide this one. Computed on the server by
   * the same function the API and the CHECK constraint agree with — the client
   * must not re-derive a money control from a formatted amount string.
   */
  needs_second_person: boolean;
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
}: {
  rows: QueueRow[];
  me: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ ok: boolean; title: string; body: string }>>([]);

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

  return (
    <>
      {rows.length === 0 && (
        <p className="dim">
          Nothing in the queue. Raise one with the MCP{' '}
          <span className="mono">propose_withdrawal</span> tool, or{' '}
          <span className="mono">npm run agent-demo</span>.
        </p>
      )}

      {rows.map((r) => {
        const isMine = r.requested_by === me;
        // Raising it only blocks you when a second person is actually required.
        const blocked = isMine && r.needs_second_person;
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

            {blocked && pending && (
              <div className="callout callout-warn">
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  <strong>You raised this request, so you cannot approve it.</strong>{' '}
                  {r.requested_by_kind === 'agent'
                    ? 'An agent proposal always needs a human decision, at any amount.'
                    : 'It is above the threshold, so it needs a second pair of eyes.'}{' '}
                  Sign in as the other ops user to decide. The database refuses
                  self-approval as a CHECK constraint — the buttons below are hidden
                  as a courtesy, not as the control.
                </p>
              </div>
            )}

            {isMine && pending && !blocked && (
              <div className="callout">
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  <strong>You raised this, and you may decide it.</strong> It is at
                  or under the threshold, which is the stated policy: one pair of
                  eyes below, two above. The database enforces exactly that — it
                  would refuse your decision if this were a cent larger.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {pending && !blocked && (
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
              {pending && blocked && (
                <button className="btn" disabled title="You raised this request">
                  Approve (blocked — you raised it)
                </button>
              )}
              {approved && (
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
