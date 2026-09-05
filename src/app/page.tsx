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
                    : s.mode === 'live'
                      ? s.configured
                        ? 'badge-live'
                        : 'badge-muted'
                      : 'badge-sim'
                }`}
              >
                {s.disabled
                  ? 'disabled'
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

      {/* ---------------- what is built ---------------- */}

      <h2>Build status</h2>
      <p>
        Written in the order the money flows, ledger first. This section is kept
        current rather than aspirational — anything not listed as done is not done.
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th>State</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                'Multi-commodity double-entry ledger',
                'done',
                '20/20 invariants proven against Postgres',
              ],
              ['Money primitives and the rounding penny', 'done', '15 unit tests'],
              ['Tax lots, FIFO, realised gain', 'done', '11 unit tests incl. basis drift'],
              ['Time-weighted return', 'done', '13 unit tests incl. flow neutrality'],
              ['Provider registry with kill switch', 'done', 'this page'],
              ['Market calendar, T+1 settlement', 'done', '17 unit tests'],
              ['Daily valuation with stale-price handling', 'done', '88 runs backfilled'],
              ['Seed script from zero', 'done', 'npm run seed -- --reset'],
              [
                'Auth, customer portfolio, ops console',
                'done',
                'npx tsx scripts/smoke-ui.ts — 22/22 incl. role separation',
              ],
              [
                'Webhooks: verified, idempotent, replay-proof',
                'done',
                'npm run replay-test — 6/6 against the deployed system',
              ],
              [
                'Event bridge: 3 Alpaca SSE streams, no polling',
                'done',
                'npm run bridge — restart re-delivers, every event dedupes',
              ],
              [
                'KYC onboarding — real Persona inquiry + webhooks',
                'done',
                'npx tsx scripts/smoke-kyc.ts — approved AND declined paths',
              ],
              [
                'Open banking — Plaid Link, owner check, deposit',
                'done',
                '/fund — a stranger’s account is refused at the name check',
              ],
              [
                'Custodian simulator + classified reconciliation',
                'done',
                'npm run recon — clean run 0 breaks; --plant surfaces 2',
              ],
              [
                'Restatement — as-published vs as-corrected',
                'done',
                'npm run restate — 9/9 properties, zero UPDATEs',
              ],
              [
                'Whole core loop, one command, from zero',
                'done',
                'npm run happy-path — 14/14 against 3 live providers',
              ],
              [
                'A FILLED Alpaca order',
                'blocked',
                'orders submit for real and are correctly refused pre-settlement; sandbox ACH settles on trading days',
              ],
              ['MCP agent surface', 'not started', '—'],
              ['Maker-checker on money-out', 'partial', 'schema + queue; no execution path yet'],
            ].map(([name, state, evidence]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>
                  <span
                    className={`badge ${
                      state === 'done'
                        ? 'badge-live'
                        : state === 'in progress' || state === 'partial'
                          ? 'badge-info'
                          : state === 'blocked'
                            ? 'badge-down'
                            : 'badge-muted'
                    }`}
                  >
                    {state}
                  </span>
                </td>
                <td className="dim" style={{ fontSize: 12.5 }}>
                  {evidence}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
