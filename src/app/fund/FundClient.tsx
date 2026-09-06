'use client';

import { useState } from 'react';

interface Model {
  id: string;
  name: string;
  description: string;
  weights: Array<{ symbol: string; weight_bps: number }>;
}

interface BankLink {
  institution: string;
  account_mask: string;
  account_name: string;
  name_match: boolean | null;
  alpaca_relationship_id: string | null;
  /**
   * A link can exist, carry a relationship id, and still not be usable — it may
   * have been deactivated, or belong to a brokerage account the customer no
   * longer has. Presence of a relationship id is therefore not the same as
   * being linked, and treating it that way left the page showing "linked" with
   * no way to link again.
   */
  is_active: boolean;
}

export default function FundClient({
  models,
  bankLink,
  investable,
  pending,
  canTransact,
}: {
  models: Model[];
  bankLink: BankLink | null;
  investable: string;
  pending: string;
  canTransact: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ ok: boolean; title: string; body: string }>>([]);

  const say = (ok: boolean, title: string, body: unknown) =>
    setLog((prev) => [
      { ok, title, body: typeof body === 'string' ? body : JSON.stringify(body, null, 2) },
      ...prev,
    ]);

  async function post(url: string, payload: unknown, label: string) {
    setBusy(label);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      say(response.ok, `${label} — HTTP ${response.status}`, json);
      if (response.ok) setTimeout(() => window.location.reload(), 1500);
    } catch (error) {
      say(false, `${label} — network error`, String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {/* ---------------- 1. link a bank ---------------- */}
      <h2>1 · Link a bank through open banking</h2>

      {bankLink?.is_active && bankLink.alpaca_relationship_id ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="badge badge-live">linked</span>
            <strong>{bankLink.institution}</strong>
            <span className="mono dim">
              {bankLink.account_name} ****{bankLink.account_mask}
            </span>
            <span className="badge badge-live">name verified</span>
          </div>
          <div className="mono dim" style={{ fontSize: 11.5, marginTop: 6 }}>
            Alpaca ACH relationship {bankLink.alpaca_relationship_id}
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 12 }}>
          <p style={{ marginBottom: 10 }}>
            Plaid verifies the account and mints a token scoped to Alpaca; Alpaca
            redeems it as an ACH relationship. No account number reaches us.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              disabled={!canTransact || busy !== null}
              onClick={() => post('/api/funding/link', { action: 'sandbox-link' }, 'Link bank')}
            >
              {busy === 'Link bank' ? 'Linking…' : 'Link my bank account'}
            </button>
            <button
              className="btn"
              disabled={!canTransact || busy !== null}
              onClick={() =>
                post(
                  '/api/funding/link',
                  { action: 'sandbox-link', mismatch: true },
                  'Link a stranger’s bank',
                )
              }
            >
              {busy?.startsWith('Link a stranger')
                ? 'Trying…'
                : 'Try linking someone else’s account'}
            </button>
          </div>
          <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
            The second button is not a joke feature: it links an account owned by a
            different person, and funding is refused at the name check. Funding an
            investment account from a stranger&rsquo;s bank is how laundering works,
            so the refusal is the interesting path, not the happy one.
          </p>
        </div>
      )}

      {bankLink && bankLink.name_match === false && !bankLink.alpaca_relationship_id && (
        <div className="callout callout-warn">
          <p style={{ margin: 0 }}>
            <strong>Last link attempt was refused.</strong> The account at{' '}
            {bankLink.institution} is held by someone other than you, so it was
            recorded for review and never activated.
          </p>
        </div>
      )}

      {/* ---------------- 2. deposit ---------------- */}
      <h2>2 · Deposit</h2>
      <div className="card" style={{ marginBottom: 12 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const amount = new FormData(e.currentTarget).get('amount');
            post('/api/funding/deposit', { amount: String(amount) }, 'Deposit');
          }}
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          <label>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Amount (USD)
            </div>
            <input
              name="amount"
              defaultValue="25000"
              inputMode="decimal"
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                width: 160,
              }}
            />
          </label>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!canTransact || !bankLink?.alpaca_relationship_id || busy !== null}
          >
            {busy === 'Deposit' ? 'Initiating…' : 'Deposit via ACH'}
          </button>
        </form>
        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Booked as <span className="mono">assets:cash:pending_deposit</span> — in
          flight, not investable, not withdrawable, and deliberately excluded from
          portfolio value. It becomes investable when the rail reports good funds.
          Alpaca&rsquo;s sandbox settles ACH on <strong>trading days</strong>, so a
          deposit initiated at the weekend stays pending until Monday. That is the
          rail&rsquo;s clock, not a stub.
        </p>
      </div>

      {/* ---------------- 3. invest ---------------- */}
      <h2>3 · Buy into a model portfolio</h2>
      <div className="card">
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>
          Investable now: <span className="mono">{investable}</span>
          {pending !== '$0.00' && (
            <>
              {' · '}in flight, not yet investable:{' '}
              <span className="mono">{pending}</span>
            </>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            post(
              '/api/invest',
              { modelId: String(data.get('modelId')), amount: String(data.get('amount')) },
              'Invest',
            );
          }}
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          <label>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Model
            </div>
            <select
              name="modelId"
              defaultValue="growth"
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontSize: 13,
                maxWidth: 420,
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.weights.map((w) => `${w.symbol} ${w.weight_bps / 100}%`).join(', ')}
                </option>
              ))}
            </select>
          </label>
          <label>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Amount (USD)
            </div>
            <input
              name="amount"
              defaultValue="1000"
              inputMode="decimal"
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                width: 140,
              }}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={!canTransact || busy !== null}>
            {busy === 'Invest' ? 'Submitting…' : 'Place orders'}
          </button>
        </form>

        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          The amount is split across the model&rsquo;s weights by largest-remainder,
          so the parts sum to exactly the amount, and each part becomes a{' '}
          <strong>notional</strong> order — &ldquo;$250 of VOO&rdquo; rather than a
          share count, because a percentage of an arbitrary balance never lands on a
          whole number of shares. Positions and tax lots appear only when a fill
          arrives; an unfilled order is an instruction, not a holding.
        </p>
      </div>

      {/* ---------------- response log ---------------- */}
      {log.length > 0 && (
        <>
          <h2>What the providers actually said</h2>
          <p className="dim" style={{ fontSize: 12.5 }}>
            Raw responses, including refusals. A demo that only shows successes is
            hiding the half that matters.
          </p>
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
                  maxHeight: 320,
                  overflow: 'auto',
                }}
              >
                {entry.body}
              </pre>
            </div>
          ))}
        </>
      )}
    </>
  );
}
