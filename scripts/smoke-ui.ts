/**
 * smoke-ui.ts — check the authenticated pages actually render on the deployed
 * system, for each role.
 *
 * Mints a session cookie with the same secret the server uses, then fetches the
 * protected pages and asserts on their content rather than just their status
 * code. A 200 that renders an error banner is still a broken page.
 *
 * Run: npx tsx scripts/smoke-ui.ts [baseUrl]
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import { encodeSession, SESSION_COOKIE } from '../src/lib/auth';

const BASE =
  process.argv[2] ?? process.env.APP_BASE_URL ?? 'https://corgi-assignment.vercel.app';

let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function fetchAs(path: string, cookie: string): Promise<string> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    redirect: 'manual',
  });
  if (response.status !== 200) {
    return `__STATUS_${response.status}__`;
  }
  return response.text();
}

async function main() {
  console.log(`\nUI smoke test against ${BASE}\n`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 2,
  });
  const client = await pool.connect();

  const { rows: users } = await client.query<{
    id: string;
    email: string;
    role: 'customer' | 'ops';
    display_name: string;
    customer_id: string | null;
  }>(
    `SELECT id, email, role, display_name, customer_id FROM users ORDER BY created_at`,
  );
  client.release();
  await pool.end();

  const session = (email: string) => {
    const u = users.find((x) => x.email === email);
    if (!u) throw new Error(`no seeded user ${email}`);
    return encodeSession({
      userId: u.id,
      email: u.email,
      role: u.role,
      displayName: u.display_name,
      customerId: u.customer_id,
    });
  };

  // --- funded customer ------------------------------------------------------
  console.log('1. Dana (approved, funded) -> /portfolio\n');
  const dana = await fetchAs('/portfolio', session('dana@demo.ledgerly.app'));
  check('page renders', !dana.startsWith('__STATUS_'), dana.slice(0, 24));
  check('shows her name', dana.includes('Dana Whitfield'));
  check('shows a portfolio value', /Portfolio value/.test(dana));
  check('shows the three cash buckets', /unsettled proceeds/.test(dana) && /deposit in flight/.test(dana));
  check('shows positions', /VOO/.test(dana) && /Cost basis/.test(dana));
  check('shows a time-weighted return', /[Tt]ime-weighted return/.test(dana));
  check(
    'explains that deposits are not performance',
    /deposits do\s+not count as performance|contributes exactly zero/.test(dana),
  );
  check('no KYC gate banner for an approved customer', !/deposits and trading are disabled/.test(dana));

  // --- gated customer -------------------------------------------------------
  console.log('\n2. Priya (KYC pending) -> /portfolio\n');
  const priya = await fetchAs('/portfolio', session('priya@demo.ledgerly.app'));
  check('page renders', !priya.startsWith('__STATUS_'));
  check(
    'shows the KYC gate',
    /Identity verification is still in progress/.test(priya),
    'unverified customers must be blocked from transacting',
  );
  check('gate says trading is disabled', /deposits and trading are disabled/.test(priya));

  // --- rejected customer ----------------------------------------------------
  console.log('\n3. Alex (KYC rejected) -> /portfolio\n');
  const alex = await fetchAs('/portfolio', session('alex@demo.ledgerly.app'));
  check('page renders', !alex.startsWith('__STATUS_'));
  check('shows the rejection', /Identity verification was not successful/.test(alex));
  check('shows the reason', /could not be matched/.test(alex));

  // --- ops ------------------------------------------------------------------
  console.log('\n4. Ops -> /ops\n');
  const ops = await fetchAs('/ops', session('ops@demo.ledgerly.app'));
  check('page renders', !ops.startsWith('__STATUS_'), ops.slice(0, 24));
  check('lists every customer', /Dana Whitfield/.test(ops) && /Priya Raman/.test(ops));
  check('shows book value under administration', /Book value under administration/.test(ops));
  check('shows the approval queue', /Approval queue/.test(ops));
  check('shows inbound event stats', /Inbound events/.test(ops));

  // --- role separation ------------------------------------------------------
  console.log('\n5. Role separation\n');
  const opsAtPortfolio = await fetch(`${BASE}/portfolio`, {
    headers: { cookie: `${SESSION_COOKIE}=${session('ops@demo.ledgerly.app')}` },
    redirect: 'manual',
  });
  check(
    'an ops user is redirected away from a customer portfolio',
    opsAtPortfolio.status === 307 || opsAtPortfolio.status === 302,
    `status ${opsAtPortfolio.status}`,
  );

  const customerAtOps = await fetch(`${BASE}/ops`, {
    headers: { cookie: `${SESSION_COOKIE}=${session('dana@demo.ledgerly.app')}` },
    redirect: 'manual',
  });
  check(
    'a customer is redirected away from the ops console',
    customerAtOps.status === 307 || customerAtOps.status === 302,
    `status ${customerAtOps.status}`,
  );

  const anonymous = await fetch(`${BASE}/portfolio`, { redirect: 'manual' });
  check(
    'an anonymous visitor is redirected to sign in',
    anonymous.status === 307 || anonymous.status === 302,
    `status ${anonymous.status}`,
  );

  const forged = await fetch(`${BASE}/portfolio`, {
    headers: { cookie: `${SESSION_COOKIE}=forged.signature` },
    redirect: 'manual',
  });
  check(
    'a forged session cookie is rejected',
    forged.status === 307 || forged.status === 302,
    `status ${forged.status}`,
  );

  console.log(`\n${'='.repeat(64)}`);
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch((error) => {
  console.error('\nUI smoke test crashed:', error);
  process.exit(1);
});
