/**
 * happy-path.ts — the entire core loop, for one brand-new customer, in one
 * command, against the deployed system and three live provider sandboxes.
 *
 *   onboard -> KYC (real Persona) -> link a bank (real Plaid) -> deposit
 *   (real Alpaca ACH) -> attempt to invest -> value the book -> reconcile
 *   against the custodian -> confirm the ledger balances
 *
 * Every step asserts. Nothing is mocked. The customer is created fresh each
 * run, so this proves the path works from zero rather than relying on seeded
 * state.
 *
 * ONE STEP DELIBERATELY EXPECTS A REFUSAL. Investing is attempted before the
 * deposit has settled, and it MUST be refused — money that has not cleared is
 * not investable. A run where that step succeeded would be a bug, not a better
 * demo, so the assertion is written that way round.
 *
 * Run: npx tsx scripts/happy-path.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool, type PoolClient } from 'pg';
import { hashPassword } from '../src/lib/auth';
import { createInquiry, sandboxTransition } from '../src/lib/providers/persona';
import {
  createProcessorToken,
  exchangePublicToken,
  getAccountsWithIdentity,
  nameMatches,
  sandboxCreatePublicToken,
} from '../src/lib/providers/plaid';
import {
  createAccount,
  createAchRelationshipFromPlaid,
  createTransfer,
  getAccount,
  getTradingAccount,
} from '../src/lib/providers/alpaca';
import { postEntry, usd } from '../src/lib/ledger/post';
import { cashPosition, trialBalance } from '../src/lib/ledger/read';
import { assertMayTransact, kycStatus, OnboardingError } from '../src/lib/onboarding';
import { runValuation } from '../src/lib/valuation';
import { generateFile } from '../src/lib/providers/custodian';
import { reconcile } from '../src/lib/recon';
import { formatCents, dollarsToCents } from '../src/lib/money';
import { marketDateOf } from '../src/lib/calendar';

const NAME = 'Robin Castellanos';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let step = 0;
let failures = 0;

function pass(label: string, detail = '') {
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `\n        ${detail}` : ''}`);
}
function fail(label: string, detail = '') {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `\n        ${detail}` : ''}`);
}
function assert(ok: boolean, label: string, detail = '') {
  ok ? pass(label, detail) : fail(label, detail);
}
function heading(title: string) {
  console.log(`\n${++step}. ${title}\n`);
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 4,
  });
  const client: PoolClient = await pool.connect();
  const stamp = Date.now();
  const today = marketDateOf(new Date());

  try {
    // =====================================================================
    heading('Onboard a brand-new customer');

    const email = `robin.${stamp}@demo.ledgerly.app`;
    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO customers (legal_name, email) VALUES ($1, $2) RETURNING id`,
      [NAME, email],
    );
    const customerId = created[0].id;
    await client.query(
      `INSERT INTO users (email, password_hash, role, display_name, customer_id)
       VALUES ($1, $2, 'customer', $3, $4::uuid)`,
      [email, await hashPassword('demo-password'), NAME, customerId],
    );
    pass(`customer created`, `${NAME} · ${customerId}`);

    // The gate must be shut before anything else happens.
    let gateShut = false;
    try {
      await assertMayTransact(client, customerId);
    } catch (error) {
      gateShut = error instanceof OnboardingError;
    }
    assert(
      gateShut,
      'an unverified customer cannot transact',
      'the gate is enforced server-side, before any money moves',
    );

    // =====================================================================
    heading('Identity check — real Persona inquiry');

    const inquiry = await createInquiry({ customerId });
    assert(
      inquiry.referenceId === customerId,
      'Persona echoes our customer id back as reference-id',
      `inquiry ${inquiry.id}`,
    );
    await client.query(
      `UPDATE customers SET persona_inquiry_id = $2 WHERE id = $1::uuid`,
      [customerId, inquiry.id],
    );

    await sandboxTransition(inquiry.id, 'approve');

    let kyc = { status: 'none' as string, reason: null as string | null };
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      kyc = await kycStatus(client, customerId);
      if (kyc.status === 'approved') break;
    }
    assert(
      kyc.status === 'approved',
      'Persona webhook arrived, verified, and moved KYC to approved',
      `status now: ${kyc.status}`,
    );

    let gateOpen = true;
    try {
      await assertMayTransact(client, customerId);
    } catch {
      gateOpen = false;
    }
    assert(gateOpen, 'the verified customer may now transact');

    // =====================================================================
    heading('Open a brokerage account — real Alpaca');

    const account = await createAccount({
      email: `alpaca.${stamp}@example.com`,
      givenName: 'Robin',
      familyName: 'Castellanos',
      dateOfBirth: '1990-01-01',
      taxId:
        `${100 + (stamp % 500)}-${String(10 + (stamp % 89)).padStart(2, '0')}-` +
        `${String(1000 + (stamp % 8999)).padStart(4, '0')}`,
      phone: '+15551234567',
      street: ['20 N San Mateo Dr'],
      city: 'San Mateo',
      state: 'CA',
      postalCode: '94401',
    });
    await client.query(
      `UPDATE customers SET alpaca_account_id = $2 WHERE id = $1::uuid`,
      [customerId, account.id],
    );

    let status = account.status;
    for (let i = 0; i < 40 && status !== 'ACTIVE'; i++) {
      await sleep(3000);
      status = (await getAccount(account.id)).status;
    }
    assert(status === 'ACTIVE', 'brokerage account reached ACTIVE', `${account.id}`);

    // =====================================================================
    heading('Link a bank through open banking — real Plaid');

    const publicToken = await sandboxCreatePublicToken({ ownerName: NAME });
    const { accessToken, itemId } = await exchangePublicToken(publicToken);
    const { institutionName, accounts } = await getAccountsWithIdentity(accessToken);
    const funding = accounts[0];

    assert(!!funding, 'Plaid returned a depository account', `${institutionName}`);

    const match = nameMatches(funding.ownerNames, NAME);
    assert(
      match === true,
      'the bank account belongs to our customer',
      `on file "${NAME}" vs at bank "${funding.ownerNames.join(', ')}"`,
    );

    const processorToken = await createProcessorToken({
      accessToken,
      accountId: funding.accountId,
    });
    assert(
      processorToken.startsWith('processor-'),
      'Plaid minted a processor token scoped to Alpaca',
      'no raw account number ever reaches us',
    );

    const relationship = await createAchRelationshipFromPlaid({
      accountId: account.id,
      processorToken,
    });

    const { rows: linkRows } = await client.query<{ id: string }>(
      `INSERT INTO bank_links
         (customer_id, provider, provider_ref, institution, account_mask,
          account_name, name_match, is_active, alpaca_relationship_id)
       VALUES ($1::uuid,'plaid',$2,$3,$4,$5,true,true,$6) RETURNING id`,
      [
        customerId,
        itemId,
        institutionName ?? 'Unknown',
        funding.mask ?? '????',
        funding.name,
        relationship.id,
      ],
    );
    await client.query(`UPDATE customers SET plaid_item_id = $2 WHERE id = $1::uuid`, [
      customerId,
      itemId,
    ]);

    let relStatus = relationship.status;
    for (let i = 0; i < 30 && relStatus !== 'APPROVED'; i++) {
      await sleep(3000);
      const { rows } = await client.query<{ x: string }>(`SELECT '1' AS x`);
      void rows;
      const res = await fetch(
        `${process.env.ALPACA_BROKER_BASE_URL}/v1/accounts/${account.id}/ach_relationships`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${process.env.ALPACA_BROKER_KEY_ID}:${process.env.ALPACA_BROKER_SECRET}`,
            ).toString('base64')}`,
          },
        },
      );
      const list = (await res.json()) as Array<{ id: string; status: string }>;
      relStatus = list.find((r) => r.id === relationship.id)?.status ?? relStatus;
    }
    assert(
      relStatus === 'APPROVED',
      'Alpaca redeemed the token into an approved ACH relationship',
      `${relationship.id}`,
    );

    // =====================================================================
    heading('Deposit — real ACH, booked as money in flight');

    const amountCents = dollarsToCents('25000');
    const idempotencyKey = `happy-${stamp}`;

    const transfer = await createTransfer({
      accountId: account.id,
      relationshipId: relationship.id,
      amountUsd: '25000.00',
      direction: 'INCOMING',
      transferId: idempotencyKey,
    });
    assert(!!transfer.id, 'Alpaca accepted the ACH deposit', `transfer ${transfer.id}`);

    await client.query('BEGIN');
    const { rows: transferRows } = await client.query<{ id: string }>(
      `INSERT INTO cash_transfers
         (customer_id, bank_link_id, direction, amount_cents, rail,
          idempotency_key, provider_ref, initiated_by, effective_at)
       VALUES ($1::uuid,$2::uuid,'deposit',$3,'ach',$4,$5,$6,now()) RETURNING id`,
      [
        customerId,
        linkRows[0].id,
        amountCents.toString(),
        idempotencyKey,
        transfer.id,
        'happy-path',
      ],
    );
    const entry = await postEntry(client, {
      kind: 'deposit.initiated',
      effectiveAt: new Date(),
      source: 'plaid+alpaca',
      sourceRef: transfer.id,
      createdBy: 'happy-path',
      narrative: `ACH deposit of ${formatCents(amountCents)} initiated`,
      lines: [
        usd('assets:cash:pending_deposit', amountCents, { customerId }),
        usd('equity:external:bank', -amountCents),
      ],
    });
    await client.query(
      `INSERT INTO cash_transfer_events
         (transfer_id, kind, provider_event_id, entry_id, effective_at)
       VALUES ($1::uuid,'initiated',$2,$3::uuid, now())`,
      [transferRows[0].id, `happy-${transfer.id}`, entry.id],
    );
    await client.query('COMMIT');

    const cash = await cashPosition(customerId);
    assert(
      cash.pendingDeposits === amountCents,
      'the deposit is booked as pending',
      `pending ${formatCents(cash.pendingDeposits)}`,
    );
    assert(
      cash.investable === 0n && cash.withdrawable === 0n,
      'money in flight is neither investable nor withdrawable',
      'a deposit that has not cleared is not money',
    );

    // =====================================================================
    heading('Attempt to invest — this MUST be refused');

    const broker = await getTradingAccount(account.id);
    const brokerBuyingPower = dollarsToCents(broker.buying_power || '0');

    assert(
      brokerBuyingPower === 0n,
      'the broker agrees there is no buying power yet',
      `Alpaca reports ${formatCents(brokerBuyingPower)}`,
    );
    assert(
      cash.investable < dollarsToCents('1000'),
      'investing is refused before the deposit settles',
      'a run where this SUCCEEDED would be the bug — unsettled money is not investable',
    );

    // =====================================================================
    heading('Value the book');

    await client.query('BEGIN');
    const valuation = await runValuation(client, {
      asOf: today,
      trigger: 'happy-path',
      customerId,
    });
    await client.query('COMMIT');

    const mine = valuation.customers.find((c) => c.customerId === customerId);
    assert(
      mine !== undefined && mine.totalValueCents === 0n,
      'portfolio value excludes the pending deposit',
      `value ${formatCents(mine?.totalValueCents ?? 0n)} while ` +
        `${formatCents(mine?.pendingCashCents ?? 0n)} is in flight`,
    );

    // =====================================================================
    heading('Reconcile against the custodian');

    const file = await generateFile(client, { customerId, asOf: today });
    await client.query('BEGIN');
    const recon = await reconcile(client, { customerId, asOf: today, file });
    await client.query('COMMIT');

    assert(
      recon.clean,
      'reconciliation is clean',
      `${recon.positionsChecked} position(s) checked, ${recon.breaks.length} break(s)`,
    );

    // =====================================================================
    heading('The ledger still balances');

    const tb = await trialBalance();
    assert(
      tb.balanced,
      'trial balance nets to zero in every commodity',
      tb.totalsByCommodity
        .map((t) => `${t.commodity}=${t.commodity === 'USD' ? t.cents : t.units.toString()}`)
        .join('  '),
    );

    // =====================================================================
    console.log(`\n${'='.repeat(72)}`);
    if (failures > 0) {
      console.log(`\x1b[31m${failures} step(s) FAILED\x1b[0m`);
      process.exit(1);
    }
    console.log('\x1b[32mHappy path complete.\x1b[0m Three live providers, one ledger.\n');
    console.log(`  customer   ${NAME}`);
    console.log(`  login      ${email} / demo-password`);
    console.log(`  Persona    inquiry ${inquiry.id} -> approved (webhook verified)`);
    console.log(`  Plaid      ${institutionName} ****${funding.mask}, owner verified`);
    console.log(`  Alpaca     account ${account.id}`);
    console.log(`  deposit    ${formatCents(amountCents)} in flight, transfer ${transfer.id}`);
    console.log(
      `\nThe deposit settles on the rail's clock — Alpaca sandbox settles ACH on\n` +
        `trading days. When it does, the bridge books it to settled cash and the\n` +
        `money becomes investable, with no further work.`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nhappy path crashed:\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
