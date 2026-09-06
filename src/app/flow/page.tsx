import Decimal from 'decimal.js';
import { withClient } from '@/lib/db';
import { requireUser } from '@/lib/session';
import { formatCents, formatUnits } from '@/lib/money';
import { formatPercent } from '@/lib/returns';
import { cashPosition } from '@/lib/ledger/read';
import { marketDateOf } from '@/lib/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /flow — the six steps of the brief, as one story, for one customer.
 *
 * Each step shows three things deliberately:
 *   what happened · the PROVIDER's own identifier · the journal entries it made
 *
 * The provider id is the point. Our ledger agreeing with itself proves
 * bookkeeping; a third party holding the same identifier proves the money.
 */

interface Step {
  n: number;
  title: string;
  done: boolean;
  blocked?: string;
}

export default async function FlowPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const session = await requireUser();
  const params = await searchParams;
  const today = marketDateOf(new Date());

  const data = await withClient(async (client) => {
    const { rows: candidates } = await client.query<{
      id: string;
      legal_name: string;
      email: string;
    }>(
      `SELECT DISTINCT c.id, c.legal_name, c.email
         FROM customers c JOIN journal_lines l ON l.customer_id = c.id
        WHERE c.legal_name <> 'Invariant Probe'
        ORDER BY c.legal_name`,
    );

    const chosenId =
      session.role === 'customer'
        ? session.customerId!
        : (params.customer ?? candidates[0]?.id);

    if (!chosenId) return null;

    const { rows: cust } = await client.query<{
      id: string;
      legal_name: string;
      email: string;
      alpaca_account_id: string | null;
      persona_inquiry_id: string | null;
      plaid_item_id: string | null;
      execution_venue: string;
    }>(
      `SELECT id, legal_name, email, alpaca_account_id, persona_inquiry_id,
              plaid_item_id, execution_venue::text AS execution_venue
         FROM customers WHERE id = $1::uuid`,
      [chosenId],
    );
    const customer = cust[0];
    if (!customer) return null;

    const [kyc, bank, transfers, orders, valuation, published, breaks, cash] =
      await Promise.all([
        client.query<{ status: string; provider_ref: string | null; effective_at: Date; reason: string | null }>(
          `SELECT status::text AS status, provider_ref, effective_at, reason
             FROM kyc_events WHERE customer_id = $1::uuid
            ORDER BY effective_at, id`,
          [chosenId],
        ),
        client.query<{ institution: string; account_mask: string; name_match: boolean | null; alpaca_relationship_id: string | null; is_active: boolean }>(
          `SELECT institution, account_mask, name_match, alpaca_relationship_id, is_active
             FROM bank_links WHERE customer_id = $1::uuid
            ORDER BY recorded_at DESC LIMIT 3`,
          [chosenId],
        ),
        client.query<{ amount_cents: bigint; provider_ref: string | null; kind: string; effective_at: Date; entry_id: string | null }>(
          `SELECT t.amount_cents, t.provider_ref,
                  (SELECT kind::text FROM cash_transfer_events e
                    WHERE e.transfer_id = t.id ORDER BY e.recorded_at DESC LIMIT 1) AS kind,
                  t.effective_at,
                  (SELECT entry_id FROM cash_transfer_events e
                    WHERE e.transfer_id = t.id ORDER BY e.recorded_at ASC LIMIT 1) AS entry_id
             FROM cash_transfers t WHERE t.customer_id = $1::uuid
            ORDER BY t.recorded_at DESC LIMIT 5`,
          [chosenId],
        ),
        client.query<{ symbol: string; requested_cents: bigint | null; venue: string; broker_order_id: string | null; status: string; effective_at: Date }>(
          `SELECT o.symbol, o.requested_cents, o.venue::text AS venue, o.broker_order_id,
                  coalesce((SELECT kind::text FROM order_events e
                             WHERE e.order_id = o.id ORDER BY e.recorded_at DESC LIMIT 1),
                           'submitted') AS status,
                  o.effective_at
             FROM orders o WHERE o.customer_id = $1::uuid
            ORDER BY o.recorded_at DESC LIMIT 8`,
          [chosenId],
        ),
        client.query<{ runs: string; total: bigint | null; as_of: string | null; stale: string }>(
          `SELECT (SELECT count(*)::text FROM valuation_totals WHERE customer_id = $1::uuid) AS runs,
                  v.total_value_cents AS total,
                  to_char(r.as_of_date, 'YYYY-MM-DD') AS as_of,
                  (SELECT count(*)::text FROM valuation_positions vp
                    WHERE vp.customer_id = $1::uuid AND vp.price_age_days > 0) AS stale
             FROM valuation_totals v JOIN valuation_runs r ON r.id = v.run_id
            WHERE v.customer_id = $1::uuid
            ORDER BY r.as_of_date DESC, r.recorded_at DESC LIMIT 1`,
          [chosenId],
        ),
        client.query<{ id: string; period_start: string; period_end: string; twr: string; end_value_cents: bigint; restates_id: string | null; published_at: Date; restatement_reason: string | null }>(
          `SELECT id, to_char(period_start,'YYYY-MM-DD') AS period_start,
                  to_char(period_end,'YYYY-MM-DD') AS period_end, twr,
                  end_value_cents, restates_id, published_at, restatement_reason
             FROM published_returns WHERE customer_id = $1::uuid
            ORDER BY published_at DESC LIMIT 8`,
          [chosenId],
        ),
        client.query<{ classification: string; symbol: string | null; detail: string; as_of: string }>(
          `WITH latest AS (
                 SELECT DISTINCT ON (b.customer_id) b.customer_id, b.run_id
                   FROM recon_breaks b JOIN recon_runs r ON r.id = b.run_id
                  WHERE r.as_of_date = (SELECT max(as_of_date) FROM recon_runs)
                  ORDER BY b.customer_id, r.started_at DESC)
           SELECT b.classification, b.symbol, b.detail,
                  to_char(r.as_of_date,'YYYY-MM-DD') AS as_of
             FROM recon_breaks b
             JOIN latest l ON l.run_id = b.run_id AND l.customer_id = b.customer_id
             JOIN recon_runs r ON r.id = b.run_id
            WHERE b.customer_id = $1::uuid`,
          [chosenId],
        ),
        cashPosition(chosenId),
      ]);

    const { rows: entries } = await client.query<{
      kind: string;
      narrative: string;
      effective_at: Date;
      source: string;
      source_ref: string | null;
      id: string;
    }>(
      `SELECT DISTINCT e.kind, e.narrative, e.effective_at, e.source, e.source_ref, e.id
         FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
        WHERE l.customer_id = $1::uuid
        ORDER BY e.effective_at DESC LIMIT 40`,
      [chosenId],
    );

    return {
      candidates,
      customer,
      kyc: kyc.rows,
      bank: bank.rows,
      transfers: transfers.rows,
      orders: orders.rows,
      valuation: valuation.rows[0] ?? null,
      published: published.rows,
      breaks: breaks.rows,
      cash,
      entries,
    };
  });

  if (!data) {
    return (
      <>
        <h1>The money path</h1>
        <p className="dim">No customer with any ledger activity yet.</p>
      </>
    );
  }

  const kycApproved = data.kyc.some((k) => k.status === 'approved');
  const bankLinked = data.bank.some((b) => b.alpaca_relationship_id && b.is_active);
  const deposited = data.transfers.length > 0;
  const ordered = data.orders.length > 0;
  const filled = data.orders.some((o) => o.status === 'fill' || o.status === 'partial_fill');
  const valued = Boolean(data.valuation);
  const restated = data.published.some((p) => p.restates_id);
  const reconciled = data.breaks.length >= 0;

  const restatement = (() => {
    const corrected = data.published.find((p) => p.restates_id);
    if (!corrected) return null;
    const original = data.published.find((p) => p.id === corrected.restates_id);
    if (!original) return null;
    return { corrected, original };
  })();

  const steps: Step[] = [
    { n: 1, title: 'Onboard with a real KYC check', done: kycApproved },
    { n: 2, title: 'Link a bank and deposit through open banking', done: bankLinked && deposited },
    {
      n: 3,
      title: 'Buy into a model portfolio with real paper orders',
      done: ordered,
      blocked: ordered && !filled ? 'orders are live at the broker; fills need the market open' : undefined,
    },
    { n: 4, title: 'Value the book daily', done: valued },
    { n: 5, title: 'Take a late correction and restate the return', done: restated },
    { n: 6, title: 'Reconcile against the custodian', done: reconciled },
  ];

  const Ref = ({ label, value }: { label: string; value: string | null }) =>
    value ? (
      <div className="kv">
        <dt>{label}</dt>
        <dd style={{ wordBreak: 'break-all' }}>{value}</dd>
      </div>
    ) : null;

  const entriesFor = (...kinds: string[]) =>
    data.entries.filter((e) => kinds.some((k) => e.kind.startsWith(k)));

  const EntryList = ({ rows }: { rows: typeof data.entries }) =>
    rows.length === 0 ? null : (
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Journal entry</th>
              <th>Provider ref</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 6).map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ fontSize: 12 }}>
                  {new Date(e.effective_at).toISOString().slice(0, 10)}
                </td>
                <td>
                  <div>
                    <span className="badge badge-muted">{e.kind}</span>
                  </div>
                  <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
                    {e.narrative}
                  </div>
                </td>
                <td className="mono dim" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                  {e.source_ref ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <h1>The money path</h1>
      <p className="lede">
        The six steps of the brief, as one story, for one customer. Each step shows
        what happened, <strong>the provider&rsquo;s own identifier</strong>, and the
        journal entries it produced. The provider id is the point: our ledger
        agreeing with itself proves bookkeeping — a third party holding the same
        identifier proves the money.
      </p>

      {session.role === 'ops' && data.candidates.length > 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="stat-label" style={{ marginBottom: 6 }}>
            Customer
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.candidates.map((c) => (
              <a
                key={c.id}
                href={`/flow?customer=${c.id}`}
                className={`btn ${c.id === data.customer.id ? 'btn-primary' : ''}`}
                style={{ padding: '4px 10px', fontSize: 12.5 }}
              >
                {c.legal_name}
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table>
          <tbody>
            {steps.map((s) => (
              <tr key={s.n}>
                <td className="num" style={{ width: 40 }}>
                  {s.n}
                </td>
                <td>{s.title}</td>
                <td style={{ width: 190 }}>
                  <span
                    className={`badge ${
                      s.blocked ? 'badge-sim' : s.done ? 'badge-live' : 'badge-muted'
                    }`}
                  >
                    {s.blocked ? 'partial' : s.done ? 'done' : 'not yet'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------------------------------------------------- 1 */}
      <h2>1 · Onboard with a real KYC check</h2>
      <div className="card">
        <p style={{ fontSize: 12.5, marginTop: 0 }}>
          Verification runs at <strong>Persona</strong>. Our status changes only when
          a signed webhook arrives and verifies — nothing in our UI writes it.
        </p>
        <dl style={{ margin: 0 }}>
          <Ref label="Persona inquiry id" value={data.customer.persona_inquiry_id} />
        </dl>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Inquiry</th>
              </tr>
            </thead>
            <tbody>
              {data.kyc.map((k, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {new Date(k.effective_at).toISOString().slice(0, 19)}Z
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        k.status === 'approved'
                          ? 'badge-live'
                          : k.status === 'rejected'
                            ? 'badge-down'
                            : 'badge-sim'
                      }`}
                    >
                      {k.status}
                    </span>
                    {k.reason && (
                      <div className="dim" style={{ fontSize: 12 }}>
                        {k.reason}
                      </div>
                    )}
                  </td>
                  <td className="mono dim" style={{ fontSize: 11.5 }}>
                    {k.provider_ref ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Append-only. Every state Persona reported is still here — a status column
          would have erased the history.
        </p>
      </div>

      {/* ---------------------------------------------------------- 2 */}
      <h2>2 · Link a bank and deposit through open banking</h2>
      <div className="card">
        <p style={{ fontSize: 12.5, marginTop: 0 }}>
          <strong>Plaid</strong> verified the account and minted a token scoped to{' '}
          <strong>Alpaca</strong>; Alpaca redeemed it as an ACH relationship. No raw
          account number reached us.
        </p>
        {data.bank.map((b, i) => (
          <dl key={i} style={{ margin: '0 0 10px' }}>
            <div className="kv">
              <dt>institution</dt>
              <dd>
                {b.institution} ****{b.account_mask}
              </dd>
            </div>
            <div className="kv">
              <dt>account owner matches identity on file</dt>
              <dd>
                <span
                  className={`badge ${
                    b.name_match === true
                      ? 'badge-live'
                      : b.name_match === false
                        ? 'badge-down'
                        : 'badge-sim'
                  }`}
                >
                  {b.name_match === true ? 'yes' : b.name_match === false ? 'NO — refused' : 'unknown'}
                </span>
              </dd>
            </div>
            <Ref label="Alpaca ACH relationship" value={b.alpaca_relationship_id} />
          </dl>
        ))}
        {data.transfers.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Deposit</th>
                  <th>State</th>
                  <th>Alpaca transfer id</th>
                </tr>
              </thead>
              <tbody>
                {data.transfers.map((t, i) => (
                  <tr key={i}>
                    <td className="num">{formatCents(t.amount_cents)}</td>
                    <td>
                      <span
                        className={`badge ${
                          t.kind === 'settled'
                            ? 'badge-live'
                            : t.kind === 'returned'
                              ? 'badge-down'
                              : 'badge-info'
                        }`}
                      >
                        {t.kind === 'initiated' ? 'in flight' : t.kind}
                      </span>
                    </td>
                    <td className="mono dim" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                      {t.provider_ref ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          In flight = <span className="mono">assets:cash:pending_deposit</span>. Not
          investable, not withdrawable, and excluded from portfolio value — because a
          deposit that has not cleared can still bounce.
        </p>
        <EntryList rows={entriesFor('deposit')} />
      </div>

      {/* ---------------------------------------------------------- 3 */}
      <h2>3 · Buy into a model portfolio with real orders</h2>
      <div className="card">
        {data.orders.length === 0 ? (
          <p className="dim" style={{ margin: 0 }}>
            No orders yet for this customer.
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="num">Notional</th>
                    <th>Venue</th>
                    <th>State</th>
                    <th>Broker order id</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((o, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{o.symbol}</td>
                      <td className="num">
                        {o.requested_cents !== null ? formatCents(o.requested_cents) : '—'}
                      </td>
                      <td>
                        <span className={`badge ${o.venue === 'paper' ? 'badge-sim' : 'badge-muted'}`}>
                          {o.venue}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            o.status === 'fill'
                              ? 'badge-live'
                              : o.status === 'rejected'
                                ? 'badge-down'
                                : 'badge-info'
                          }`}
                        >
                          {o.status}
                        </span>
                      </td>
                      <td className="mono dim" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                        {o.broker_order_id ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filled && (
              <div className="callout callout-warn" style={{ marginTop: 12 }}>
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  <strong>Live at the broker, not yet filled.</strong> Look the order
                  ids up in Alpaca — they exist and are reserving buying power. Equity
                  orders fill in market hours, and the next US open is{' '}
                  <strong>Tue 8 Sep 09:30 ET</strong> (Monday is Labor Day). Positions,
                  cost basis and tax lots appear only on a fill: an unfilled order is
                  an instruction, not a holding.
                </p>
              </div>
            )}
          </>
        )}
        <EntryList rows={entriesFor('trade')} />
      </div>

      {/* ---------------------------------------------------------- 4 */}
      <h2>4 · Value the book daily</h2>
      <div className="card">
        <div className="grid grid-3" style={{ marginBottom: 10 }}>
          <div>
            <div className="stat">{formatCents(data.valuation?.total ?? 0n)}</div>
            <div className="stat-label">Portfolio value{data.valuation?.as_of ? ` · ${data.valuation.as_of}` : ''}</div>
          </div>
          <div>
            <div className="stat">{data.valuation?.runs ?? '0'}</div>
            <div className="stat-label">Valuation runs kept</div>
          </div>
          <div>
            <div className="stat">{data.valuation?.stale ?? '0'}</div>
            <div className="stat-label">Valued on a carried-forward price</div>
          </div>
        </div>
        <dl style={{ margin: 0 }}>
          <div className="kv">
            <dt>settled — withdrawable</dt>
            <dd>{formatCents(data.cash.settled)}</dd>
          </div>
          <div className="kv">
            <dt>unsettled proceeds — investable, not withdrawable</dt>
            <dd>{formatCents(data.cash.unsettledProceeds)}</dd>
          </div>
          <div className="kv">
            <dt>in flight — neither</dt>
            <dd>{formatCents(data.cash.pendingDeposits)}</dd>
          </div>
        </dl>
        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          A valuation is never overwritten. Re-valuing a date creates a superseding
          run, which is what makes both &ldquo;as published&rdquo; and &ldquo;as
          corrected&rdquo; answerable — see step 5.
        </p>
      </div>

      {/* ---------------------------------------------------------- 5 */}
      <h2>5 · A late correction, and the restatement</h2>
      <div className="card">
        {!restatement ? (
          <p className="dim" style={{ margin: 0 }}>
            Nothing restated for this customer yet. On{' '}
            <a href="/restatements">the restatements page</a>, publish a return and
            then apply a corrected close.
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th className="num">Time-weighted return</th>
                    <th className="num">End value</th>
                    <th>Published</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="badge badge-muted">as published</span>
                    </td>
                    <td className="num">
                      {formatPercent(new Decimal(restatement.original.twr))}
                    </td>
                    <td className="num">{formatCents(restatement.original.end_value_cents)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {new Date(restatement.original.published_at).toISOString().slice(0, 19)}Z
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <span className="badge badge-live">as corrected</span>
                    </td>
                    <td className="num">
                      {formatPercent(new Decimal(restatement.corrected.twr))}
                    </td>
                    <td className="num">{formatCents(restatement.corrected.end_value_cents)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {new Date(restatement.corrected.published_at).toISOString().slice(0, 19)}Z
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {restatement.corrected.restatement_reason && (
              <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
                {restatement.corrected.restatement_reason}
              </p>
            )}
            <p className="dim" style={{ fontSize: 12, margin: '8px 0 0' }}>
              The original row is untouched and still queryable. Nothing was updated —
              the corrected price, the revalued day and the restated return are each a
              new row superseding an old one.
            </p>
          </>
        )}
      </div>

      {/* ---------------------------------------------------------- 6 */}
      <h2>6 · Reconcile against the custodian</h2>
      <div className="card">
        {data.breaks.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5 }}>
            <span className="badge badge-live">clean</span> Our ledger and the
            custodian agree for this customer as of {today}. A clean run producing
            zero breaks is the important half — noise on a quiet morning is what makes
            a breaks screen unusable on a loud one.
          </p>
        ) : (
          data.breaks.map((b, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <span
                className={`badge ${
                  b.classification.startsWith('genuine')
                    ? 'badge-down'
                    : b.classification.startsWith('unbooked')
                      ? 'badge-sim'
                      : 'badge-info'
                }`}
              >
                {b.classification}
              </span>
              {b.symbol && <span className="dim"> · {b.symbol}</span>}
              <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>{b.detail}</p>
            </div>
          ))
        )}
        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Full breaks screen, with classification and aging, at{' '}
          <a href="/recon">/recon</a> (ops).
        </p>
      </div>

      <h2>Verify none of this from our own database</h2>
      <p style={{ fontSize: 12.5 }}>
        Every identifier above belongs to a provider, not to us. Run{' '}
        <span className="mono">npm run evidence</span> and it will ask Alpaca, Plaid
        and Persona directly what they hold — or look any id up in their dashboards.
        Our ledger agreeing with itself proves bookkeeping; a third party holding the
        same identifier proves the money.
      </p>
    </>
  );
}
