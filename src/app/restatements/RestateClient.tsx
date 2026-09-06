'use client';

import { useState } from 'react';

/** The shape /api/ops/split returns, so the comparison can be rendered as a
 *  table rather than a JSON blob. A reviewer should not have to read JSON to
 *  see whether the return moved. */
interface SplitResponse {
  symbol: string;
  ratio: string;
  price: { before: string; after: string };
  verdict: string;
  note: string;
  comparison: Array<{
    customer: string;
    units: { before: string; after: string };
    marketValue: { before: string; after: string; unchanged: boolean };
    costBasis: { before: string; after: string; unchanged: boolean };
    portfolioValue: { before: string; after: string; unchanged: boolean };
    timeWeightedReturn: {
      before: string;
      after: string;
      unchangedTo12dp: boolean;
      exact: string;
    };
  }>;
}

export default function RestateClient({
  defaults,
}: {
  defaults: { symbol: string; date: string; periodStart: string; pct: number };
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ ok: boolean; title: string; body: string }>>([]);
  const [split, setSplit] = useState<SplitResponse | null>(null);

  /**
   * `reload` refreshes the tables below after a scenario that changes them.
   *
   * The split must NOT reload, and that is not a preference. Its whole claim is
   * that nothing below changes, so reloading destroys the only evidence there
   * is — the before-and-after comparison held in this component's state — and
   * leaves a screen that looks like the button did nothing at all.
   */
  async function post(
    payload: unknown,
    label: string,
    endpoint = '/api/ops/correct-close',
    reload = true,
  ) {
    setBusy(label);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (endpoint === '/api/ops/split' && response.ok) setSplit(json as SplitResponse);
      setLog((prev) => [
        { ok: response.ok, title: `${label} — HTTP ${response.status}`, body: JSON.stringify(json, null, 2) },
        ...prev,
      ]);
      if (response.ok && reload) setTimeout(() => window.location.reload(), 1800);
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

      <h2>The opposite case — an event that must change nothing</h2>
      <div className="card" style={{ marginBottom: 12 }}>
        <p style={{ fontSize: 12.5, margin: '0 0 10px' }}>
          A <strong>2-for-1 split</strong> doubles the units and halves the price.
          Twice as much of something worth half as much is the same money, so this
          is the one corporate action where the correct outcome is that every
          money figure stands perfectly still — market value, cost basis,
          portfolio total and the time-weighted return.
          <br />
          <br />
          It is a sharper test than the corrected close above, because a model can
          get a price move roughly right by accident. A split has to be{' '}
          <em>exactly</em> inert. <strong>If the return moves on a split, the
          model is wrong</strong> — and the comparison below is measured either
          side of the same transaction rather than asserted.
        </p>
        <button
          className="btn"
          disabled={busy !== null}
          onClick={() =>
            post({ symbol: defaults.symbol }, 'Split', '/api/ops/split', false)
          }
        >
          {busy === 'Split' ? 'Splitting…' : `Run a 2-for-1 split in ${defaults.symbol}`}
        </button>
        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          The return is compared at <strong>twelve decimal places</strong>, not the
          two the screen shows. Two different returns can print identically at 2dp,
          and that would be the bug hiding behind the test meant to catch it.
        </p>
      </div>

      {split && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-live">{split.ratio} split applied</span>
            <strong style={{ fontSize: 13 }}>{split.symbol}</strong>
            <span className="mono dim" style={{ fontSize: 12 }}>
              price ${split.price.before} → ${split.price.after}
            </span>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Units</th>
                  <th className="num">Market value</th>
                  <th className="num">Cost basis</th>
                  <th className="num">Portfolio</th>
                  <th className="num">Time-weighted return</th>
                </tr>
              </thead>
              <tbody>
                {split.comparison.map((c) => (
                  <>
                    <tr key={`${c.customer}-b`}>
                      <td style={{ fontWeight: 600 }}>{c.customer}</td>
                      <td className="num dim">{c.units.before}</td>
                      <td className="num dim">{c.marketValue.before}</td>
                      <td className="num dim">{c.costBasis.before}</td>
                      <td className="num dim">{c.portfolioValue.before}</td>
                      <td className="num dim">{c.timeWeightedReturn.before}</td>
                    </tr>
                    <tr key={`${c.customer}-a`}>
                      <td className="dim" style={{ fontSize: 12 }}>after the split</td>
                      <td className="num" style={{ color: 'var(--info)', fontWeight: 600 }}>
                        {c.units.after}
                      </td>
                      <td className="num">{c.marketValue.after}</td>
                      <td className="num">{c.costBasis.after}</td>
                      <td className="num">{c.portfolioValue.after}</td>
                      <td className="num">{c.timeWeightedReturn.after}</td>
                    </tr>
                    <tr key={`${c.customer}-v`}>
                      <td></td>
                      <td className="num" style={{ color: 'var(--info)' }}>doubled</td>
                      <td className="num" style={{ color: c.marketValue.unchanged ? 'var(--accent)' : 'var(--danger)' }}>
                        {c.marketValue.unchanged ? 'unchanged' : 'MOVED'}
                      </td>
                      <td className="num" style={{ color: c.costBasis.unchanged ? 'var(--accent)' : 'var(--danger)' }}>
                        {c.costBasis.unchanged ? 'unchanged' : 'MOVED'}
                      </td>
                      <td className="num" style={{ color: c.portfolioValue.unchanged ? 'var(--accent)' : 'var(--danger)' }}>
                        {c.portfolioValue.unchanged ? 'unchanged' : 'MOVED'}
                      </td>
                      <td className="num mono" style={{ fontSize: 11.5, color: c.timeWeightedReturn.unchangedTo12dp ? 'var(--accent)' : 'var(--danger)' }}>
                        {c.timeWeightedReturn.unchangedTo12dp
                          ? `unchanged · ${c.timeWeightedReturn.exact}`
                          : 'MOVED'}
                      </td>
                    </tr>
                  </>
                ))}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 12.5, margin: '10px 0 0' }}>{split.verdict}</p>
          <p className="dim" style={{ fontSize: 12, margin: '6px 0 0' }}>{split.note}</p>
        </div>
      )}

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
