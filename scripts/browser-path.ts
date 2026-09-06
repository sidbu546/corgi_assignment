/**
 * browser-path.ts — walk the money path the way a REVIEWER walks it: through
 * the same HTTP routes the buttons call, against the deployed system.
 *
 * WHY THIS EXISTS ALONGSIDE happy-path.ts.
 *
 * happy-path calls the libraries directly. That proves the domain logic and the
 * provider integrations work, and it is the stronger test of the ledger. What
 * it does NOT prove is that the thing a person can actually click works, because
 * it never goes through a route, a session, or the gate a route applies. Those
 * are different code, and a demo fails on the route, in front of an audience,
 * not in the library.
 *
 * So this drives the real endpoints: /api/kyc, /api/funding/link,
 * /api/funding/deposit, and reads the pages back. It mints a session cookie
 * with the same secret the server uses, which is exactly what smoke-ui.ts does.
 *
 * It creates a NEW customer each run, deliberately. Alpaca allows one ACH
 * transfer per account per trading day, so a customer who has already deposited
 * cannot demonstrate a deposit — see `npm run demo-ready`. A new customer has a
 * new brokerage account and its own allowance.
 *
 * Run: npx tsx scripts/browser-path.ts [baseUrl]
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import { encodeSession, hashPassword, SESSION_COOKIE } from '../src/lib/auth';

const BASE =
  process.argv[2] ?? process.env.APP_BASE_URL ?? 'https://corgi-assignment.vercel.app';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let step = 0;

function heading(title: string) {
  console.log(`\n${++step}. ${title}\n`);
}
// Argument order is (ok, label) to match happy-path.ts. Getting this backwards
// once already produced a harness that printed PASS unconditionally, because
// the label is a non-empty string and therefore always truthy.
function check(ok: boolean, label: string, detail = '') {
  if (ok !== true) failures++;
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });

  const stamp = Date.now();
  const name = `Jordan Avery ${stamp.toString(36).slice(-4).toUpperCase()}`;
  const email = `jordan.${stamp}@demo.ledgerly.app`;
  const password = 'demo-password';

  try {
    // ---------------------------------------------------------------------
    heading('Open an account — the same inserts /signup performs');

    const { rows: created } = await pool.query<{ id: string }>(
      `INSERT INTO customers (legal_name, email) VALUES ($1, $2) RETURNING id`,
      [name, email],
    );
    const customerId = created[0].id;
    const { rows: users } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, display_name, customer_id)
       VALUES ($1, $2, 'customer', $3, $4::uuid) RETURNING id`,
      [email, await hashPassword(password), name, customerId],
    );

    const cookie = encodeSession({
      userId: users[0].id,
      email,
      role: 'customer',
      displayName: name,
      customerId,
    });
    const headers = {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${cookie}`,
    };
    const post = (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

    check(true, 'customer created', `${name} · ${email}`);

    // ---------------------------------------------------------------------
    heading('The gate is shut — a deposit must be refused before KYC');

    const early = await post('/api/funding/deposit', { amount: '100' });
    const earlyBody = (await early.json()) as { error?: string; code?: string };
    check(
      early.status === 403 && earlyBody.code === 'kyc_not_approved',
      'depositing before verification is refused by the route',
      `HTTP ${early.status} — ${earlyBody.error ?? ''}`,
    );

    // ---------------------------------------------------------------------
    heading('Identity — a real Persona inquiry, through /api/kyc');

    const start = await post('/api/kyc', { action: 'start' });
    const startBody = (await start.json()) as { inquiryId?: string; referenceId?: string };
    check(
      start.ok && !!startBody.inquiryId,
      'Persona opened a real inquiry',
      `${startBody.inquiryId} · reference ${startBody.referenceId}`,
    );

    const approve = await post('/api/kyc', { action: 'approve' });
    check(approve.ok, 'Persona was driven to a decision in its own sandbox');

    let status = 'unknown';
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const poll = await post('/api/kyc', {});
      const body = (await poll.json()) as { ourStatus?: string };
      status = body.ourStatus ?? 'unknown';
      if (status === 'approved') break;
    }
    check(
      status === 'approved',
      'our status changed only when the signed webhook arrived',
      `status now: ${status}`,
    );

    // ---------------------------------------------------------------------
    heading('Link a bank — real Plaid, through /api/funding/link');

    // The route opens the brokerage account on demand and waits for it to be
    // usable; a 409 means it is still opening, so retry rather than fail.
    let linkBody: Record<string, unknown> = {};
    let linked = false;
    for (let i = 0; i < 6 && !linked; i++) {
      const link = await post('/api/funding/link', { action: 'sandbox-link' });
      linkBody = (await link.json()) as Record<string, unknown>;
      linked = link.ok && linkBody.linked === true;
      if (!linked && link.status === 409) await sleep(5000);
      else break;
    }
    check(
      linked,
      'Plaid verified the owner and Alpaca redeemed the processor token',
      `${linkBody.institution ?? ''} ${linkBody.mask ?? ''} · relationship ${
        linkBody.relationshipId ?? linkBody.error ?? ''
      }`,
    );

    // ---------------------------------------------------------------------
    heading('Deposit — real ACH, through /api/funding/deposit');

    const deposit = await post('/api/funding/deposit', { amount: '25000' });
    const depositBody = (await deposit.json()) as Record<string, unknown>;
    check(
      deposit.ok,
      'Alpaca accepted the ACH deposit',
      `transfer ${depositBody.transferId ?? depositBody.error ?? ''}`,
    );

    const { rows: pending } = await pool.query<{ c: bigint }>(
      `SELECT coalesce(sum(l.amount_cents)::bigint, 0) AS c FROM journal_lines l
        WHERE l.customer_id = $1::uuid AND l.account_code = 'assets:cash:pending_deposit'`,
      [customerId],
    );
    check(
      (pending[0]?.c ?? 0n) === 2_500_000n,
      'booked as money in flight, not as cash',
      `pending_deposit = ${pending[0]?.c ?? 0n} cents`,
    );

    // ---------------------------------------------------------------------
    heading('Investing is refused while the money is in flight');

    const early2 = await post('/api/invest', { modelId: 'growth', amount: '1000' });
    const early2Body = (await early2.json()) as { error?: string };
    check(
      !early2.ok,
      'unsettled money is not investable — a success here would be the bug',
      `HTTP ${early2.status} — ${early2Body.error ?? ''}`,
    );

    // ---------------------------------------------------------------------
    heading('The pages render for this customer');

    for (const path of ['/portfolio', '/fund', '/flow']) {
      const page = await fetch(`${BASE}${path}`, {
        headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
        redirect: 'manual',
      });
      check(page.status === 200, `${path} renders`, `HTTP ${page.status}`);
    }

    // ---------------------------------------------------------------------
    console.log('\n' + '='.repeat(72));
    if (failures === 0) {
      console.log('\n\x1b[32mThe clickable path works.\x1b[0m Ready for the rail step.\n');
    } else {
      console.log(`\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
    }
    console.log(`  sign in   ${email} / ${password}`);
    console.log(`  then      ${BASE}/ops  ->  Good funds  (as ops@demo.ledgerly.app)`);
    console.log(`  and       ${BASE}/fund ->  buy the model\n`);
  } finally {
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nbrowser-path failed:\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
