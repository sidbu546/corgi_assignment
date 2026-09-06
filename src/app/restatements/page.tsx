import Decimal from 'decimal.js';
import { withClient } from '@/lib/db';
import { requireOps } from '@/lib/session';
import { formatCents } from '@/lib/money';
import { formatPercent } from '@/lib/returns';
import RestateClient from './RestateClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULTS = {
  symbol: 'VOO',
  date: '2026-08-31',
  periodStart: '2026-08-01',
  pct: -3.5,
};

interface ReturnRow {
  id: string;
  legal_name: string;
  period_start: string;
  period_end: string;
  twr: string;
  end_value_cents: bigint;
  published_at: Date;
  restates_id: string | null;
  restatement_reason: string | null;
}

interface PriceRow {
  symbol: string;
  price_date: string;
  price_cents: string;
  is_correction: boolean;
  note: string | null;
  recorded_at: Date;
}

export default async function RestatementsPage() {
  await requireOps();

  const data = await withClient(async (client) => {
    const { rows: returns } = await client.query<ReturnRow>(
      `SELECT pr.id, c.legal_name,
              to_char(pr.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(pr.period_end, 'YYYY-MM-DD')   AS period_end,
              pr.twr, pr.end_value_cents, pr.published_at,
              pr.restates_id, pr.restatement_reason
         FROM published_returns pr
         JOIN customers c ON c.id = pr.customer_id
        ORDER BY pr.published_at DESC
        LIMIT 40`,
    );

    const { rows: prices } = await client.query<PriceRow>(
      `SELECT symbol, to_char(price_date, 'YYYY-MM-DD') AS price_date,
              price_cents, is_correction, note, recorded_at
         FROM prices
        WHERE (symbol, price_date) IN (
              SELECT symbol, price_date FROM prices
               WHERE is_correction GROUP BY symbol, price_date
        )
        ORDER BY symbol, price_date DESC, recorded_at`,
    );

    const { rows: runs } = await client.query<{
      as_of_date: string;
      trigger: string;
      recorded_at: Date;
      superseded: boolean;
      note: string | null;
    }>(
      `SELECT to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date, trigger,
              recorded_at, (supersedes_id IS NOT NULL) AS superseded, note
         FROM valuation_runs
        WHERE trigger = 'restatement'
        ORDER BY recorded_at DESC, as_of_date
        LIMIT 20`,
    );

    return { returns, prices, runs };
  });

  // Pair each restatement with the row it superseded.
  const byId = new Map(data.returns.map((r) => [r.id, r]));
  const allPairs = data.returns
    .filter((r) => r.restates_id)
    .map((r) => ({ corrected: r, original: byId.get(r.restates_id!) ?? null }))
    .filter((p) => p.original !== null) as Array<{
    corrected: ReturnRow;
    original: ReturnRow;
  }>;

  // ONLY THE CURRENT VERSION OF EACH PERIOD.
  //
  // A period can be restated many times — a demo that presses the button
  // repeatedly accumulates a pair per press, and every one of them is a real
  // historical record. Showing them all stacked meant the same customer and the
  // same period appeared several times with different numbers, which reads as
  // the page contradicting itself rather than as a version history.
  //
  // Worse in combination with the sort below: "biggest change first" floats the
  // OLDEST pair to the top forever, because the earliest published figures were
  // computed before the external-flow fix and therefore differ most. The
  // headline became a superseded comparison.
  //
  // Nothing is deleted — every version is still in published_returns, and the
  // count is surfaced so the depth is visible rather than implied.
  const versionsOf = new Map<string, number>();
  const currentPairs = new Map<string, (typeof allPairs)[number]>();
  for (const pair of allPairs) {
    const key = `${pair.corrected.legal_name}|${pair.corrected.period_start}|${pair.corrected.period_end}`;
    versionsOf.set(key, (versionsOf.get(key) ?? 0) + 1);
    const held = currentPairs.get(key);
    if (!held || pair.corrected.published_at > held.corrected.published_at) {
      currentPairs.set(key, pair);
    }
  }

  const restatements = [...currentPairs.values()]
    // Biggest change first. A correction also produces restatements that move
    // by exactly zero — the periods that SPAN the corrected date, where
    // time-weighted return telescopes — and leading with one of those reads as
    // "the restatement did nothing". They are worth showing, just not first.
    .sort((a, b) =>
      new Decimal(b.corrected.twr)
        .minus(b.original.twr)
        .abs()
        .comparedTo(new Decimal(a.corrected.twr).minus(a.original.twr).abs()),
    );

  return (
    <>
      <h1>Restatements</h1>
      <p className="lede">
        History is <strong>restated, never rewritten</strong>. When a corrected
        closing price arrives for a date we have already reported, the affected
        returns are recomputed — and the figure we originally published stays
        answerable forever, because &ldquo;what did you tell the customer on the
        3rd&rdquo; is a question a regulator asks.
      </p>

      <div className="callout">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          <strong>Nothing on this page is an UPDATE.</strong> The corrected price is
          a new <span className="mono">prices</span> row superseding the old; each
          revalued day is a new <span className="mono">valuation_runs</span> row;
          each restated return is a new{' '}
          <span className="mono">published_returns</span> row pointing at the one it
          replaces. Three append-only supersessions — which is why as-published and
          as-corrected are the same query with a different{' '}
          <span className="mono">recorded_at</span> bound, rather than a separate
          subsystem.
        </p>
      </div>

      <h2>Run the scenario</h2>
      <RestateClient defaults={DEFAULTS} />

      <div className="callout callout-warn">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          <strong>Why the corrected date is the period END, and not an interior day.</strong>{' '}
          Time-weighted return telescopes: with no external flows the chain
          (EV₁/BV₁)·(EV₂/BV₂)… cancels every intermediate value and collapses to
          end-value ÷ start-value. So correcting an interior date lowers that
          day&rsquo;s value and raises the next day&rsquo;s return by exactly the
          offsetting amount, and the cumulative figure does not move — I verified
          this numerically before believing it. A correction to the period end does
          move it, and that is also the case that actually happens: a month-end
          statement goes out, then the month-end close is corrected.
        </p>
      </div>

      {/* ---------------- as published vs as corrected ---------------- */}
      <h2>As published vs as corrected</h2>

      {restatements.length === 0 ? (
        <p className="dim">
          No restatements yet. Publish a return, then apply a corrected close.
        </p>
      ) : (
        restatements.map(({ corrected, original }) => {
          const delta = new Decimal(corrected.twr).minus(original.twr);
          const valueDelta = corrected.end_value_cents - original.end_value_cents;
          return (
            <div className="card" key={corrected.id} style={{ marginBottom: 10 }}>
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  marginBottom: 10,
                }}
              >
                <strong style={{ fontSize: 13 }}>{corrected.legal_name}</strong>
                <span className="mono dim">
                  {corrected.period_start} .. {corrected.period_end}
                </span>
                <span className="badge badge-info">restated</span>
                {(versionsOf.get(
                  `${corrected.legal_name}|${corrected.period_start}|${corrected.period_end}`,
                ) ?? 1) > 1 && (
                  <span className="dim" style={{ fontSize: 11.5 }}>
                    current version — this period has been restated{' '}
                    {versionsOf.get(
                      `${corrected.legal_name}|${corrected.period_start}|${corrected.period_end}`,
                    )}{' '}
                    times; every earlier version is still in{' '}
                    <span className="mono">published_returns</span>
                  </span>
                )}
              </div>

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
                      <td className="num">{formatPercent(new Decimal(original.twr))}</td>
                      <td className="num">{formatCents(original.end_value_cents)}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {new Date(original.published_at).toISOString().slice(0, 19)}Z
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <span className="badge badge-live">as corrected</span>
                      </td>
                      <td className="num">{formatPercent(new Decimal(corrected.twr))}</td>
                      <td className="num">{formatCents(corrected.end_value_cents)}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {new Date(corrected.published_at).toISOString().slice(0, 19)}Z
                      </td>
                    </tr>
                    <tr>
                      <td style={{ fontWeight: 650 }}>Difference</td>
                      <td
                        className="num"
                        style={{
                          fontWeight: 650,
                          color: delta.isNegative() ? 'var(--danger)' : 'var(--accent)',
                        }}
                      >
                        {formatPercent(delta)}
                      </td>
                      <td
                        className="num"
                        style={{
                          fontWeight: 650,
                          color: valueDelta < 0n ? 'var(--danger)' : 'var(--accent)',
                        }}
                      >
                        {formatCents(valueDelta)}
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>

              {delta.isZero() && (
                <p
                  className="dim"
                  style={{ fontSize: 12.5, margin: '8px 0 0', color: 'var(--warn)' }}
                >
                  <strong>Unchanged, and correctly so.</strong> This period{' '}
                  <em>spans</em> the corrected date rather than ending on it. Because
                  time-weighted return telescopes, the lower value on the corrected
                  day and the higher return the next day cancel exactly, so the
                  cumulative figure cannot move. It is restated anyway, so the
                  recomputation is on the record.
                </p>
              )}
              {corrected.restatement_reason && (
                <p className="dim" style={{ fontSize: 12, margin: '8px 0 0' }}>
                  {corrected.restatement_reason}
                </p>
              )}
              <p className="dim mono" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
                original row {original.id} — still present, never modified
              </p>
            </div>
          );
        })
      )}

      {/* ---------------- price supersession ---------------- */}
      <h2>Price supersession</h2>
      {data.prices.length === 0 ? (
        <p className="dim">No corrected prices yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Close date</th>
                <th>Version</th>
                <th className="num">Price</th>
                <th>Recorded at</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.prices.map((p, i) => (
                <tr key={i}>
                  <td>{p.symbol}</td>
                  <td className="mono">{p.price_date}</td>
                  <td>
                    <span
                      className={`badge ${p.is_correction ? 'badge-live' : 'badge-muted'}`}
                    >
                      {p.is_correction ? 'correction' : 'original'}
                    </span>
                  </td>
                  <td className="num">
                    ${new Decimal(p.price_cents).div(100).toFixed(4)}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {new Date(p.recorded_at).toISOString().slice(0, 19)}Z
                  </td>
                  <td className="dim" style={{ fontSize: 12 }}>
                    {p.note ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="dim" style={{ fontSize: 12 }}>
        Both rows exist. The original was never overwritten, which is what makes
        &ldquo;what price did we use at the time&rdquo; answerable.
      </p>

      {/* ---------------- revaluations ---------------- */}
      <h2>Revaluations triggered</h2>
      {data.runs.length === 0 ? (
        <p className="dim">None yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>As of</th>
                <th>Supersedes an earlier run</th>
                <th>Recorded at</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.as_of_date}</td>
                  <td>
                    <span className={`badge ${r.superseded ? 'badge-info' : 'badge-muted'}`}>
                      {r.superseded ? 'supersedes' : 'first run'}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {new Date(r.recorded_at).toISOString().slice(0, 19)}Z
                  </td>
                  <td className="dim" style={{ fontSize: 12 }}>
                    {r.note ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="dim" style={{ fontSize: 12 }}>
        Revaluation runs <strong>forward</strong> from the corrected date, not just
        on it. A wrong price on the 31st makes every chained return after it wrong;
        restating only that one day would leave the cumulative figure quietly
        incorrect, which is the subtlest possible way to get this wrong.
      </p>
    </>
  );
}
