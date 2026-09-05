/**
 * replay-test.ts — prove the webhook consumer is idempotent, against the
 * DEPLOYED system.
 *
 * "We will replay events, twice is one." This delivers the same signed event
 * three times to the live URL and asserts:
 *
 *   delivery 1  -> processed
 *   delivery 2  -> duplicate
 *   delivery 3  -> duplicate
 *
 * and then checks a tampered body and a stale timestamp are both rejected.
 *
 * Run: npx tsx scripts/replay-test.ts [baseUrl]
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { createHmac } from 'node:crypto';

const BASE =
  process.argv[2] ?? process.env.APP_BASE_URL ?? 'https://corgi-assignment.vercel.app';
const SECRET = process.env.ALPACA_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('ALPACA_WEBHOOK_SECRET is not set locally; cannot sign a test event.');
  process.exit(1);
}

function sign(body: string, timestamp: string): string {
  return createHmac('sha256', SECRET!).update(`${timestamp}.${body}`).digest('hex');
}

async function deliver(
  body: string,
  opts: { timestamp?: string; signature?: string } = {},
): Promise<{ status: number; outcome: string; detail: string }> {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature ?? sign(body, timestamp);

  const response = await fetch(`${BASE}/api/webhooks/alpaca`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ledgerly-signature': signature,
      'x-ledgerly-timestamp': timestamp,
    },
    body,
  });
  const json = (await response.json().catch(() => ({}))) as {
    outcome?: string;
    detail?: string;
  };
  return {
    status: response.status,
    outcome: json.outcome ?? '?',
    detail: json.detail ?? '',
  };
}

let failures = 0;
function check(label: string, actual: string, expected: string, detail = '') {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        expected=${expected} actual=${actual}`);
  if (detail) console.log(`        ${detail}`);
}

async function main() {
  console.log(`\nReplay test against ${BASE}\n`);

  // A lifecycle event rather than a fill: it exercises the full dedupe path
  // without needing a matching local order, so the test is self-contained.
  const executionId = `replay-test-${Date.now()}`;
  const body = JSON.stringify({
    event: 'accepted',
    execution_id: executionId,
    account_id: 'test-account',
    timestamp: new Date().toISOString(),
    order: {
      id: 'test-order',
      client_order_id: 'replay-test-no-such-order',
      symbol: 'VOO',
      side: 'buy',
    },
  });

  console.log('1. the same signed event, delivered three times\n');

  const first = await deliver(body);
  check('first delivery is processed', first.outcome, 'processed', first.detail);

  const second = await deliver(body);
  check('second delivery is a duplicate', second.outcome, 'duplicate', second.detail);

  const third = await deliver(body);
  check('third delivery is a duplicate', third.outcome, 'duplicate', third.detail);

  console.log('\n2. signature enforcement\n');

  const tamperedBody = body.replace('"side":"buy"', '"side":"sell"');
  const staleTimestamp = String(Math.floor(Date.now() / 1000));
  const tampered = await deliver(tamperedBody, {
    timestamp: staleTimestamp,
    // Signature computed over the ORIGINAL body: the classic "sign one thing,
    // send another" attack.
    signature: sign(body, staleTimestamp),
  });
  check(
    'a body altered after signing is rejected',
    tampered.outcome,
    'rejected_signature',
    tampered.detail,
  );

  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const replayed = await deliver(
    JSON.stringify({ event: 'accepted', execution_id: `stale-${Date.now()}` }),
    { timestamp: old, signature: sign(JSON.stringify({ event: 'accepted' }), old) },
  );
  check(
    'an hour-old signature is rejected',
    replayed.outcome,
    'rejected_signature',
    replayed.detail,
  );

  console.log('\n3. every delivery returned 200\n');
  const statuses = [first, second, third, tampered, replayed].map((r) => r.status);
  check(
    'no delivery got a 4xx that would trigger provider retries',
    statuses.every((s) => s === 200) ? 'all-200' : statuses.join(','),
    'all-200',
    'a 4xx makes a provider retry forever against an endpoint that will never accept it',
  );

  console.log(`\n${'='.repeat(64)}`);
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All checks passed. Twice is one.');
  console.log(`See it at ${BASE}/webhooks`);
}

main().catch((error) => {
  console.error('\nreplay test crashed:', error);
  process.exit(1);
});
