'use client';

import { useState } from 'react';

export interface PendingDeposit {
  customer: string;
  email: string;
  amount: string;
  transferId: string;
}

export default function RailClient({ pending }: { pending: PendingDeposit[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; body: string } | null>(null);

  async function fire(email: string, outcome: 'settled' | 'returned', label: string) {
    setBusy(label);
    try {
      const response = await fetch('/api/ops/simulate-rail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: email, outcome }),
      });
      const json = await response.json();
      setResult({ ok: response.ok, body: JSON.stringify(json, null, 2) });
      if (response.ok) setTimeout(() => window.location.reload(), 1800);
    } catch (error) {
      setResult({ ok: false, body: String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2>Rail controls</h2>

      <div className="callout callout-warn">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          <strong>What is real and what is simulated here, exactly.</strong> The ACH
          relationship, the transfer and its Alpaca id are <strong>real</strong> and
          exist at Alpaca right now, held at <span className="mono">SENT_TO_CLEARING</span>.
          What these buttons simulate is only <strong>Alpaca telling us it
          completed</strong> — a notification the sandbox will send on its own, but
          only on a trading day. Without it the whole downstream path is
          unreachable at a weekend.
          <br />
          <br />
          It is not a shortcut around the ledger: the event is signed and posted to
          our own webhook endpoint, so it passes signature verification, the
          idempotency check and the same handler a genuine Alpaca event uses. Press
          it twice and the second is recorded as a duplicate.
        </p>
      </div>

      {pending.length === 0 ? (
        <p className="dim">
          No deposits in flight. Sign in as a customer, go to{' '}
          <span className="mono">/fund</span> and make a deposit first.
        </p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">In flight</th>
                <th>Alpaca transfer id</th>
                <th>Advance the rail</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr key={d.transferId}>
                  <td>{d.customer}</td>
                  <td className="num">{d.amount}</td>
                  <td className="mono dim" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                    {d.transferId}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-primary"
                        disabled={busy !== null}
                        onClick={() => fire(d.email, 'settled', `s-${d.transferId}`)}
                      >
                        {busy === `s-${d.transferId}` ? 'Settling…' : 'Good funds'}
                      </button>
                      <button
                        className="btn"
                        disabled={busy !== null}
                        onClick={() => fire(d.email, 'returned', `r-${d.transferId}`)}
                      >
                        {busy === `r-${d.transferId}` ? 'Returning…' : 'Bounce it'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="dim" style={{ fontSize: 12 }}>
        <strong>Good funds</strong> moves the money from{' '}
        <span className="mono">assets:cash:pending_deposit</span> into{' '}
        <span className="mono">assets:cash:settled</span> — it becomes investable and
        withdrawable.{' '}
        <strong>Bounce it</strong> reverses the pending balance and touches nothing
        else: no position, no trade. That is the payoff for keeping in-flight money
        in its own account.
      </p>

      {result && (
        <div className="card" style={{ marginTop: 10 }}>
          <div
            className={`badge ${result.ok ? 'badge-live' : 'badge-down'}`}
            style={{ marginBottom: 8 }}
          >
            {result.ok ? 'rail advanced' : 'refused'}
          </div>
          <pre
            className="mono"
            style={{
              margin: 0,
              fontSize: 11.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-2)',
              maxHeight: 280,
              overflow: 'auto',
            }}
          >
            {result.body}
          </pre>
        </div>
      )}
    </>
  );
}
