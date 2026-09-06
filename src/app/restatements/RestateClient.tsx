'use client';

import { useState } from 'react';

export default function RestateClient({
  defaults,
}: {
  defaults: { symbol: string; date: string; periodStart: string; pct: number };
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ ok: boolean; title: string; body: string }>>([]);

  async function post(payload: unknown, label: string) {
    setBusy(label);
    try {
      const response = await fetch('/api/ops/correct-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      setLog((prev) => [
        { ok: response.ok, title: `${label} — HTTP ${response.status}`, body: JSON.stringify(json, null, 2) },
        ...prev,
      ]);
      if (response.ok) setTimeout(() => window.location.reload(), 1800);
    } catch (error) {
      setLog((prev) => [{ ok: false, title: `${label} — network error`, body: String(error) }, ...prev]);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <strong style={{ fontSize: 13 }}>Step 1 — publish a return</strong>
          <p style={{ fontSize: 12.5, margin: '6px 0 10px' }}>
            Records what we told the customer for{' '}
            <span className="mono">
              {defaults.periodStart} .. {defaults.date}
            </span>
            . Nothing can be restated until something has been published — that is
            the point of the distinction.
          </p>
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              post(
                {
                  action: 'publish',
                  symbol: defaults.symbol,
                  date: defaults.date,
                  periodStart: defaults.periodStart,
                },
                'Publish return',
              )
            }
          >
            {busy === 'Publish return' ? 'Publishing…' : 'Publish the August return'}
          </button>
        </div>

        <div className="card">
          <strong style={{ fontSize: 13 }}>Step 2 — a corrected close arrives</strong>
          <p style={{ fontSize: 12.5, margin: '6px 0 10px' }}>
            The custodian reports that {defaults.symbol}&rsquo;s close on{' '}
            <span className="mono">{defaults.date}</span> was wrong by{' '}
            <span className="mono">{defaults.pct}%</span>. Every day from that date
            forward is revalued and the affected returns are restated.
          </p>
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() =>
              post(
                {
                  action: 'correct',
                  symbol: defaults.symbol,
                  date: defaults.date,
                  pct: defaults.pct,
                },
                'Apply corrected close',
              )
            }
          >
            {busy === 'Apply corrected close' ? 'Restating…' : 'Apply the corrected close'}
          </button>
        </div>
      </div>

      {log.length > 0 &&
        log.map((entry, i) => (
          <div className="card" key={i} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span className={`badge ${entry.ok ? 'badge-live' : 'badge-down'}`}>
                {entry.ok ? 'ok' : 'failed'}
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
                maxHeight: 340,
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
