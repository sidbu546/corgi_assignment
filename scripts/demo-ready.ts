/**
 * demo-ready.ts — which customer can demonstrate the whole money path RIGHT NOW.
 *
 * Alpaca allows one ACH transfer per account per trading day in each direction.
 * That limit is per ACCOUNT, and every customer here has their own Alpaca
 * account, so a customer whose allowance is spent cannot deposit while another
 * customer still can. Running a demo against the wrong one produces a 422 from
 * Alpaca and an empty rail console, which looks like a broken app and is not.
 *
 * This tells you who to sign in as. It asks Alpaca directly rather than
 * inferring from our ledger, because the limit is Alpaca's state, not ours.
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import { formatCents } from '../src/lib/money';

const BASE = process.env.ALPACA_BROKER_BASE_URL ?? 'https://broker-api.sandbox.alpaca.markets';
const AUTH =
  'Basic ' +
  Buffer.from(`${process.env.ALPACA_BROKER_KEY_ID}:${process.env.ALPACA_BROKER_SECRET}`).toString(
    'base64',
  );

interface AlpacaTransfer {
  id: string;
  status: string;
  amount: string;
  created_at: string;
  direction: string;
}

/**
 * Never swallow the failure. An empty list on error would report every account
 * as having a free allowance, which is precisely the wrong answer — it is the
 * answer that makes a demo walk into a 422 in front of an audience.
 */
async function transfersFor(
  accountId: string,
): Promise<{ transfers: AlpacaTransfer[] } | { error: string }> {
  const response = await fetch(`${BASE}/v1/accounts/${accountId}/transfers`, {
    headers: { authorization: AUTH, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) return { error: `Alpaca ${response.status}: ${text.slice(0, 200)}` };
  try {
    return { transfers: JSON.parse(text) as AlpacaTransfer[] };
  } catch {
    return { error: `Alpaca returned unparseable body: ${text.slice(0, 200)}` };
  }
}

/** Alpaca counts a transfer against the allowance until it reaches a terminal state. */
const TERMINAL = new Set(['COMPLETE', 'RETURNED', 'CANCELED', 'CANCELLED', 'REJECTED', 'FAILED']);

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });

  try {
    const { rows: customers } = await pool.query<{
      legal_name: string;
      email: string;
      alpaca_account_id: string | null;
      kyc: string | null;
      settled: bigint | null;
      pending: bigint | null;
    }>(
      `SELECT c.legal_name, c.email, c.alpaca_account_id,
              -- Same ordering as kycStatus() in onboarding.ts. It omitted
              -- recorded_at, so with two events sharing an effective_at this
              -- could name a different status than the app enforced.
              (SELECT k.status FROM kyc_events k
                WHERE k.customer_id = c.id
                ORDER BY k.effective_at DESC, k.recorded_at DESC, k.id DESC
                LIMIT 1) AS kyc,
              coalesce((SELECT sum(l.amount_cents)::bigint FROM journal_lines l
                 WHERE l.customer_id = c.id
                   AND l.account_code = 'assets:cash:settled'), 0) AS settled,
              coalesce((SELECT sum(l.amount_cents)::bigint FROM journal_lines l
                 WHERE l.customer_id = c.id
                   AND l.account_code = 'assets:cash:pending_deposit'), 0) AS pending
         FROM customers c
        ORDER BY c.legal_name`,
    );

    console.log('\nWho can demonstrate the money path right now\n');

    const ready: string[] = [];
    const railNow: string[] = [];

    for (const c of customers) {
      const parts: string[] = [];
      let verdict = '';

      if (!c.alpaca_account_id) {
        // No brokerage account is not a dead end — it is the BEST state to be
        // in. Linking a bank opens one, and a new account has an unused ACH
        // allowance, which a customer who has already deposited does not.
        verdict =
          c.kyc === 'approved'
            ? 'READY — link a bank on /fund; that opens the account, with a fresh allowance'
            : `KYC is ${c.kyc ?? 'not_started'} — verify on /portfolio first`;
        if (c.kyc === 'approved') ready.push(c.email);
      } else {
        const result = await transfersFor(c.alpaca_account_id);
        if ('error' in result) {
          verdict = `COULD NOT ASK ALPACA — ${result.error}`;
        } else {
          const open = result.transfers.filter((t) => !TERMINAL.has(t.status.toUpperCase()));
          parts.push(
            `${result.transfers.length} transfer(s) at Alpaca, ${open.length} still open`,
          );
          if (open.length > 0) {
            verdict = `ACH ALLOWANCE SPENT — ${open[0].status} $${open[0].amount}`;
          } else if (c.kyc !== 'approved') {
            verdict = `KYC is ${c.kyc ?? 'not_started'} — deposit will be refused`;
          } else {
            verdict = 'READY — can deposit now';
            ready.push(c.email);
          }
        }
      }

      if ((c.pending ?? 0n) > 0n) railNow.push(c.email);

      console.log(`  ${c.legal_name}  <${c.email}>`);
      console.log(`    kyc ${c.kyc ?? 'not_started'} · settled ${formatCents(c.settled ?? 0n)} · in flight ${formatCents(c.pending ?? 0n)}`);
      if (parts.length) console.log(`    ${parts.join(' · ')}`);
      console.log(`    ${verdict}\n`);
    }

    if (railNow.length > 0) {
      console.log(`Already in flight — go straight to /ops and press Good funds for: ${railNow.join(', ')}\n`);
    }
    if (ready.length > 0) {
      console.log(`Start a fresh deposit as: ${ready[0]}\n`);
    } else if (railNow.length === 0) {
      console.log(
        'Nobody can start a new ACH today: every account has an open transfer at\n' +
          'Alpaca, and Alpaca allows one per trading day. The allowance frees when\n' +
          'those transfers reach COMPLETE, which the sandbox does on a trading day.\n',
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nfailed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
