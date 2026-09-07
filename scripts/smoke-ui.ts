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

  // Each customer's CURRENT KYC status, using the same ordering the enforcement
  // path uses in onboarding.ts — including recorded_at, so two events sharing an
  // effective_at cannot make the test disagree with the gate it is testing.
  const { rows: kycByEmail } = await client.query<{
    email: string;
    legal_name: string;
    status: string;
  }>(
    `SELECT c.email, c.legal_name,
            coalesce((SELECT k.status FROM kyc_events k
                       WHERE k.customer_id = c.id
                       ORDER BY k.effective_at DESC, k.recorded_at DESC, k.id DESC
                       LIMIT 1), 'not_started') AS status
       FROM customers c
      ORDER BY c.legal_name`,
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
  // The "approved customers are not gated" half of the rule is checked in
  // section 3, against whoever is actually approved rather than against Dana by
  // name — Persona owns that state and has changed it under us twice.

  // --- gated customers ------------------------------------------------------
  //
  // Which customer is in which KYC state is PERSONA'S to decide, not ours.
  // Naming them here — Priya pending, Alex rejected — asserted a live sandbox's
  // state, and it went red twice: once when a demo run approved Alex, once when
  // Persona declined Priya on its own, eight seconds after I restored her.
  //
  // The actual requirement has no names in it: a customer who is not approved
  // must be gated, and must be told why. So find whoever is currently in each
  // state and check the behaviour on them.
  console.log('\n2. The KYC gate, on whoever is currently gated\n');

  const gateFor: Record<string, RegExp> = {
    pending: /Identity verification is still in progress/,
    rejected: /Identity verification was not successful/,
    not_started: /Identity verification has not been started/,
  };

  const gated = kycByEmail.filter(
    (c) => c.status !== 'approved' && users.some((u) => u.email === c.email),
  );

  if (gated.length === 0) {
    // Not a pass and not a failure: there is genuinely nothing in this state to
    // check. Saying so beats a green tick for a test that did nothing.
    console.log(
      '  NOTE  every demo customer is currently approved at Persona, so the\n' +
        '        gate has nothing to act on. Not counted as a pass.',
    );
  }

  for (const c of gated) {
    const page = await fetchAs('/portfolio', session(c.email));
    const label = `${c.legal_name} (${c.status})`;
    check(`${label}: page renders`, !page.startsWith('__STATUS_'), page.slice(0, 24));
    check(
      `${label}: shows the gate for its own status`,
      gateFor[c.status]?.test(page) ?? false,
      'unverified customers must be blocked from transacting',
    );
    check(
      `${label}: says deposits and trading are disabled`,
      /deposits and trading are disabled/.test(page),
    );
    if (c.status === 'rejected') {
      // The reason text comes from PERSONA, not from us, so asserting one exact
      // sentence tests the seed rather than the behaviour: a hand-seeded
      // rejection says "could not be matched", a real declined inquiry says
      // "Persona reported inquiry.declined". Either is a reason being shown,
      // which is the requirement.
      check(
        `${label}: shows a reason`,
        /could not be matched|Persona reported/.test(page),
      );
    }
  }

  // --- an approved customer is NOT gated ------------------------------------
  // The other half of the same rule, and the half that would silently pass if
  // the gate were rendered unconditionally.
  console.log('\n3. An approved customer is not gated\n');
  const approved = kycByEmail.find(
    (c) => c.status === 'approved' && users.some((u) => u.email === c.email),
  );
  if (!approved) {
    console.log('  NOTE  no approved demo customer to check.');
  } else {
    const page = await fetchAs('/portfolio', session(approved.email));
    check(
      `${approved.legal_name}: no gate banner`,
      !/deposits and trading are disabled/.test(page),
    );
  }

  // --- ops ------------------------------------------------------------------
  console.log('\n4. Ops -> /ops\n');
  const ops = await fetchAs('/ops', session('ops@demo.ledgerly.app'));
  check('page renders', !ops.startsWith('__STATUS_'), ops.slice(0, 24));
  check('lists every customer', /Dana Whitfield/.test(ops) && /Priya Raman/.test(ops));
  check('shows book value under administration', /Book value under administration/.test(ops));
  check('shows the approval queue', /Approval queue/.test(ops));
  check('shows inbound event stats', /Inbound events/.test(ops));

  // --- as-of time travel ----------------------------------------------------
  // The claim under test is not "the page renders" but "the two time axes are
  // actually independent", so this asks for a historical date and checks that
  // the as-of column disagrees with today. If bitemporality were decorative,
  // every column would carry the same figures and this would go red.
  console.log('\n5. As-at: two time axes that actually move\n');
  const opsSession = session('ops@demo.ledgerly.app');
  const asof = await fetchAs('/asof', opsSession);
  check('page renders', !asof.startsWith('__STATUS_'), asof.slice(0, 24));
  check('offers all three coordinates', /knownAt = now/.test(asof) && /as we knew then/.test(asof));
  // Count with >= rather than ==: the RSC flight payload embeds every rendered
  // string a second time, so an exact count asserts a Next.js implementation
  // detail rather than the property. What matters is that all three coordinates
  // report a balanced book and none reports otherwise.
  check(
    'proves the trial balance at each historical instant',
    (asof.match(/sums to zero/g) ?? []).length >= 3 && !/DOES NOT BALANCE/.test(asof),
    'the whole book must balance as at every coordinate, not just today',
  );
  check(
    'explains a difference rather than only showing one',
    /What changed, and why/.test(asof),
  );
  // The default date is the customer's FIRST entry, which for the seeded book
  // predates the seed itself — so the "as we knew then" column is empty and the
  // page must say why rather than showing zeros with no explanation.
  check(
    'labels an empty as-published column instead of leaving it blank',
    /we had no records yet/.test(asof) || /Nothing was recorded after/.test(asof),
  );

  // --- role separation ------------------------------------------------------
  console.log('\n6. Role separation\n');
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
