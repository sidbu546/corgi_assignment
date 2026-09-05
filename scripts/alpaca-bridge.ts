/**
 * alpaca-bridge.ts — consume Alpaca's event streams and feed our webhook
 * pipeline. This is the reason we do not poll.
 *
 * WHY THIS EXISTS, stated plainly because the honest answer matters more than
 * the convenient one:
 *
 * Alpaca's Broker sandbox offers no webhook registration — I checked rather
 * than assumed, and /v1/webhooks, /v2/webhooks, /v1/events/subscriptions and
 * /v1/events/trades/subscriptions all return 404. What it offers instead is
 * server-sent events. Vercel's serverless functions cannot hold a stream open,
 * so this process does: it subscribes to the streams and POSTs each event into
 * our own endpoint, signed with a shared secret.
 *
 * It is a BRIDGE, not a webhook, and it is labelled that way everywhere it
 * appears. What is true is that the transport differs while the guarantees do
 * not — the events land in the same consumer, with the same dedupe key, the
 * same signature verification and the same replay behaviour.
 *
 * THREE STREAMS, because three different things change asynchronously:
 *
 *   trades      fills and partial fills   -> positions, tax lots, realised gain
 *   transfers   ACH status transitions    -> pending deposit becomes settled
 *                                            cash, or bounces back out
 *   accounts    KYC / account status      -> whether the customer may transact
 *
 * RESUMPTION. Every event carries an `event_ulid`, which sorts lexicographically
 * in time order. The bridge records the last one it forwarded and resumes from
 * there after a disconnect, so a dropped connection loses nothing. Combined
 * with the idempotent consumer, resuming slightly too early is harmless —
 * re-delivered events are recorded as duplicates and acted on once.
 *
 * Run: npx tsx scripts/alpaca-bridge.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { createHmac } from 'node:crypto';

const BASE = process.env.ALPACA_BROKER_BASE_URL!;
const TARGET = process.env.APP_BASE_URL!;
const SECRET = process.env.ALPACA_WEBHOOK_SECRET;

if (!SECRET) {
  console.error(
    'ALPACA_WEBHOOK_SECRET is not set. The bridge signs every event it forwards; ' +
      'without the secret the endpoint would reject them all, which is correct.',
  );
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(
  `${process.env.ALPACA_BROKER_KEY_ID}:${process.env.ALPACA_BROKER_SECRET}`,
).toString('base64')}`;

interface StreamSpec {
  name: 'trades' | 'transfers' | 'accounts';
  path: string;
}

const STREAMS: StreamSpec[] = [
  { name: 'trades', path: '/v2beta1/events/trades' },
  { name: 'transfers', path: '/v1/events/transfers/status' },
  { name: 'accounts', path: '/v1/events/accounts/status' },
];

/** Last forwarded ulid per stream, so a reconnect resumes rather than replays. */
const cursor = new Map<string, string>();

let forwarded = 0;
let duplicates = 0;
let failures = 0;

function sign(body: string): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SECRET!)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { signature, timestamp };
}

async function forward(stream: string, event: Record<string, unknown>) {
  const body = JSON.stringify({ ...event, _stream: stream });
  const { signature, timestamp } = sign(body);

  try {
    const response = await fetch(`${TARGET}/api/webhooks/alpaca`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ledgerly-signature': signature,
        'x-ledgerly-timestamp': timestamp,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => ({}))) as {
      outcome?: string;
      detail?: string;
    };

    if (json.outcome === 'duplicate') duplicates++;
    else if (json.outcome === 'processed') forwarded++;
    else failures++;

    console.log(
      `  [${stream}] ${String(event.event ?? event.status_to ?? 'event').padEnd(16)} ` +
        `-> ${json.outcome ?? response.status}  ${(json.detail ?? '').slice(0, 90)}`,
    );
  } catch (error) {
    failures++;
    console.error(
      `  [${stream}] forward failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Read one SSE stream until it ends, forwarding each event.
 *
 * Deliberately hand-rolled rather than using an EventSource polyfill: the
 * parsing is fifteen lines, and a dependency here would be one more thing to
 * explain that does less than it looks.
 */
async function consume(spec: StreamSpec, since: string): Promise<void> {
  const resumeFrom = cursor.get(spec.name);
  const query = resumeFrom
    ? `since_ulid=${encodeURIComponent(resumeFrom)}`
    : `since=${encodeURIComponent(since)}`;

  const url = `${BASE}${spec.path}?${query}`;
  console.log(`[${spec.name}] connecting  ${resumeFrom ? `from ulid ${resumeFrom}` : `since ${since}`}`);

  const response = await fetch(url, { headers: { Authorization: AUTH } });
  if (!response.ok || !response.body) {
    throw new Error(`${spec.name}: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue; // ':' comments are keep-alives
        const payload = line.slice(5).trim();
        if (!payload) continue;

        try {
          const event = JSON.parse(payload) as Record<string, unknown>;
          if (typeof event.event_ulid === 'string') {
            cursor.set(spec.name, event.event_ulid);
          }
          await forward(spec.name, event);
        } catch {
          console.error(`  [${spec.name}] unparseable frame: ${payload.slice(0, 120)}`);
        }
      }
    }
  }
}

/** Reconnect with capped exponential backoff. A stream that ends is normal. */
async function runStream(spec: StreamSpec, since: string) {
  let backoffMs = 1000;
  for (;;) {
    try {
      await consume(spec, since);
      backoffMs = 1000; // clean end: reconnect promptly
    } catch (error) {
      console.error(
        `[${spec.name}] ${error instanceof Error ? error.message : error}; ` +
          `retrying in ${backoffMs}ms`,
      );
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
    await new Promise((r) => setTimeout(r, backoffMs));
  }
}

async function main() {
  const since = process.argv[2] ?? new Date().toISOString().slice(0, 10);

  console.log('Alpaca event bridge');
  console.log(`  source  ${BASE}`);
  console.log(`  target  ${TARGET}/api/webhooks/alpaca`);
  console.log(`  streams ${STREAMS.map((s) => s.name).join(', ')}`);
  console.log(`  since   ${since}\n`);
  console.log('Every event is signed and forwarded into the same idempotent');
  console.log('consumer the real webhooks use. Ctrl-C to stop.\n');

  setInterval(() => {
    console.log(
      `  --- forwarded ${forwarded}, deduped ${duplicates}, failed ${failures} ---`,
    );
  }, 60_000).unref?.();

  await Promise.all(STREAMS.map((spec) => runStream(spec, since)));
}

main().catch((error) => {
  console.error('\nbridge crashed:', error);
  process.exit(1);
});
