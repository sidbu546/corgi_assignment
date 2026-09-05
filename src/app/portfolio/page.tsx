import { withClient } from '@/lib/db';
import { requireCustomer } from '@/lib/session';
import { runValuation } from '@/lib/valuation';
import { inceptionToDate } from '@/lib/performance';
import { formatCents, formatUnits } from '@/lib/money';
import { formatPercent } from '@/lib/returns';
import { marketDateOf } from '@/lib/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  const session = await requireCustomer();
  const today = marketDateOf(new Date());

  const data = await withClient(async (client) => {
    const { rows: kyc } = await client.query<{ status: string; reason: string | null }>(
      `SELECT status, reason FROM kyc_events
        WHERE customer_id = $1::uuid
        ORDER BY recorded_at DESC, id DESC LIMIT 1`,
      [session.customerId],
    );

    const { rows: model } = await client.query<{ name: string; description: string }>(
      `SELECT p.name, p.description
         FROM customer_mandates m
         JOIN model_versions v ON v.id = m.model_version_id
         JOIN model_portfolios p ON p.id = v.model_id
        WHERE m.customer_id = $1::uuid
        ORDER BY m.recorded_at DESC, m.id DESC LIMIT 1`,
      [session.customerId],
    );

    // Value on demand, so the page reflects the ledger right now rather than
    // whatever the nightly job last wrote. The run is persisted like any other,
    // which means opening this page leaves an audit trail — deliberate.
    const valuation = await runValuation(client, {
      asOf: today,
      trigger: 'portfolio.view',
      customerId: session.customerId,
    });

    const mine = valuation.customers.find((c) => c.customerId === session.customerId);
    const perf = await inceptionToDate(client, session.customerId, today);

    const { rows: activity } = await client.query<{
      kind: string;
      narrative: string;
      effective_at: Date;
    }>(
      `SELECT DISTINCT e.kind, e.narrative, e.effective_at
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
        WHERE l.customer_id = $1::uuid
        ORDER BY e.effective_at DESC
        LIMIT 12`,
      [session.customerId],
    );

    return { kyc: kyc[0] ?? null, model: model[0] ?? null, mine, perf, activity };
  });

  const kycStatus = data.kyc?.status ?? 'not_started';
  const canTransact = kycStatus === 'approved';
  const v = data.mine;

  const unrealised = v ? v.positionsValueCents - v.costBasisCents : 0n;

  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <h1>{session.displayName}</h1>
        <span className="dim mono" style={{ fontSize: 12 }}>
          valued {today}
        </span>
      </div>

      {/* --------------- the KYC gate --------------- */}
      {!canTransact && (
        <div className="callout callout-warn">
          <p style={{ marginBottom: 4 }}>
            <strong>
              {kycStatus === 'pending'
                ? 'Identity verification is still in progress.'
                : kycStatus === 'rejected'
                  ? 'Identity verification was not successful.'
                  : 'Identity verification has not been started.'}
            </strong>{' '}
            You can look around, but deposits and trading are disabled until this
            clears.
          </p>
          {data.kyc?.reason && (
            <p className="mono" style={{ fontSize: 12, margin: 0 }}>
              {data.kyc.reason}
            </p>
          )}
        </div>
      )}

      {/* --------------- headline numbers --------------- */}
      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="stat">{formatCents(v?.totalValueCents ?? 0n)}</div>
          <div className="stat-label">Portfolio value</div>
        </div>
        <div className="card">
          <div
            className="stat"
            style={{
              color:
                (data.perf?.twr.greaterThanOrEqualTo(0) ?? true)
                  ? 'var(--accent)'
                  : 'var(--danger)',
            }}
          >
            {data.perf ? formatPercent(data.perf.twr) : '—'}
          </div>
          <div className="stat-label">Time-weighted return, since inception</div>
        </div>
        <div className="card">
          <div
            className="stat"
            style={{ color: unrealised >= 0n ? 'var(--accent)' : 'var(--danger)' }}
          >
            {formatCents(unrealised)}
          </div>
          <div className="stat-label">Unrealised gain / loss</div>
        </div>
      </div>

      <div className="callout">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          <strong>That return figure is time-weighted.</strong> Your deposits do
          not count as performance — a deposit raises the portfolio value and the
          denominator by the same amount, so it contributes exactly zero. It
          measures how the <em>portfolio</em> did, not how well-timed your saving
          was.{' '}
          {data.perf && data.perf.netFlowCents !== 0n && (
            <>
              Net deposits over the period:{' '}
              <span className="mono">{formatCents(data.perf.netFlowCents)}</span>.
            </>
          )}
        </p>
      </div>

      {/* --------------- cash, in three buckets --------------- */}
      <h2>Cash</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Bucket</th>
              <th>What it means</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">settled</td>
              <td className="dim">Good funds. The only money you can withdraw.</td>
              <td className="num">{formatCents(v?.settledCashCents ?? 0n)}</td>
            </tr>
            <tr>
              <td className="mono">unsettled proceeds</td>
              <td className="dim">
                Sold but not yet settled (T+1). You may buy with it; withdrawing it
                would be free-riding.
              </td>
              <td className="num">{formatCents(v?.unsettledCashCents ?? 0n)}</td>
            </tr>
            <tr>
              <td className="mono">deposit in flight</td>
              <td className="dim">
                Initiated but not good funds. Not investable, not withdrawable, and
                deliberately excluded from portfolio value — it can still bounce.
              </td>
              <td className="num">{formatCents(v?.pendingCashCents ?? 0n)}</td>
            </tr>
            <tr>
              <td style={{ fontWeight: 650 }}>Withdrawable</td>
              <td />
              <td className="num" style={{ fontWeight: 650 }}>
                {formatCents(v?.settledCashCents ?? 0n)}
              </td>
            </tr>
            <tr>
              <td style={{ fontWeight: 650 }}>Investable</td>
              <td />
              <td className="num" style={{ fontWeight: 650 }}>
                {formatCents((v?.settledCashCents ?? 0n) + (v?.unsettledCashCents ?? 0n))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* --------------- positions --------------- */}
      <h2 style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        Positions
        {data.model && <span className="badge badge-info">{data.model.name}</span>}
        {v?.hasStalePrices && (
          <span className="badge badge-sim" title="valued on a carried-forward close">
            stale price in use
          </span>
        )}
      </h2>

      {!v || v.positions.length === 0 ? (
        <p className="dim">
          No positions yet.{' '}
          {canTransact
            ? 'Deposit and choose a model portfolio to get started.'
            : 'Verification must clear before you can invest.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Units</th>
                <th className="num">Price</th>
                <th>As of</th>
                <th className="num">Market value</th>
                <th className="num">Cost basis</th>
                <th className="num">Unrealised</th>
              </tr>
            </thead>
            <tbody>
              {v.positions.map((p) => {
                const pnl = p.marketValueCents - p.costCents;
                return (
                  <tr key={p.symbol}>
                    <td style={{ fontWeight: 600 }}>{p.symbol}</td>
                    <td className="num">{formatUnits(p.units)}</td>
                    <td className="num">
                      ${p.priceCents.div(100).toFixed(2)}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {p.priceDate}
                      {p.priceAgeDays > 0 && (
                        <span className="dim"> ({p.priceAgeDays}d old)</span>
                      )}
                    </td>
                    <td className="num">{formatCents(p.marketValueCents)}</td>
                    <td className="num">{formatCents(p.costCents)}</td>
                    <td
                      className="num"
                      style={{ color: pnl >= 0n ? 'var(--accent)' : 'var(--danger)' }}
                    >
                      {formatCents(pnl)}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td style={{ fontWeight: 650 }}>Total</td>
                <td />
                <td />
                <td />
                <td className="num" style={{ fontWeight: 650 }}>
                  {formatCents(v.positionsValueCents)}
                </td>
                <td className="num" style={{ fontWeight: 650 }}>
                  {formatCents(v.costBasisCents)}
                </td>
                <td
                  className="num"
                  style={{
                    fontWeight: 650,
                    color: unrealised >= 0n ? 'var(--accent)' : 'var(--danger)',
                  }}
                >
                  {formatCents(unrealised)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {v && v.unpriced.length > 0 && (
        <div className="callout callout-warn">
          <p style={{ margin: 0 }}>
            <strong>No price available for {v.unpriced.join(', ')}.</strong> These
            holdings are excluded from the value above rather than counted as zero,
            because a missing price is not a price of nothing.
          </p>
        </div>
      )}

      {/* --------------- activity --------------- */}
      <h2>Recent activity</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {data.activity.length === 0 && (
              <tr>
                <td colSpan={3} className="dim">
                  Nothing yet.
                </td>
              </tr>
            )}
            {data.activity.map((a, i) => (
              <tr key={i}>
                <td className="mono" style={{ fontSize: 12 }}>
                  {new Date(a.effective_at).toISOString().slice(0, 10)}
                </td>
                <td>
                  <span className="badge badge-muted">{a.kind}</span>
                </td>
                <td className="dim">{a.narrative}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="dim" style={{ fontSize: 12, marginTop: 14 }}>
        Every figure on this page is derived from journal entries — see{' '}
        <a href="/ledger">the ledger</a> for the entries behind them.
        {data.perf && data.perf.missingValuationDays.length > 0 && (
          <>
            {' '}
            {data.perf.missingValuationDays.length} day(s) in the period have no
            valuation and were skipped rather than assumed flat.
          </>
        )}
      </p>
    </>
  );
}
