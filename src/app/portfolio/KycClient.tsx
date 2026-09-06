'use client';

import { useState } from 'react';

export default function KycClient({
  status,
  inquiryId,
}: {
  status: string;
  inquiryId: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; body: string } | null>(null);

  async function post(action: string, label: string) {
    setBusy(label);
    try {
      const response = await fetch('/api/kyc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await response.json();
      setResult({ ok: response.ok, body: JSON.stringify(json, null, 2) });
      if (response.ok && action !== 'start') {
        // Give the webhook a moment to land, then show the real state.
        setTimeout(() => window.location.reload(), 3500);
      }
    } catch (error) {
      setResult({ ok: false, body: String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <strong style={{ fontSize: 13 }}>Identity verification</strong>
      <p style={{ fontSize: 12.5, margin: '6px 0 10px' }}>
        Verification runs at Persona. Our KYC status changes{' '}
        <strong>only</strong> when Persona sends a signed webhook — none of these
        buttons writes it directly, which is why the gate cannot be clicked open.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => post('start', 'start')}
        >
          {busy === 'start' ? 'Opening…' : 'Start verification'}
        </button>

        {inquiryId && (
          <>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => post('approve', 'approve')}
            >
              {busy === 'approve' ? 'Deciding…' : 'Sandbox: pass the check'}
            </button>
            <button
              className="btn"
              disabled={busy !== null}
              onClick={() => post('decline', 'decline')}
            >
              {busy === 'decline' ? 'Deciding…' : 'Sandbox: fail the check'}
            </button>
          </>
        )}
      </div>

      <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
        The two sandbox buttons call <em>Persona&rsquo;s</em> own decision
        endpoints, so a real inquiry really is approved or declined and a real
        webhook really is emitted. They exist so the <strong>declined</strong> path
        can be shown on demand — a gate that has only ever been seen to open is not
        a gate. They would not exist in production, where the customer completes the
        hosted flow themselves.
      </p>

      {result && (
        <>
          <div
            className={`badge ${result.ok ? 'badge-live' : 'badge-down'}`}
            style={{ margin: '10px 0 6px', display: 'inline-flex' }}
          >
            {result.ok ? 'Persona responded' : 'failed'}
          </div>
          <pre
            className="mono"
            style={{
              margin: 0,
              fontSize: 11.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-2)',
              maxHeight: 260,
              overflow: 'auto',
            }}
          >
            {result.body}
          </pre>
        </>
      )}

      <p className="dim mono" style={{ fontSize: 11.5, margin: '8px 0 0' }}>
        current status: {status}
        {inquiryId ? ` · inquiry ${inquiryId}` : ''}
      </p>
    </div>
  );
}
