import { query } from '@/lib/db';
import { trialBalance } from '@/lib/ledger/read';
import { formatCents } from '@/lib/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LineRow {
  entry_id: string;
  kind: string;
  effective_at: Date;
  recorded_at: Date;
  narrative: string;
  created_by: string;
  source: string;
  reverses_entry_id: string | null;
  corrects_entry_id: string | null;
  account_code: string;
  commodity: string;
  amount_cents: bigint | null;
  units: string | null;
  related_symbol: string | null;
}

export default async function LedgerPage() {
  let rows: LineRow[] = [];
  let tb: Awaited<ReturnType<typeof trialBalance>> | null = null;
  let error: string | null = null;

  try {
    rows = await query<LineRow>(
      `SELECT e.id AS entry_id, e.kind, e.effective_at, e.recorded_at, e.narrative,
              e.created_by, e.source, e.reverses_entry_id, e.corrects_entry_id,
              l.account_code, l.commodity, l.amount_cents, l.units, l.related_symbol
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.id IN (
              SELECT id FROM journal_entries
               ORDER BY recorded_at DESC LIMIT 25
        )
        ORDER BY e.recorded_at DESC, e.id, l.id`,
    );
    tb = await trialBalance();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Group lines under their entry, preserving order.
  const entries: Array<{ header: LineRow; lines: LineRow[] }> = [];
  for (const row of rows) {
    const last = entries[entries.length - 1];
    if (last && last.header.entry_id === row.entry_id) last.lines.push(row);
    else entries.push({ header: row, lines: [row] });
  }

  return (
    <>
      <h1>Ledger</h1>
      <p className="lede">
        The journal itself. Every entry carries two dates —{' '}
        <strong>effective_at</strong>, when it economically happened, and{' '}
        <strong>recorded_at</strong>, when we learned it. Those two axes are what
        make &ldquo;what did we believe on 3 September&rdquo; answerable, and they
        are why a correction is a reversal plus a re-book rather than an edit.
      </p>

      {error && (
        <div className="callout callout-warn">
          <p>
            <strong>Cannot read the journal.</strong> No balance is shown, because
            every balance in this system is derived from these rows and there is
            nothing else to fall back on.
          </p>
          <p className="mono dim">{error}</p>
        </div>
      )}

      {tb && (
        <>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            Trial balance
            <span className={`badge ${tb.balanced ? 'badge-live' : 'badge-down'}`}>
              <span className="dot" />
              {tb.balanced ? 'nets to zero' : 'OUT OF BALANCE'}
            </span>
          </h2>

          {tb.rows.length === 0 ? (
            <div className="callout">
              <p style={{ margin: 0 }}>
                No entries yet. Run <code className="mono">npm run seed</code> to
                stand up believable demo data from zero.
              </p>
            </div>
          ) : (
            <div className="table-wrap" style={{ marginBottom: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Commodity</th>
                    <th className="num">Cents</th>
                    <th className="num">Units</th>
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((r) => (
                    <tr key={`${r.account}-${r.commodity}`}>
                      <td className="mono">{r.account}</td>
                      <td>{r.commodity}</td>
                      <td className="num">
                        {r.commodity === 'USD' ? formatCents(r.cents) : '—'}
                      </td>
                      <td className="num">
                        {r.commodity === 'USD' ? '—' : r.units.toString()}
                      </td>
                    </tr>
                  ))}
                  {tb.totalsByCommodity.map((t) => (
                    <tr key={`total-${t.commodity}`}>
                      <td style={{ fontWeight: 650 }}>Total {t.commodity}</td>
                      <td />
                      <td className="num" style={{ fontWeight: 650 }}>
                        {t.commodity === 'USD' ? formatCents(t.cents) : '—'}
                      </td>
                      <td className="num" style={{ fontWeight: 650 }}>
                        {t.commodity === 'USD' ? '—' : t.units.toString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h2>Recent entries</h2>
      {entries.length === 0 && !error && (
        <p className="dim">Nothing posted yet.</p>
      )}

      {entries.map(({ header, lines }) => (
        <div className="card" key={header.entry_id} style={{ marginBottom: 10 }}>
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'baseline',
              flexWrap: 'wrap',
              marginBottom: 8,
            }}
          >
            <span className="badge badge-muted">{header.kind}</span>
            {header.reverses_entry_id && (
              <span className="badge badge-sim">reversal</span>
            )}
            {header.corrects_entry_id && (
              <span className="badge badge-info">re-book</span>
            )}
            <strong style={{ fontSize: 13 }}>{header.narrative}</strong>
          </div>

          <dl style={{ margin: '0 0 10px' }}>
            <div className="kv">
              <dt>effective_at — when it happened</dt>
              <dd>{new Date(header.effective_at).toISOString()}</dd>
            </div>
            <div className="kv">
              <dt>recorded_at — when we learned it</dt>
              <dd>{new Date(header.recorded_at).toISOString()}</dd>
            </div>
            <div className="kv">
              <dt>source / author</dt>
              <dd>
                {header.source} / {header.created_by}
              </dd>
            </div>
          </dl>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Commodity</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="mono">
                      {l.account_code}
                      {l.related_symbol && (
                        <span className="dim"> ({l.related_symbol})</span>
                      )}
                    </td>
                    <td>{l.commodity}</td>
                    <td className="num">
                      {l.commodity === 'USD'
                        ? formatCents(l.amount_cents ?? 0n)
                        : `${l.units} units`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
