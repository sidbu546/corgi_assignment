/**
 * /asof — the two time axes, on screen, as a thing you can move.
 *
 * Every read in this system already takes a bitemporal coordinate: `read.ts`
 * has carried `asOf` and `knownAt` since the first migration, and valuation,
 * performance and restatement all thread them through. None of it was reachable
 * from a browser. A capability nobody can exercise is indistinguishable from one
 * that does not work, and "we are bitemporal" is exactly the claim a reviewer
 * should refuse to take on trust.
 *
 * The page asks one question three ways, which is the distinction the doc
 * comment at the top of read.ts sets out:
 *
 *   now      asOf = now,  knownAt = now   what is the balance
 *   revised  asOf = D,    knownAt = now   what was the balance on D, given
 *                                         everything we have learned since
 *   original asOf = D,    knownAt = D     what we BELIEVED on D, before the
 *                                         late dividend and the corrected close
 *
 * `revised` and `original` differ by exactly the facts that arrived late, and
 * the page ends by listing them — entries effective on or before D that were
 * recorded after D. That list is the audit answer to "why did this number
 * change", derived rather than narrated: it is the same predicate that produced
 * the difference above it, run again for its rows instead of its sums.
 */

import { requireOps } from '@/lib/session';
import { query } from '@/lib/db';
import { accountBalances, cashPosition, positions, trialBalance } from '@/lib/ledger/read';
import { formatCents, formatUnits, type Cents } from '@/lib/money';
import { marketDateOf, type MarketDate } from '@/lib/calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Midnight at the END of a New York calendar day, as an instant.
 *
 * This is the same trap the valuation queries fell into: a MarketDate is a New
 * York calendar day, and `new Date('2026-09-03')` is midnight UTC, which is
 * 20:00 on 2 September in New York. Using that as the knownAt bound would cut
 * four hours off the wrong end of the day and make the "as we knew then" column
 * quietly miss everything booked on the evening of the day itself.
 */
function endOfMarketDay(date: MarketDate): Date {
  // Ask Postgres? No — this is pure arithmetic and belongs in the process that
  // needs it. -04:00 is EDT, which holds for every date this system has data
  // for; a system with a longer history would resolve the offset per date.
  return new Date(`${date}T23:59:59.999-04:00`);
}

interface Coordinate {
  key: string;
  label: string;
  gloss: string;
  asOf: Date;
  knownAt: Date;
}

interface Snapshot {
  coordinate: Coordinate;
  settled: Cents;
  unsettledProceeds: Cents;
  pendingDeposits: Cents;
  holdings: Array<{ symbol: string; units: string; cost: Cents }>;
  firmBalanced: boolean;
}

async function snapshot(customerId: string, coordinate: Coordinate): Promise<Snapshot> {
  const opts = { asOf: coordinate.asOf, knownAt: coordinate.knownAt };
  const [cash, held, tb] = await Promise.all([
    cashPosition(customerId, opts),
    positions(customerId, opts),
    // Firm-wide, not customer-scoped: a single customer's slice of a double
    // entry does not sum to zero and never should. The claim being tested is
    // that the WHOLE book balances at this historical instant.
    trialBalance(opts),
  ]);

  return {
    coordinate,
    settled: cash.settled,
    unsettledProceeds: cash.unsettledProceeds,
    pendingDeposits: cash.pendingDeposits,
    holdings: held.map((p) => ({
      symbol: p.symbol,
      units: formatUnits(p.units),
      cost: p.costCents,
    })),
    firmBalanced: tb.balanced,
  };
}

interface LateFact {
  entry_id: string;
  kind: string;
  narrative: string;
  effective_at: Date;
  recorded_at: Date;
  corrects_entry_id: string | null;
  reverses_entry_id: string | null;
}

