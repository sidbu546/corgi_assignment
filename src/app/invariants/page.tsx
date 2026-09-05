import { runInvariants, type InvariantReport } from '@/lib/ledger/invariants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function InvariantsPage() {
  let report: InvariantReport | null = null;
  let error: string | null = null;

  try {
    report = await runInvariants();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const groups = report
    ? [...new Set(report.checks.map((c) => c.group))]
    : [];

  return (
    <>
      <h1>Invariants</h1>
      <p className="lede">
        This page does not report what the ledger is <em>supposed</em> to do. It
        attempts every forbidden operation against the live database — right now,
        on this request — and requires Postgres to refuse each one. Everything runs
        inside a transaction that is rolled back, so nothing here changes any data.
      </p>

      {error && (
        <div className="callout callout-warn">
          <p>
            <strong>The suite could not run.</strong> That is itself a finding, and
            it is shown rather than hidden.
          </p>
          <p className="mono dim">{error}</p>
        </div>
      )}

      {report && (
        <>
          <div
            className="card"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              flexWrap: 'wrap',
              marginBottom: 16,
            }}
          >
            <div>
              <div
                className="stat"
                style={{ color: report.allHold ? 'var(--accent)' : 'var(--danger)' }}
              >
                {report.passed}/{report.total}
              </div>
              <div className="stat-label">Invariants holding</div>
            </div>
            <div className="spacer" />
            <dl style={{ margin: 0, minWidth: 240 }}>
              <div className="kv">
                <dt>Ran at</dt>
                <dd>{report.ranAt}</dd>
              </div>
              <div className="kv">
                <dt>Duration</dt>
                <dd>{report.durationMs} ms</dd>
              </div>
              <div className="kv">
                <dt>Data changed</dt>
                <dd>none — rolled back</dd>
              </div>
            </dl>
          </div>

          {groups.map((group) => {
            const checks = report!.checks.filter((c) => c.group === group);
            const failed = checks.filter((c) => !c.passed).length;
            return (
              <section key={group}>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {group}
                  <span
                    className={`badge ${failed === 0 ? 'badge-live' : 'badge-down'}`}
                  >
                    {failed === 0 ? `${checks.length} holding` : `${failed} failing`}
                  </span>
                </h2>
                <div className="table-wrap">
                  {checks.map((c) => (
                    <div
                      key={c.name}
                      className={`check ${c.passed ? 'check-pass' : 'check-fail'}`}
                    >
                      <span className="check-mark">{c.passed ? 'PASS' : 'FAIL'}</span>
                      <span className="check-body">
                        <span className="check-name">{c.name}</span>
                        <br />
                        <span className="check-evidence">{c.evidence}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}

      <h2>Why this page exists</h2>
      <p>
        &ldquo;Money rows are append-only&rdquo; is a claim. Claims are cheap, and an
        immutability guarantee that lives in application code is not a guarantee at
        all — it is a convention, one careless migration or one psql session away
        from being false.
      </p>
      <p>
        So the guarantee is enforced by Postgres: <code className="mono">BEFORE
        UPDATE OR DELETE</code> triggers that raise on every money table, plus{' '}
        <code className="mono">BEFORE TRUNCATE</code> statement triggers, because
        TRUNCATE bypasses row-level triggers entirely and that is the gap most
        people leave open. Those triggers fire even for the table owner.
      </p>
      <p>
        The same suite runs from the terminal as{' '}
        <code className="mono">npm run verify</code>, against the same code — one
        implementation, two surfaces, so this page cannot drift into claiming
        something the CLI does not actually test.
      </p>
    </>
  );
}
