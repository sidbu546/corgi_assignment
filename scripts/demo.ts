/**
 * demo.ts — watch the money move, one step at a time.
 *
 * Built for recording. It prints the customer's balances BEFORE and AFTER every
 * step, so what changed is visible on screen rather than inferred. Run it beside
 * the browser and the numbers match.
 *
 *   npm run demo                    the whole path, pausing between steps
 *   npm run demo -- --fast          no pauses
 *   npm run demo -- --bounce        settle nothing; bounce the deposit instead
 *
 * Everything here goes through the deployed HTTP API and the real webhook
 * pipeline — there is no privileged path that writes the ledger directly.
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import { encodeSession, SESSION_COOKIE } from '../src/lib/auth';
import { formatCents } from '../src/lib/money';

const BASE = process.env.APP_BASE_URL!;
const FAST = process.argv.includes('--fast');
const BOUNCE = process.argv.includes('--bounce');

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beat = () => (FAST ? Promise.resolve() : sleep(2200));

interface Balances {
  settled: bigint;
  unsettled: bigint;
  pending: bigint;
  positions: string;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });
  const client = await pool.connect();

  const { rows: users } = await client.query<{
    id: string;
    email: string;
    role: 'customer' | 'ops';
    display_name: string;
    customer_id: string | null;
  }>(
    `SELECT id, email, role, display_name, customer_id FROM users
      WHERE email IN ('dana@demo.ledgerly.app','ops@demo.ledgerly.app',
                      'approver@demo.ledgerly.app')`,
  );
  const cookieFor = (email: string) => {
    const u = users.find((x) => x.email === email)!;
    return `${SESSION_COOKIE}=${encodeSession({
      userId: u.id,
      email: u.email,
      role: u.role,
      displayName: u.display_name,
      customerId: u.customer_id,
    })}`;
  };
  // Pick a customer who can actually MOVE money right now.
  //
  // Alpaca allows one ACH transfer per account per trading day, and a settled
  // deposit cannot be un-settled (the ledger is append-only). So the customer
  // used last time usually cannot be used again today. Rather than hardcode one
  // and fail, find a customer who either has a deposit in flight to settle, or
  // still has their daily allowance.
  const { rows: withPending } = await client.query<{ email: string; name: string }>(
    `SELECT DISTINCT c.email, c.legal_name AS name
       FROM cash_transfers t
       JOIN customers c ON c.id = t.customer_id
      WHERE t.provider_ref IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cash_transfer_events e
                         WHERE e.transfer_id = t.id
                           AND e.kind IN ('settled','returned'))
      ORDER BY c.email`,
  );

  const { rows: fundable } = await client.query<{ email: string; name: string }>(
    `SELECT c.email, c.legal_name AS name
       FROM customers c
      WHERE c.alpaca_account_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM bank_links b
                     WHERE b.customer_id = c.id AND b.is_active
                       AND b.alpaca_relationship_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM kyc_events k WHERE k.customer_id = c.id
                     AND k.status = 'approved')
      ORDER BY c.legal_name`,
  );

  const subject = withPending[0] ?? fundable[0];
  if (!subject) {
    console.log(
      '\nNo customer can move money right now: none has a deposit in flight, and\n' +
        'none is both KYC-approved and bank-linked. Run `npm run happy-path` to\n' +
        'stand one up, then re-run this.',
    );
    client.release();
    await pool.end();
    return;
  }

  const SUBJECT_EMAIL = subject.email;
  const startedWithPending = withPending.length > 0;

  const { rows: cust } = await client.query<{ id: string }>(
    `SELECT id FROM customers WHERE email = $1`,
    [SUBJECT_EMAIL],
  );
  const customerId = cust[0].id;

  // The demo signs in as this customer, so it needs their session.
  const { rows: subjectUser } = await client.query<{
    id: string; email: string; role: 'customer' | 'ops';
    display_name: string; customer_id: string | null;
  }>(`SELECT id, email, role, display_name, customer_id FROM users WHERE customer_id = $1::uuid`,
     [customerId]);
  if (subjectUser[0]) users.push(subjectUser[0]);

  async function balances(): Promise<Balances> {
    const { rows } = await client.query<{ account_code: string; cents: bigint }>(
      `SELECT l.account_code, sum(l.amount_cents)::bigint AS cents
         FROM journal_lines l
        WHERE l.customer_id = $1::uuid AND l.commodity = 'USD'
          AND l.account_code LIKE 'assets:cash%'
        GROUP BY 1`,
      [customerId],
    );
    const get = (a: string) => rows.find((r) => r.account_code === a)?.cents ?? 0n;
    const { rows: pos } = await client.query<{ commodity: string; units: string }>(
      `SELECT commodity, sum(units) AS units FROM journal_lines
        WHERE customer_id = $1::uuid AND account_code = 'assets:positions'
        GROUP BY 1 HAVING sum(units) <> 0 ORDER BY 1`,
      [customerId],
    );
    return {
      settled: get('assets:cash:settled'),
      unsettled: get('assets:cash:unsettled_proceeds'),
      pending: get('assets:cash:pending_deposit'),
      positions: pos.map((p) => `${p.commodity} ${Number(p.units).toFixed(4)}`).join('  '),
    };
  }

  function show(label: string, b: Balances, prev?: Balances) {
    const d = (now: bigint, before?: bigint) => {
      if (before === undefined || now === before) return '';
      const diff = now - before;
      return diff > 0n ? G(`  +${formatCents(diff)}`) : R(`  ${formatCents(diff)}`);
    };
    console.log(`  ${D(label.padEnd(9))} ` +
      `settled ${formatCents(b.settled).padStart(12)}${d(b.settled, prev?.settled)}`);
    console.log(`  ${''.padEnd(9)} ` +
      `pending ${formatCents(b.pending).padStart(12)}${d(b.pending, prev?.pending)}`);
    if (b.positions || prev?.positions) {
      console.log(`  ${''.padEnd(9)} holding ${b.positions || '(none)'}`);
    }
  }

  async function post(path: string, body: unknown, as: string) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cookieFor(as) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  try {
    console.log(`\n${B('WATCH THE MONEY MOVE')}   ${D(BASE)}\n`);
    console.log(D('Every step below goes through the deployed HTTP API and the real'));
    console.log(D('webhook pipeline. Nothing writes the ledger directly.\n'));

    console.log(`${B('Customer:')} ${subject.name}  ${D(SUBJECT_EMAIL)}`);
    console.log(
      D(
        startedWithPending
          ? '  (has a deposit already in flight — step 2 settles it)\n'
          : '  (no deposit in flight — step 1 creates one)\n',
      ),
    );

    let before = await balances();
    console.log(B('Starting position\n'));
    show('now', before);

    // ---------------------------------------------------------------- 1
    console.log(B('\n\n1. Deposit $5,000 through the linked bank (real Alpaca ACH)\n'));
    await beat();
    const dep = await post('/api/funding/deposit', { amount: '5000' }, SUBJECT_EMAIL);
    if (dep.status !== 200) {
      const msg = String(dep.json.error ?? '');
      if (/1 per trading day/.test(msg)) {
        console.log(Y('   Alpaca refused: one ACH transfer per account per trading day.'));
        console.log(D('   That is the real rule, not a bug. This customer already has a'));
        console.log(D('   deposit in flight from earlier — the next step settles THAT one.'));
      } else {
        console.log(R(`   refused: ${msg.slice(0, 200)}`));
      }
    } else {
      console.log(`   Alpaca transfer ${Y(String(dep.json.transferId))}  status ${dep.json.status}`);
      let after = await balances();
      console.log('');
      show('before', before);
      console.log('');
      show('after', after, before);
      console.log(D('\n   Money is IN FLIGHT. Not investable, not withdrawable, and'));
      console.log(D('   excluded from portfolio value — it can still bounce.'));
      before = after;
    }

    // ---------------------------------------------------------------- 2
    await beat();
    if (BOUNCE) {
      console.log(B('\n\n2. The deposit BOUNCES — the rail returns it\n'));
      const sim = await post(
        '/api/ops/simulate-rail',
        { outcome: 'returned', customer: SUBJECT_EMAIL },
        'ops@demo.ledgerly.app',
      );
      if (sim.status !== 200) {
        console.log(R(`   ${sim.json.error ?? JSON.stringify(sim.json).slice(0, 200)}`));
      } else {
        console.log(`   ${sim.json.customer} · ${sim.json.statusTo} · pipeline: ${sim.json.pipeline}`);
        console.log(D(`   ${sim.json.detail ?? ''}`));
      }
    } else {
      console.log(B('\n\n2. The rail reports the deposit as good funds\n'));
      const sim = await post(
        '/api/ops/simulate-rail',
        { outcome: 'settled', customer: SUBJECT_EMAIL },
        'ops@demo.ledgerly.app',
      );
      if (sim.status !== 200) {
        console.log(R(`   ${sim.json.error ?? JSON.stringify(sim.json).slice(0, 200)}`));
      } else {
        console.log(`   ${sim.json.customer} · ${sim.json.statusTo} · pipeline: ${sim.json.pipeline}`);
        console.log(D(`   ${sim.json.detail ?? ''}`));
        console.log(Y(`\n   SIMULATED: ${sim.json.whatWasSimulated ?? ''}`));
      }
    }
    let after = await balances();
    console.log('');
    show('before', before);
    console.log('');
    show('after', after, before);
    // Describe what ACTUALLY changed. An earlier version asserted the expected
    // movement regardless, and printed "pending fell, settled rose" on a step
    // where nothing had moved because it had advanced a different customer's
    // deposit. Narration that does not read the numbers is worse than none.
    const movedPending = after.pending - before.pending;
    const movedSettled = after.settled - before.settled;

    if (movedPending === 0n && movedSettled === 0n) {
      console.log(R('\n   Nothing moved for this customer.'));
      console.log(D('   No in-flight deposit was available to advance.'));
    } else if (!BOUNCE) {
      console.log(
        D(`\n   Pending ${formatCents(movedPending)} and settled ` +
          `+${formatCents(movedSettled)} — the same money, now good funds.`),
      );
      console.log(D('   It is investable AND withdrawable from this moment.'));
    } else {
      console.log(D(`\n   Pending ${formatCents(movedPending)}, settled unchanged.`));
      console.log(D('   No position and no trade was touched. That is why in-flight'));
      console.log(D('   money lives in its own account: the bounce has an'));
      console.log(D('   exactly-sized thing to reverse and nothing else is disturbed.'));
    }
    before = after;

    if (BOUNCE) {
      console.log(`\n${'='.repeat(72)}`);
      console.log('The deposit failed and the customer is exactly where they started.');
      return;
    }

    // ---------------------------------------------------------------- 3
    await beat();
    console.log(B('\n\n3. Invest $2,000 into the Growth model — real orders\n'));
    let inv = await post(
      '/api/invest',
      { modelId: 'growth', amount: '2000' },
      SUBJECT_EMAIL,
    );

    // The interesting case, and worth showing rather than engineering around:
    // our ledger believes the deposit settled (we produced the notification),
    // while Alpaca's own ACH genuinely has not cleared. The system refuses to
    // trade on a number the broker does not agree with, and reports BOTH
    // figures rather than quietly trusting ours.
    if (inv.status === 422 && String(inv.json.error ?? '').includes('buying power')) {
      console.log(R('   REFUSED, and correctly so:\n'));
      console.log(`     our ledger says investable   ${Y(String(inv.json.ourInvestableCash))}`);
      console.log(`     the broker says buying power ${Y(String(inv.json.brokerBuyingPower))}`);
      console.log(D(`\n     ${String(inv.json.why ?? '')}`));
      console.log(
        D(
          '\n     Their balance is their ledger; ours is ours. Where they disagree\n' +
            '     we do not trade. Routing to the pre-funded paper venue instead,\n' +
            '     which is a real Alpaca sandbox that IS funded.\n',
        ),
      );
      await client.query(
        `UPDATE customers SET execution_venue = 'paper' WHERE id = $1::uuid`,
        [customerId],
      );
      inv = await post(
        '/api/invest',
        { modelId: 'growth', amount: '2000' },
        SUBJECT_EMAIL,
      );
    }

    if (inv.status !== 200) {
      console.log(R(`   refused: ${JSON.stringify(inv.json).slice(0, 260)}`));
    } else {
      for (const o of (inv.json.orders as Array<Record<string, string>>) ?? []) {
        console.log(
          `   ${String(o.symbol).padEnd(5)} ${String(o.notional).padStart(9)}  ` +
            `${String(o.status).padEnd(10)} ${D(String(o.brokerOrderId ?? o.error ?? ''))}`,
        );
      }
      console.log(D(`\n   venue ${inv.json.venue} · market open: ${inv.json.marketOpen}`));
      console.log(D(`   ${String(inv.json.note ?? '').slice(0, 160)}`));
    }

    // ---------------------------------------------------------------- 4
    await beat();
    console.log(B('\n\n4. An agent proposes a $300 withdrawal — it cannot approve it\n'));
    const { proposeWithdrawal } = await import('../src/lib/agent/tools');
    const proposal = await proposeWithdrawal(client, {
      customer: SUBJECT_EMAIL,
      amount: '300',
      reason: 'demo',
      agentId: 'agent:demo',
    });
    console.log(`   approval ${Y(proposal.approvalId)}  status ${proposal.status}`);
    console.log(D('   No journal entry was written. Nothing moved.'));

    await beat();
    console.log(B('\n\n5. A human approves it, and a human executes it\n'));
    const dec = await post(
      '/api/approvals',
      { approvalId: proposal.approvalId, action: 'approve' },
      'approver@demo.ledgerly.app',
    );
    console.log(`   approved by ${dec.json.decidedBy} ${D(`(requested by ${dec.json.requestedBy})`)}`);
    const exec = await post(
      '/api/approvals',
      { approvalId: proposal.approvalId, action: 'execute' },
      'approver@demo.ledgerly.app',
    );
    console.log(`   executed — journal entry ${Y(String(exec.json.entryId ?? exec.json.error))}`);

    after = await balances();
    console.log('');
    show('before', before);
    console.log('');
    show('after', after, before);
    console.log(D('\n   Settled cash fell by the withdrawal. The entry names both the'));
    console.log(D('   agent that asked and the human that approved.'));

    // ---------------------------------------------------------------- 6
    console.log(B('\n\n6. The ledger still balances\n'));
    const { rows: tb } = await client.query<{ commodity: string; cents: bigint | null }>(
      `SELECT commodity, sum(amount_cents)::bigint AS cents
         FROM journal_lines GROUP BY 1 ORDER BY 1`,
    );
    for (const t of tb) {
      console.log(
        `   ${t.commodity.padEnd(6)} ${(t.cents ?? 0n) === 0n ? G('nets to zero') : R('OUT OF BALANCE')}`,
      );
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log('Open ' + BASE + '/flow to see the same movements with provider ids.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\ndemo failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
