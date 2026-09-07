import { query } from '@/lib/db';
import { trialBalance } from '@/lib/ledger/read';
import { slotStatuses } from '@/lib/providers/registry';
import { formatCents } from '@/lib/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LedgerSnapshot {
  reachable: boolean;
  error?: string;
  entries: number;
  lines: number;
  customers: number;
  balanced: boolean;
  totals: Array<{ commodity: string; cents: bigint; units: string }>;
}

async function loadLedger(): Promise<LedgerSnapshot> {
  try {
    const [counts] = await query<{
      entries: string;
      lines: string;
      customers: string;
    }>(
      `SELECT (SELECT count(*) FROM journal_entries)  AS entries,
              (SELECT count(*) FROM journal_lines)    AS lines,
              (SELECT count(*) FROM customers)        AS customers`,
    );
    const tb = await trialBalance();
    return {
      reachable: true,
      entries: Number(counts.entries),
      lines: Number(counts.lines),
      customers: Number(counts.customers),
      balanced: tb.balanced,
      totals: tb.totalsByCommodity.map((t) => ({
        commodity: t.commodity,
        cents: t.cents,
        units: t.units.toString(),
      })),
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
      entries: 0,
      lines: 0,
      customers: 0,
      balanced: false,
      totals: [],
    };
  }
}

export default async function Home() {
  const ledger = await loadLedger();
  const slots = slotStatuses();
  const live = slots.filter((s) => s.mode === 'live');
  const simulated = slots.filter((s) => s.mode === 'simulated');
  // 'blocked' is neither: a real call to a real provider that the provider
  // currently refuses. Counting it as live would overstate; as simulated would
  // understate. It gets counted nowhere and labelled precisely instead.

  return (
    <>
      <h1>Ledgerly</h1>
      <p className="lede">
        A retail investing platform built on an append-only, bitemporal,
        multi-commodity ledger. Customers pass identity checks, link a bank, deposit,
        buy into a model portfolio, and are valued daily. When the custodian is late
        with the truth, history is <strong>restated, never rewritten</strong>.
      </p>

      {/* ---------------- ledger health ---------------- */}

      <h2>Ledger</h2>

      {!ledger.reachable ? (
        <div className="callout callout-warn">
          <p>
            <strong>The database is not reachable.</strong> Every balance in this
            system is derived from journal entries, so rather than show a number we
            cannot stand behind, this page shows nothing and says why.
          </p>
          <p className="mono dim">{ledger.error}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-3" style={{ marginBottom: 12 }}>
            <div className="card">
              <div className="stat">{ledger.entries.toLocaleString()}</div>
              <div className="stat-label">Journal entries</div>
            </div>
            <div className="card">
              <div className="stat">{ledger.lines.toLocaleString()}</div>
              <div className="stat-label">Journal lines</div>
            </div>
            <div className="card">
              <div className="stat">{ledger.customers.toLocaleString()}</div>
              <div className="stat-label">Customers</div>
            </div>
          </div>

          <div className="card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                marginBottom: 8,
              }}
            >
              <strong style={{ fontSize: 13 }}>Trial balance</strong>
              <span
                className={`badge ${ledger.balanced ? 'badge-live' : 'badge-down'}`}
              >
                <span className="dot" />
                {ledger.balanced ? 'nets to zero' : 'OUT OF BALANCE'}
              </span>
            </div>
            {ledger.totals.length === 0 ? (
              <p className="dim" style={{ margin: 0 }}>
                No entries yet. Run <span className="mono">npm run seed</span> to stand
                up demo data from zero.
              </p>
            ) : (
              <dl style={{ margin: 0 }}>
                {ledger.totals.map((t) => (
                  <div className="kv" key={t.commodity}>
                    <dt>{t.commodity}</dt>
                    <dd>
                      {t.commodity === 'USD'
                        ? formatCents(t.cents)
                        : `${t.units} units`}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
              In a correct double-entry system this sums to exactly zero for every
              commodity, at every instant in history — not just today.{' '}
              <a href="/invariants">Run the full suite →</a>
            </p>
          </div>
        </>
      )}

      {/* ---------------- integrations ---------------- */}

      <h2>Integrations</h2>
      <p>
        Honest labelling is not a README claim here: the badges below are rendered
        from the same declaration the code reads, so a slot cannot quietly become a
        simulator without this page changing at the same moment.
      </p>

      <div className="grid grid-2">
        {[...live, ...simulated].map((s) => (
          <div className="card" key={s.id}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{s.slot}</div>
                <div className="dim" style={{ fontSize: 12.5 }}>
                  {s.provider}
                </div>
              </div>
              <span
                className={`badge ${
                  s.disabled
                    ? 'badge-down'
                    : s.mode === 'blocked'
                      ? 'badge-blocked'
                      : s.mode === 'live'
                        ? s.configured
                          ? 'badge-live'
                          : 'badge-muted'
                        : 'badge-sim'
                }`}
              >
                {s.disabled
                  ? 'disabled'
                  : s.mode === 'blocked'
                    ? 'live · refused'
                    : s.mode === 'live'
                      ? s.configured
                        ? 'live'
                        : 'no keys'
                      : 'simulated'}
              </span>
            </div>
            {s.endpoint && (
              <div className="mono dim" style={{ marginTop: 6 }}>
                {s.endpoint}
              </div>
            )}
            <p style={{ fontSize: 12.5, margin: '8px 0 0' }}>{s.note}</p>
          </div>
        ))}
      </div>
    </>
  );
}
