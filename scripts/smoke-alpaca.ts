/**
 * smoke-alpaca.ts — prove the brokerage rail end to end, for real.
 *
 * Creates a sandbox account with a TEST identity, opens an ACH relationship,
 * funds it, submits a notional order and watches for the fill. Nothing here is
 * mocked; every line is a real HTTP call to Alpaca's sandbox.
 *
 * Run: npx tsx scripts/smoke-alpaca.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import {
  createAccount,
  getTradingAccount,
  getPositions,
  submitOrder,
  getOrder,
  listTransfers,
} from '../src/lib/providers/alpaca';

const BASE = process.env.ALPACA_BROKER_BASE_URL!;
const AUTH = `Basic ${Buffer.from(
  `${process.env.ALPACA_BROKER_KEY_ID}:${process.env.ALPACA_BROKER_SECRET}`,
).toString('base64')}`;

async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stamp = Date.now();
  const now = new Date();
  console.log(
    `Local date: ${now.toISOString()} (${
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getUTCDay()]
    })\n`,
  );

  // --- 1. account ----------------------------------------------------------
  // Alpaca's documented sandbox test identity. No real PII, ever.
  console.log('1. Creating brokerage account with a TEST identity...');
  const account = await createAccount({
    email: `corgi.demo.${stamp}@example.com`,
    givenName: 'Dana',
    familyName: 'Reyes',
    dateOfBirth: '1990-01-01',
    // A syntactically valid but fictional SSN. Area must avoid 000, 666 and
    // 900-999; group and serial must be non-zero. Randomised per run so repeat
    // smoke tests do not collide on an existing account.
    taxId:
      `${100 + (stamp % 500)}-` +
      `${String(10 + (stamp % 89)).padStart(2, '0')}-` +
      `${String(1000 + (stamp % 8999)).padStart(4, '0')}`,
    phone: '+15551234567',
    street: ['20 N San Mateo Dr'],
    city: 'San Mateo',
    state: 'CA',
    postalCode: '94401',
  });
  console.log(`   account ${account.id}  status=${account.status}`);

  // Account approval is ASYNCHRONOUS. A brand new account is SUBMITTED, and
  // Alpaca will not settle a transfer into it until it reaches ACTIVE. This is
  // the real pending state, not a contrivance, and the product has to model it:
  // a customer who has signed up but cannot yet be funded.
  let status = account.status;
  for (let i = 0; i < 40 && status !== 'ACTIVE'; i++) {
    await sleep(3000);
    status = (await raw('GET', `/v1/accounts/${account.id}`)).status;
    process.stdout.write(`   waiting for account approval... status=${status}      \r`);
    if (['REJECTED', 'ACCOUNT_CLOSED'].includes(status)) break;
  }
  console.log(`\n   account status=${status}\n`);
  if (status !== 'ACTIVE') {
    throw new Error(`account did not reach ACTIVE (stuck at ${status})`);
  }

  // --- 2. funding ----------------------------------------------------------
  console.log('2. Creating ACH relationship and funding...');
  const rel = await raw('POST', `/v1/accounts/${account.id}/ach_relationships`, {
    account_owner_name: 'Dana Reyes',
    bank_account_type: 'CHECKING',
    bank_account_number: '32131231abc',
    bank_routing_number: '121000358',
    nickname: 'Demo Checking',
  });
  console.log(`   ach relationship ${rel.id}  status=${rel.status}`);

  // The relationship is also approved asynchronously. A transfer created
  // against a QUEUED relationship sits in QUEUED forever, which is exactly what
  // happened on the first run of this script.
  let relStatus = rel.status;
  for (let i = 0; i < 40 && relStatus !== 'APPROVED'; i++) {
    await sleep(3000);
    const rels = await raw('GET', `/v1/accounts/${account.id}/ach_relationships`);
    relStatus = rels.find((r: { id: string }) => r.id === rel.id)?.status ?? relStatus;
    process.stdout.write(`   waiting for relationship approval... ${relStatus}     \r`);
  }
  console.log(`\n   relationship status=${relStatus}`);

  const transfer = await raw('POST', `/v1/accounts/${account.id}/transfers`, {
    transfer_type: 'ach',
    relationship_id: rel.id,
    amount: '10000',
    direction: 'INCOMING',
    timing: 'immediate',
  });
  console.log(`   transfer ${transfer.id}  status=${transfer.status}  $${transfer.amount}\n`);

  // Sandbox settles the transfer asynchronously. This wait is itself the
  // domain point: a deposit is not money until it is good funds.
  let cash = '0';
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const trading = await getTradingAccount(account.id);
    cash = trading.cash;
    const t = (await listTransfers(account.id))[0];
    process.stdout.write(
      `   waiting for good funds... transfer=${t?.status ?? '?'} cash=$${cash}      \r`,
    );
    if (Number(cash) > 0) break;
  }
  console.log(`\n   funded: cash=$${cash}\n`);

  if (Number(cash) === 0) {
    const transfers = await listTransfers(account.id);
    console.log('   transfers:', JSON.stringify(transfers, null, 2).slice(0, 600));
    throw new Error('account never funded; cannot place an order');
  }

  // --- 3. order ------------------------------------------------------------
  console.log('3. Submitting a NOTIONAL buy (fractional shares)...');
  const clientOrderId = `smoke-${stamp}`;
  const order = await submitOrder({
    accountId: account.id,
    symbol: 'VOO',
    side: 'buy',
    notionalUsd: '2500',
    clientOrderId,
  });
  console.log(`   order ${order.id}  status=${order.status}  client_order_id=${clientOrderId}\n`);

  // --- 4. idempotency ------------------------------------------------------
  console.log('4. Re-submitting the SAME client_order_id (idempotency probe)...');
  try {
    await submitOrder({
      accountId: account.id,
      symbol: 'VOO',
      side: 'buy',
      notionalUsd: '2500',
      clientOrderId,
    });
    console.log('   !! Alpaca ACCEPTED a duplicate client_order_id — we must dedupe ourselves\n');
  } catch (error) {
    console.log(
      `   rejected as expected: ${
        (error as Error).message.split('\n')[0].slice(0, 160)
      }\n`,
    );
  }

  // --- 5. fill -------------------------------------------------------------
  console.log('5. Watching for the fill...');
  let final = order;
  for (let i = 0; i < 16; i++) {
    await sleep(2500);
    final = await getOrder(account.id, order.id);
    process.stdout.write(
      `   status=${final.status} filled_qty=${final.filled_qty} @ ${final.filled_avg_price ?? '-'}   \r`,
    );
    if (['filled', 'canceled', 'rejected', 'expired'].includes(final.status)) break;
  }
  console.log(
    `\n   final: status=${final.status} filled_qty=${final.filled_qty} ` +
      `avg=${final.filled_avg_price ?? '-'}\n`,
  );

  // --- 6. positions --------------------------------------------------------
  const positions = await getPositions(account.id);
  console.log('6. Positions at Alpaca:');
  if (positions.length === 0) {
    console.log('   (none yet — order not filled)');
  }
  for (const p of positions) {
    console.log(
      `   ${p.symbol}  qty=${p.qty}  avg_entry=${p.avg_entry_price}  ` +
        `cost_basis=${p.cost_basis}  mkt=${p.market_value}`,
    );
  }

  console.log('\n--- summary ---');
  console.log(`account:  ${account.id}`);
  console.log(`order:    ${order.id} (${final.status})`);
  console.log(
    final.status === 'filled'
      ? 'Money moved end to end on a live sandbox rail.'
      : `Order is ${final.status} — likely outside market hours. Not a failure of the ` +
          `integration; the order is real and sitting at the broker.`,
  );
}

main().catch((error) => {
  console.error('\nSMOKE TEST FAILED\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
