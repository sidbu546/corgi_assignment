import { withClient } from '@/lib/db';
import { requireOps } from '@/lib/session';
import ReconClient from './ReconClient';
import { formatCents } from '@/lib/money';
import { severity, type BreakClassification } from '@/lib/recon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BreakRow {
  id: string;
  legal_name: string;
  break_type: string;
  classification: BreakClassification;
  symbol: string | null;
  ours_units: string | null;
  theirs_units: string | null;
  ours_cents: bigint | null;
  theirs_cents: bigint | null;
  first_seen_at: Date;
  expected_clear_date: string | null;
  detail: string;
  resolved_at: Date | null;
  as_of_date: string;
  run_started: Date;
}

const SEVERITY_BADGE = {
  critical: 'badge-down',
  warn: 'badge-sim',
  info: 'badge-info',
} as const;

export default async function ReconPage() {
  await requireOps();

  const data = await withClient(async (client) => {
    const { rows: runs } = await client.query<{
      id: string;
      as_of_date: string;
      source: string;
      started_at: Date;
      positions_checked: number;
      breaks_found: number;
    }>(
      `SELECT id, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date, source,
              started_at, positions_checked, breaks_found
         FROM recon_runs ORDER BY started_at DESC LIMIT 10`,
    );

    // ALL breaks from the newest run PER CUSTOMER, for the newest as-of date.
    //
    // I got this wrong three times, so it is worth being precise about the shape.
    // reconcile() creates one recon_run per CUSTOMER. So:
    //
    //   DISTINCT ON (as_of_date)              -> one customer, everyone else hidden
    //   DISTINCT ON (customer_id, as_of_date) -> one BREAK per customer, the rest hidden
    //
    // Both are silently lossy, which is the worst possible failure for a screen
    // whose entire purpose is that a break must not get lost. The correct shape
    // is: pick the latest RUN per customer, then take EVERY break belonging to
    // those runs.
    //
    // The third mistake was subtler and went the other way. The latest run was
    // derived from recon_breaks, so a run that produced NO breaks could not be
    // found — and a clean reconciliation could therefore never clear the
    // previous morning's breaks. The screen kept showing two criticals while
    // the run that had just finished reported zero. recon_runs now records its
    // own customer_id, so a clean run is a first-class latest run and correctly
    // displays nothing.
    const { rows: breaks } = await client.query<BreakRow>(
      `WITH latest_run_per_customer AS (
              SELECT DISTINCT ON (r.customer_id) r.customer_id, r.id AS run_id
                FROM recon_runs r
               WHERE r.as_of_date = (SELECT max(as_of_date) FROM recon_runs)
                 AND r.customer_id IS NOT NULL
               ORDER BY r.customer_id, r.started_at DESC
       )
       SELECT b.id, c.legal_name, b.break_type, b.classification, b.symbol,
              b.ours_units, b.theirs_units, b.ours_cents, b.theirs_cents,
              b.first_seen_at,
              to_char(b.expected_clear_date, 'YYYY-MM-DD') AS expected_clear_date,
              b.detail, b.resolved_at,
              to_char(r.as_of_date, 'YYYY-MM-DD') AS as_of_date,
              r.started_at AS run_started
         FROM recon_breaks b
         JOIN latest_run_per_customer l
           ON l.run_id = b.run_id AND l.customer_id = b.customer_id
         JOIN recon_runs r ON r.id = b.run_id
         JOIN customers c ON c.id = b.customer_id
        ORDER BY
          CASE
            WHEN b.classification LIKE 'genuine.%'  THEN 0
            WHEN b.classification LIKE 'unbooked.%' THEN 1
            ELSE 2
          END,
          c.legal_name, b.first_seen_at ASC`,
    );

    return { runs, breaks };
  });

  const open = data.breaks.filter((b) => !b.resolved_at);
  const critical = open.filter((b) => severity(b.classification) === 'critical');
  const actionable = open.filter((b) => severity(b.classification) === 'warn');
  const timing = open.filter((b) => severity(b.classification) === 'info');

  const ageDays = (d: Date) =>
    Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);

  return (
    <>
      <h1>Reconciliation</h1>
      <p className="lede">
        The custodian&rsquo;s morning file, diffed against our ledger. Detecting a
        difference is trivial; the work is deciding what <em>kind</em> it is —
        because an ops team handed a flat list of every mismatch every morning
        stops reading it by Thursday, and then misses the one that mattered.
      </p>

      <ReconClient />

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div
            className="stat"
            style={{ color: critical.length ? 'var(--danger)' : 'var(--accent)' }}
          >
            {critical.length}
          </div>
          <div className="stat-label">Genuine — escalate</div>
        </div>
        <div className="card">
          <div className="stat" style={{ color: actionable.length ? 'var(--warn)' : undefined }}>
            {actionable.length}
          </div>
          <div className="stat-label">Unbooked — action required</div>
        </div>
        <div className="card">
          <div className="stat dim">{timing.length}</div>
          <div className="stat-label">Timing — clears itself</div>
        </div>
      </div>

      {open.length === 0 && (
        <div className="callout">
          <p style={{ margin: 0 }}>
            <strong>No open breaks.</strong> Our ledger and the custodian agree. A
            clean run producing zero breaks is the important half of this: noise on
            a quiet morning is what makes a breaks screen unusable on a loud one.
          </p>
        </div>
      )}

      {open.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 18 }}>
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Customer</th>
                <th>Classification</th>
                <th className="num">Ours</th>
                <th className="num">Custodian</th>
                <th className="num">Age</th>
                <th>Expected clear</th>
              </tr>
            </thead>
            <tbody>
              {open.map((b) => {
                const sev = severity(b.classification);
                return (
                  <tr key={b.id}>
                    <td>
                      <span className={`badge ${SEVERITY_BADGE[sev]}`}>{sev}</span>
                    </td>
                    <td>{b.legal_name}</td>
                    <td>
                      <div className="mono" style={{ fontSize: 12 }}>
                        {b.classification}
                      </div>
                      {b.symbol && <div className="dim">{b.symbol}</div>}
                    </td>
                    <td className="num">
                      {b.ours_units ?? (b.ours_cents !== null ? formatCents(b.ours_cents) : '—')}
                    </td>
                    <td className="num">
                      {b.theirs_units ??
                        (b.theirs_cents !== null ? formatCents(b.theirs_cents) : '—')}
                    </td>
                    <td
                      className="num"
                      style={{
                        color: ageDays(b.first_seen_at) >= 3 ? 'var(--danger)' : undefined,
                      }}
                    >
                      {ageDays(b.first_seen_at)}d
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {b.expected_clear_date ?? <span className="dim">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open.map((b) => {
        const sev = severity(b.classification);
        return (
          <div className="card" key={`d-${b.id}`} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span className={`badge ${SEVERITY_BADGE[sev]}`}>{sev}</span>
              <strong style={{ fontSize: 13 }}>
                {b.legal_name} · {b.classification}
                {b.symbol ? ` · ${b.symbol}` : ''}
              </strong>
              <span className="spacer" />
              <span className="dim mono" style={{ fontSize: 11.5 }}>
                as of {b.as_of_date}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12.5 }}>{b.detail}</p>
          </div>
        );
      })}

      <h2>How breaks are classified</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Classification</th>
              <th>Meaning</th>
              <th>What ops does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">timing.unsettled_trade</td>
              <td className="dim">
                We book on trade date; the custodian moves on settlement. Nothing is
                wrong.
              </td>
              <td className="dim">Nothing — the screen says when it clears.</td>
            </tr>
            <tr>
              <td className="mono">timing.pending_deposit</td>
              <td className="dim">
                Cash differs by exactly the deposit in flight.
              </td>
              <td className="dim">Nothing — clears on settlement.</td>
            </tr>
            <tr>
              <td className="mono">unbooked.corporate_action</td>
              <td className="dim">
                The custodian knows something we do not — a dividend paid, a fee
                charged.
              </td>
              <td className="dim">
                Book it. If it lands in a period already reported, booking it triggers
                a restatement.
              </td>
            </tr>
            <tr>
              <td className="mono">genuine.position / genuine.cash</td>
              <td className="dim">
                No benign explanation survives. Something is actually wrong.
              </td>
              <td className="dim">Escalate.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="dim" style={{ fontSize: 12.5, marginTop: 10 }}>
        Each explanation is tested against the ledger and accepted only if it
        accounts for the difference <strong>exactly</strong>. A break explained
        approximately is still a genuine break — that rule is why the cash
        difference caused by an unbooked dividend is reported once, as the
        dividend, rather than twice.
      </p>

      <h2>Recent runs</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>As of</th>
              <th>Source</th>
              <th className="num">Positions checked</th>
              <th className="num">Breaks</th>
              <th>Run at</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.length === 0 && (
              <tr>
                <td colSpan={5} className="dim">
                  No runs yet. <span className="mono">npx tsx scripts/run-recon.ts</span>
                </td>
              </tr>
            )}
            {data.runs.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.as_of_date}</td>
                <td className="mono dim" style={{ fontSize: 12 }}>
                  {r.source}
                </td>
                <td className="num">{r.positions_checked}</td>
                <td
                  className="num"
                  style={{ color: r.breaks_found > 0 ? 'var(--danger)' : 'var(--accent)' }}
                >
                  {r.breaks_found}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {new Date(r.started_at).toISOString().slice(0, 16)}Z
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