export default async function AsOfPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; date?: string }>;
}) {
  await requireOps();
  const params = await searchParams;

  // Ordered by how much history each has, not alphabetically, because the first
  // one is the default and a default that lands on an empty book teaches the
  // reviewer nothing. The customer with the most lines is the one whose splits,
  // settlements and corrections are worth travelling through.
  const customers = await query<{ id: string; legal_name: string; lines: number }>(
    `SELECT c.id, c.legal_name, count(l.id)::int AS lines
       FROM customers c
       JOIN journal_lines l ON l.customer_id = c.id
      GROUP BY c.id, c.legal_name
      ORDER BY count(l.id) DESC, c.legal_name`,
  );

  if (customers.length === 0) {
    return (
      <>
        <h1>As at</h1>
        <div className="callout callout-warn">
          <p style={{ margin: 0 }}>
            No customer has a ledger entry yet, so there is no history to travel
            through. Fund an account first.
          </p>
        </div>
      </>
    );
  }

  const selected =
    customers.find((c) => c.id === params.customer) ?? customers[0];

  const today = marketDateOf(new Date());
  // Default to the earliest date with entries, which is where the restatement
  // machinery has had the most time to act. Defaulting to today would show
  // three identical columns and teach the reviewer nothing.
  const firstEntry = await query<{ d: MarketDate | null }>(
    `SELECT to_char(min(e.effective_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid`,
    [selected.id],
  );
  const asOfDate: MarketDate = params.date || firstEntry[0]?.d || today;

  const now = new Date();
  const endOfThatDay = endOfMarketDay(asOfDate);

  // When our records begin. The seeded history is backdated in EFFECTIVE time —
  // trades in June, settlements in August — but every one of those rows was
  // recorded when the seed ran, and none of them claims otherwise. So for any
  // as-at date before that instant, "as we knew then" is legitimately empty: we
  // knew nothing, because we did not exist.
  //
  // That empty column is the honest answer and it reads like a bug, so the page
  // says which it is. It is also the strongest thing on this screen: a seed that
  // faked its audit trail would backdate recorded_at too, and this column would
  // be full.
  const recordsBegin = (
    await query<{ t: Date | null }>(`SELECT min(recorded_at) AS t FROM journal_entries`)
  )[0]?.t;
  const beforeOurRecords = recordsBegin !== null && recordsBegin !== undefined
    && endOfThatDay < recordsBegin;

  const coordinates: Coordinate[] = [
    {
      key: 'now',
      label: 'Today',
      gloss: 'asOf = now · knownAt = now',
      asOf: now,
      knownAt: now,
    },
    {
      key: 'revised',
      label: `${asOfDate}, as we know now`,
      gloss: `asOf = ${asOfDate} · knownAt = now`,
      asOf: endOfThatDay,
      knownAt: now,
    },
    {
      key: 'original',
      label: `${asOfDate}, as we knew then`,
      gloss: `asOf = ${asOfDate} · knownAt = ${asOfDate} 23:59 ET`,
      asOf: endOfThatDay,
      knownAt: endOfThatDay,
    },
  ];

  const snapshots = await Promise.all(
    coordinates.map((c) => snapshot(selected.id, c)),
  );
  const [, revised, original] = snapshots;

  // The facts that arrived late: effective on or before the date, recorded
  // after it. This is the same predicate pair that produces the difference
  // between the last two columns, asked for its rows instead of its sums — so
  // the explanation cannot drift from the number it explains.
  const lateFacts = await query<LateFact>(
    `SELECT DISTINCT e.id AS entry_id, e.kind, e.narrative, e.effective_at,
            e.recorded_at, e.corrects_entry_id, e.reverses_entry_id
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
      WHERE l.customer_id = $1::uuid
        AND e.effective_at <= $2::timestamptz
        AND e.recorded_at  >  $2::timestamptz
      ORDER BY e.recorded_at`,
    [selected.id, endOfThatDay],
  );

  const investable = (s: Snapshot) => s.settled + s.unsettledProceeds;
  const drift = investable(revised) - investable(original);

  // Every symbol appearing at any coordinate, so a position that existed then
  // and not now (or the reverse) still gets a row rather than vanishing.
  const symbols = [
    ...new Set(snapshots.flatMap((s) => s.holdings.map((h) => h.symbol))),
  ].sort();

  const cell = (s: Snapshot, symbol: string) =>
    s.holdings.find((h) => h.symbol === symbol);

  return (
    <>
      <h1>As at</h1>
      <p className="lede">
        The ledger has two time axes and every read in the system takes both.
        This is the pair made movable: <strong>when something happened</strong>{' '}
        against <strong>when we found out</strong>. The last two columns share an
        as-of date and differ only in what had been recorded by then.
      </p>

      <form method="get" className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              Customer
            </div>
            <select
              name="customer"
              defaultValue={selected.id}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontSize: 13,
              }}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.legal_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <div className="stat-label" style={{ marginBottom: 4 }}>
              As at date
            </div>
            <input
              type="date"
              name="date"
              defaultValue={asOfDate}
              max={today}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                fontSize: 13,
              }}
            />
          </label>
          <button className="btn btn-primary" type="submit">
            Show the book
          </button>
        </div>
        <p className="dim" style={{ fontSize: 12, margin: '10px 0 0' }}>
          Nothing here writes. Every figure is folded from journal lines under
          two <span className="mono">WHERE</span> clauses — there is no snapshot
          table to go stale, and no historical figure that can be edited, because
          the rows it derives from cannot be.
        </p>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              {snapshots.map((s) => (
                <th key={s.coordinate.key} style={{ textAlign: 'right' }}>
                  <div>{s.coordinate.label}</div>
                  <div className="mono dim" style={{ fontSize: 11, fontWeight: 400 }}>
                    {s.coordinate.gloss}
                  </div>
                  {s.coordinate.key === 'original' && beforeOurRecords && (
                    <div
                      className="badge badge-info"
                      style={{ marginTop: 4, fontWeight: 400 }}
                    >
                      we had no records yet
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">assets:cash:settled</td>
              {snapshots.map((s) => (
                <td key={s.coordinate.key} className="mono" style={{ textAlign: 'right' }}>
                  {formatCents(s.settled)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="mono">assets:cash:unsettled_proceeds</td>
              {snapshots.map((s) => (
                <td key={s.coordinate.key} className="mono" style={{ textAlign: 'right' }}>
                  {formatCents(s.unsettledProceeds)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="mono">
                assets:cash:pending_deposit
                <div className="dim" style={{ fontSize: 11.5 }}>
                  in flight — excluded from portfolio value
                </div>
              </td>
              {snapshots.map((s) => (
                <td key={s.coordinate.key} className="mono" style={{ textAlign: 'right' }}>
                  {formatCents(s.pendingDeposits)}
                </td>
              ))}
            </tr>

            {symbols.map((symbol) => (
              <tr key={symbol}>
                <td className="mono">
                  {symbol}
                  <div className="dim" style={{ fontSize: 11.5 }}>
                    units · cost basis
                  </div>
                </td>
                {snapshots.map((s) => {
                  const h = cell(s, symbol);
                  return (
                    <td
                      key={s.coordinate.key}
                      className="mono"
                      style={{ textAlign: 'right' }}
                    >
                      {h ? (
                        <>
                          {h.units}
                          <div className="dim" style={{ fontSize: 11.5 }}>
                            {formatCents(h.cost)}
                          </div>
                        </>
                      ) : (
                        <span className="dim">not held</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}

            <tr>
              <td>
                <strong>Firm trial balance</strong>
                <div className="dim" style={{ fontSize: 11.5 }}>
                  every account, every commodity, at this instant
                </div>
              </td>
              {snapshots.map((s) => (
                <td key={s.coordinate.key} style={{ textAlign: 'right' }}>
                  <span className={`badge ${s.firmBalanced ? 'badge-live' : 'badge-down'}`}>
                    {s.firmBalanced ? 'sums to zero' : 'DOES NOT BALANCE'}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <h2>What changed, and why</h2>

      {beforeOurRecords && recordsBegin && (
        <div className="callout" style={{ marginBottom: 12 }}>
          <p style={{ margin: 0 }}>
            <strong>The third column is empty, and that is the correct answer.</strong>{' '}
            Our records begin{' '}
            <span className="mono">
              {recordsBegin.toISOString().slice(0, 16).replace('T', ' ')}Z
            </span>
            , which is after {asOfDate}. On that date we knew nothing, so a
            faithful &ldquo;as we knew then&rdquo; has nothing in it.
          </p>
          <p className="dim" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
            The seeded history is backdated in <strong>effective</strong> time —
            trades in June, settlements in August — and truthful in{' '}
            <strong>record</strong> time: every one of those rows carries the
            timestamp at which it was actually written. A seed that faked its
            audit trail would have backdated{' '}
            <span className="mono">recorded_at</span> as well, and this column
            would be full of figures nobody could have known. Pick a date after{' '}
            {marketDateOf(recordsBegin)} to see the two columns diverge on real
            late-arriving facts instead.
          </p>
        </div>
      )}

      {lateFacts.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            Nothing was recorded after {asOfDate} that was effective on or before
            it, so the last two columns are identical — and that is the honest
            result, not a missing feature. Restatement is not a code path here;
            it is a later <span className="mono">recorded_at</span>. With no late
            fact there is nothing to restate.
          </p>
          <p className="dim" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
            What would separate them is a late <em>entry</em> — a settlement
            booked after the fact, a reversal, a correction re-booked with its
            original effective date. Note that a corrected close would{' '}
            <strong>not</strong> move these figures: a price is a separate fact
            with its own as-of semantics, so it changes valuation and the return
            rather than the units and cash below. That restatement is visible on{' '}
            <a href="/restatements">Restatements</a>; this screen is the ledger
            underneath it.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <p style={{ margin: 0 }}>
              <strong>{lateFacts.length}</strong>{' '}
              {lateFacts.length === 1 ? 'fact was' : 'facts were'} effective on or
              before {asOfDate} but recorded after it. They are the entire
              difference between the last two columns
              {drift !== 0n && (
                <>
                  {' '}
                  — investable cash moved{' '}
                  <span className="mono">
                    {drift > 0n ? '+' : ''}
                    {formatCents(drift)}
                  </span>
                </>
              )}
              .
            </p>
            <p className="dim" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
              None of these edited a historical row. Each is an{' '}
              <em>additional</em> entry with an earlier{' '}
              <span className="mono">effective_at</span> and a later{' '}
              <span className="mono">recorded_at</span>, which is why the
              &ldquo;as we knew then&rdquo; column can still be reproduced at all.
            </p>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Effective</th>
                  <th>Recorded</th>
                  <th>Kind</th>
                  <th>What it was</th>
                </tr>
              </thead>
              <tbody>
                {lateFacts.map((f) => (
                  <tr key={f.entry_id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {f.effective_at.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {f.recorded_at.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td>
                      <span className="badge badge-info">{f.kind}</span>
                      {f.corrects_entry_id && (
                        <span className="badge badge-sim" style={{ marginLeft: 4 }}>
                          corrects
                        </span>
                      )}
                      {f.reverses_entry_id && (
                        <span className="badge badge-sim" style={{ marginLeft: 4 }}>
                          reverses
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{f.narrative}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            Times are UTC, as stored. The as-at date is a New York market day, so
            the boundary between the two columns is 23:59 Eastern on {asOfDate} —
            not midnight UTC, which would cut four hours off the wrong end of the
            day.
          </p>
        </>
      )}
    </>
  );
}
