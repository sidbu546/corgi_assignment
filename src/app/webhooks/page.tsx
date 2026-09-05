import { query } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DeliveryRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  signature_valid: boolean;
  signature_detail: string | null;
  outcome: string;
  outcome_detail: string | null;
  received_at: Date;
  processed_at: Date | null;
  repeats: string;
}

const OUTCOME_BADGE: Record<string, string> = {
  processed: 'badge-live',
  duplicate: 'badge-info',
  rejected_signature: 'badge-down',
  unverifiable: 'badge-sim',
  failed: 'badge-down',
  ignored: 'badge-muted',
  received: 'badge-muted',
};

export default async function WebhooksPage() {
  let rows: DeliveryRow[] = [];
  let error: string | null = null;

  try {
    rows = await query<DeliveryRow>(
      `SELECT d.id, d.provider, d.provider_event_id, d.event_type,
              d.signature_valid, d.signature_detail, d.outcome, d.outcome_detail,
              d.received_at, d.processed_at,
              (SELECT count(*) FROM webhook_duplicate_deliveries w
                WHERE w.delivery_id = d.id) AS repeats
         FROM webhook_deliveries d
        ORDER BY d.received_at DESC
        LIMIT 100`,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const total = rows.length;
  const processed = rows.filter((r) => r.outcome === 'processed').length;
  const replays = rows.reduce((sum, r) => sum + Number(r.repeats), 0);
  const rejected = rows.filter(
    (r) => r.outcome === 'rejected_signature' || r.outcome === 'failed',
  ).length;

  const base = process.env.APP_BASE_URL ?? 'https://corgi-assignment.vercel.app';

  return (
    <>
      <h1>Webhook inbox</h1>
      <p className="lede">
        Every inbound event, whether we could process it or not, with its
        signature verdict and how many times it was delivered. Replay an event
        from a provider dashboard and it appears here as a{' '}
        <strong>duplicate</strong>: delivered twice, acted on once.
      </p>

      {error && (
        <div className="callout callout-warn">
          <p>
            <strong>Cannot read the inbox.</strong>
          </p>
          <p className="mono dim">{error}</p>
        </div>
      )}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="stat">{total}</div>
          <div className="stat-label">Deliveries recorded</div>
        </div>
        <div className="card">
          <div className="stat" style={{ color: 'var(--accent)' }}>
            {processed}
          </div>
          <div className="stat-label">Acted on exactly once</div>
        </div>
        <div className="card">
          <div className="stat" style={{ color: replays > 0 ? 'var(--info)' : undefined }}>
            {replays}
          </div>
          <div className="stat-label">Repeat deliveries absorbed</div>
        </div>
      </div>

      {rejected > 0 && (
        <div className="callout callout-warn">
          <p style={{ margin: 0 }}>
            <strong>
              {rejected} deliver{rejected === 1 ? 'y was' : 'ies were'} rejected or
              failed.
            </strong>{' '}
            They are shown below rather than hidden — a bad delivery you cannot see
            is worse than one you can.
          </p>
        </div>
      )}

      <h2>Endpoints</h2>
      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Endpoint</th>
              <th>Signature scheme</th>
              <th>Transport</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Persona</td>
              <td className="mono">{base}/api/webhooks/persona</td>
              <td>HMAC-SHA256 over <span className="mono">t.body</span>, 5&nbsp;min window</td>
              <td>
                <span className="badge badge-live">real webhook</span>
              </td>
            </tr>
            <tr>
              <td>Plaid</td>
              <td className="mono">{base}/api/webhooks/plaid</td>
              <td>
                ES256 JWT + <span className="mono">request_body_sha256</span> match
              </td>
              <td>
                <span className="badge badge-live">real webhook</span>
              </td>
            </tr>
            <tr>
              <td>Alpaca</td>
              <td className="mono">{base}/api/webhooks/alpaca</td>
              <td>HMAC-SHA256 shared secret (our bridge)</td>
              <td>
                <span className="badge badge-sim">SSE via bridge</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="callout">
        <p style={{ margin: 0 }}>
          <strong>Why Alpaca is different, stated plainly.</strong> Alpaca&rsquo;s
          Broker sandbox offers no webhook registration — I checked rather than
          assumed: <span className="mono">/v1/webhooks</span>,{' '}
          <span className="mono">/v2/webhooks</span> and{' '}
          <span className="mono">/v1/events/subscriptions</span> all return 404, while{' '}
          <span className="mono">/v2beta1/events/trades</span> opens an SSE stream.
          Serverless functions cannot hold a stream open, so a bridge process
          consumes the stream and posts into this same endpoint, signed. The
          transport differs from a true webhook; the idempotency, signature
          verification and replay behaviour are identical, because it is the same
          pipeline.
        </p>
      </div>

      <h2>Recent deliveries</h2>

      {total === 0 && !error && (
        <p className="dim">
          Nothing received yet. Fire a test event from a provider dashboard at the
          endpoints above and it will appear here.
        </p>
      )}

      {rows.map((r) => (
        <div className="card" key={r.id} style={{ marginBottom: 8 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: 6,
            }}
          >
            <span className="badge badge-muted">{r.provider}</span>
            <strong style={{ fontSize: 13 }}>{r.event_type}</strong>
            <span className={`badge ${OUTCOME_BADGE[r.outcome] ?? 'badge-muted'}`}>
              {r.outcome.replace('_', ' ')}
            </span>
            <span
              className={`badge ${r.signature_valid ? 'badge-live' : 'badge-down'}`}
              title={r.signature_detail ?? ''}
            >
              {r.signature_valid ? 'signature ok' : 'signature failed'}
            </span>
            {Number(r.repeats) > 0 && (
              <span className="badge badge-info">
                delivered {Number(r.repeats) + 1}&times;, acted once
              </span>
            )}
            <span className="spacer" />
            <span className="dim mono" style={{ fontSize: 11.5 }}>
              {new Date(r.received_at).toISOString()}
            </span>
          </div>

          <dl style={{ margin: 0 }}>
            <div className="kv">
              <dt>provider event id</dt>
              <dd>{r.provider_event_id}</dd>
            </div>
            <div className="kv">
              <dt>signature</dt>
              <dd style={{ textAlign: 'right', maxWidth: '60ch' }}>
                {r.signature_detail ?? '—'}
              </dd>
            </div>
            <div className="kv">
              <dt>outcome</dt>
              <dd style={{ textAlign: 'right', maxWidth: '60ch' }}>
                {r.outcome_detail ?? '—'}
              </dd>
            </div>
          </dl>
        </div>
      ))}
    </>
  );
}
