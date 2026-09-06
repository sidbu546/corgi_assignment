'use client';

import { useState } from 'react';

/**
 * The controls that make reconciliation an operation you can watch, rather than
 * a table of rows someone else produced overnight.
 */
export default function ReconClient() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; body: string } | null>(null);

  async function run(mode: 'clean' | 'plant', label: string) {
    setBusy(label);
    setResult(null);
    try {
      const response = await fetch('/api/ops/run-recon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const json = await response.json();
      setResult({ ok: response.ok, body: JSON.stringify(json, null, 2) });
      if (response.ok) setTimeout(() => window.location.reload(), 2200);
    } catch (error) {
      setResult({ ok: false, body: String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2>Run it now</h2>

      <div className="callout">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          <strong>A clean run finding nothing is the important half.</strong> A
          reconciliation that reports noise when nothing is wrong gets ignored by
          Thursday, and is then worthless on the morning something is genuinely
          broken. So run it clean first and watch it find nothing, then plant the
          breaks and watch it classify them.
          <br />
          <br />
          Either way this touches no money row. Reconciliation <em>observes</em> the
          ledger; it never corrects it. What to do about a break is a separate,
          human decision that goes through the approvals queue.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          className="btn btn-primary"
          disabled={busy !== null}
          onClick={() => run('clean', 'clean')}
        >
          {busy === 'clean' ? 'Reconciling…' : 'Run this morning’s reconciliation'}
        </button>
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() => run('plant', 'plant')}
        >
          {busy === 'plant' ? 'Reconciling…' : 'Run it with breaks planted'}
        </button>
      </div>

      <p className="dim" style={{ fontSize: 12, marginTop: 0 }}>
        The custodian file is generated, diffed against our ledger, and every
        difference classified and stored as a new run. The table below reloads
        when it finishes.
      </p>

      {result && (
        <div className="card" style={{ marginTop: 10 }}>
          <div
            className={`badge ${result.ok ? 'badge-live' : 'badge-down'}`}
            style={{ marginBottom: 8 }}
          >
            {result.ok ? 'reconciliation complete' : 'failed'}
          </div>
          <pre
            className="mono"
            style={{
              margin: 0,
              fontSize: 11.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-2)',
              maxHeight: 320,
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
