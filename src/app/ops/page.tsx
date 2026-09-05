import { withClient } from '@/lib/db';
import { requireOps } from '@/lib/session';
import { formatCents } from '@/lib/money';
import { marketDateOf } from '@/lib/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function OpsPage() {
  const session = await requireOps();
  const today = marketDateOf(new Date());

  const data = await withClient(async (client) => {
    const { rows: customers } = await client.query<{
      id: string;
      legal_name: string;
      email: string;
      kyc: string;
      total: bigint | null;
      positions: bigint | null;
      settled: bigint | null;
    }>(
      `SELECT c.id, c.legal_name, c.email,
              coalesce((SELECT status::text FROM kyc_events k
                         WHERE k.customer_id = c.id
                         ORDER BY k.effective_at DESC, k.recorded_at DESC, k.id DESC LIMIT 1),
                       'not_started') AS kyc,
              v.total_value_cents      AS total,
              v.positions_value_cents  AS positions,
              v.settled_cash_cents     AS settled
         FROM customers c
         LEFT JOIN LATERAL (
              SELECT t.total_value_cents, t.positions_value_cents, t.settled_cash_cents
                FROM valuation_totals t
                JOIN valuation_runs r ON r.id = t.run_id
               WHERE t.customer_id = c.id
               ORDER BY r.as_of_date DESC, r.recorded_at DESC
               LIMIT 1
         ) v ON true
        WHERE c.legal_name <> 'Invariant Probe'
        ORDER BY c.created_at`,
    );

    const { rows: approvals } = await client.query<{
      id: string;
      action_type: string;
      amount_cents: bigint | null;
      requested_by: string;
      requested_by_kind: string;
      status: string;
      requested_at: Date;
    }>(
      `SELECT id, action_type, amount_cents, requested_by, requested_by_kind,
              status::text AS status, requested_at
         FROM approvals ORDER BY requested_at DESC LIMIT 20`,
    );

    const { rows: webhookStats } = await client.query<{
      provider: string;
      total: string;
      processed: string;
      rejected: string;
    }>(
      `SELECT provider,
              count(*)::text AS total,
              count(*) FILTER (WHERE outcome = 'processed')::text AS processed,
              count(*) FILTER (WHERE outcome IN ('rejected_signature','failed'))::text AS rejected
         FROM webhook_deliveries GROUP BY provider ORDER BY provider`,
    );

    return { customers, approvals, webhookStats };
  });

  const bookValue = data.customers.reduce((sum, c) => sum + (c.total ?? 0n), 0n);

  return (
    <>
      <h1>Ops console</h1>
      <p className="lede">
        Signed in as <strong>{session.displayName}</strong>. Ops can see every
        customer&rsquo;s book and act on the approval queue — but never approve
        their own request. That rule is a database constraint, not a code path;{' '}
        <a href="/invariants">the invariants page proves it</a>.
      </p>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat">{formatCents(bookValue)}</div>
          <div className="stat-label">Book value under administration</div>
        </div>
        <div className="card">
          <div className="stat">{data.customers.length}</div>
          <div className="stat-label">Customers</div>
        </div>
        <div className="card">
          <div className="stat">
            {data.approvals.filter((a) => a.status === 'pending').length}
          </div>
          <div className="stat-label">Approvals awaiting a checker</div>
        </div>
      </div>

      <h2>Customers</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>KYC</th>
              <th className="num">Settled cash</th>
              <th className="num">Positions</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.customers.map((c) => (
              <tr key={c.id}>
                <td>
                  <div style={{ fontWeight: 550 }}>{c.legal_name}</div>
                  <div className="mono dim" style={{ fontSize: 12 }}>
                    {c.email}
                  </div>
                </td>
                <td>
                  <span
                    className={`badge ${
                      c.kyc === 'approved'
                        ? 'badge-live'
                        : c.kyc === 'pending'
                          ? 'badge-sim'
                          : c.kyc === 'rejected'
                            ? 'badge-down'
                            : 'badge-muted'
                    }`}
                  >
                    {c.kyc}
                  </span>
                </td>
                <td className="num">{formatCents(c.settled ?? 0n)}</td>
                <td className="num">{formatCents(c.positions ?? 0n)}</td>
                <td className="num" style={{ fontWeight: 600 }}>
                  {formatCents(c.total ?? 0n)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12 }}>
        Totals are the latest persisted valuation for each customer, as of {today}.
      </p>

      <h2>Approval queue</h2>
      {data.approvals.length === 0 ? (
        <p className="dim">
          Nothing in the queue. Money-out above the threshold lands here, and the
          initiator can never be the approver.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th className="num">Amount</th>
                <th>Requested by</th>
                <th>Status</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {data.approvals.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.action_type}</td>
                  <td className="num">
                    {a.amount_cents !== null ? formatCents(a.amount_cents) : '—'}
                  </td>
                  <td>
                    {a.requested_by}{' '}
                    <span
                      className={`badge ${
                        a.requested_by_kind === 'agent' ? 'badge-sim' : 'badge-muted'
                      }`}
                    >
                      {a.requested_by_kind}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        a.status === 'pending'
                          ? 'badge-info'
                          : a.status === 'approved' || a.status === 'executed'
                            ? 'badge-live'
                            : 'badge-down'
                      }`}
                    >
                      {a.status}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {new Date(a.requested_at).toISOString().slice(0, 16)}Z
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Inbound events</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th className="num">Delivered</th>
              <th className="num">Processed</th>
              <th className="num">Rejected / failed</th>
            </tr>
          </thead>
          <tbody>
            {data.webhookStats.length === 0 && (
              <tr>
                <td colSpan={4} className="dim">
                  No deliveries yet.
                </td>
              </tr>
            )}
            {data.webhookStats.map((w) => (
              <tr key={w.provider}>
                <td>{w.provider}</td>
                <td className="num">{w.total}</td>
                <td className="num">{w.processed}</td>
                <td
                  className="num"
                  style={{ color: Number(w.rejected) > 0 ? 'var(--danger)' : undefined }}
                >
                  {w.rejected}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim" style={{ fontSize: 12 }}>
        Full detail, including signature verdicts and replay counts, on the{' '}
        <a href="/webhooks">webhook inbox</a>.
      </p>
    </>
  );
}
