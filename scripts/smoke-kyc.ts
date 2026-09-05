/**
 * smoke-kyc.ts — drive a real Persona inquiry and prove the webhook lands.
 *
 * Creates an inquiry for a real customer, transitions it through Persona's own
 * sandbox endpoints, and then checks OUR database to confirm that:
 *
 *   - Persona actually delivered webhooks to the deployed URL
 *   - the signatures verified
 *   - each event moved the customer's KYC status, append-only
 *
 * The declined path is run as well as the approved one, because "show pending
 * and rejected, not just approved" is the requirement, and a gate that has only
 * ever been seen to open is not a gate.
 *
 * Run: npx tsx scripts/smoke-kyc.ts [approve|decline]
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';
import {
  createInquiry,
  getInquiry,
  hostedFlowUrl,
  sandboxTransition,
} from '../src/lib/providers/persona';

const ACTION = (process.argv[2] as 'approve' | 'decline') ?? 'approve';
const EMAIL =
  ACTION === 'decline' ? 'alex@demo.ledgerly.app' : 'priya@demo.ledgerly.app';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 3,
  });
  const client = await pool.connect();

  try {
    const { rows } = await client.query<{ id: string; legal_name: string }>(
      `SELECT id, legal_name FROM customers WHERE email = $1`,
      [EMAIL],
    );
    const customer = rows[0];
    if (!customer) throw new Error(`no customer ${EMAIL}`);

    console.log(`\nKYC via Persona — ${ACTION} path\n`);
    console.log(`Customer: ${customer.legal_name} (${customer.id})`);

    const { rows: before } = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM kyc_events
        WHERE customer_id = $1::uuid ORDER BY effective_at DESC, recorded_at DESC, id DESC LIMIT 1`,
      [customer.id],
    );
    console.log(`KYC status before: ${before[0]?.status ?? 'none'}\n`);

    // --- 1. open a real inquiry ---------------------------------------------
    console.log('1. Creating an inquiry at Persona...');
    const inquiry = await createInquiry({ customerId: customer.id });
    console.log(`   inquiry ${inquiry.id}  status=${inquiry.status}`);
    console.log(`   reference-id echoed back: ${inquiry.referenceId}`);
    console.log(`   hosted flow: ${hostedFlowUrl(inquiry.id)}\n`);

    await client.query(
      `UPDATE customers SET persona_inquiry_id = $2 WHERE id = $1::uuid`,
      [customer.id, inquiry.id],
    );

    // --- 2. transition it ----------------------------------------------------
    console.log(`2. Transitioning the inquiry: ${ACTION}...`);
    try {
      const after = await sandboxTransition(inquiry.id, ACTION);
      console.log(`   status=${after.status}\n`);
    } catch (error) {
      console.log(
        `   Persona refused the transition: ` +
          `${(error as Error).message.split('\n')[0].slice(0, 200)}\n` +
          `   (an inquiry may need to be completed before it can be decided)\n`,
      );
    }

    const final = await getInquiry(inquiry.id);
    console.log(`   final inquiry status at Persona: ${final.status}\n`);

    // --- 3. did the webhooks land? ------------------------------------------
    console.log('3. Waiting for Persona to deliver webhooks to the deployed URL...');
    let deliveries: Array<{
      event_type: string;
      signature_valid: boolean;
      outcome: string;
      outcome_detail: string | null;
      signature_detail: string | null;
    }> = [];

    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const { rows } = await client.query<(typeof deliveries)[number]>(
        `SELECT event_type, signature_valid, outcome, outcome_detail, signature_detail
           FROM webhook_deliveries
          WHERE provider = 'persona' AND payload::text LIKE '%' || $1 || '%'
          ORDER BY received_at`,
        [inquiry.id],
      );
      deliveries = rows;
      process.stdout.write(`   ${deliveries.length} delivery(ies) so far...      \r`);
      if (deliveries.length > 0 && i > 3) break;
    }
    console.log('');

    if (deliveries.length === 0) {
      console.log(
        '\n   NO WEBHOOKS RECEIVED.\n' +
          '   Check the Persona dashboard has an endpoint pointing at\n' +
          `   ${process.env.APP_BASE_URL}/api/webhooks/persona\n` +
          '   and that it is subscribed to inquiry.* events.\n',
      );
      process.exitCode = 1;
    }

    for (const d of deliveries) {
      console.log(
        `   ${d.event_type.padEnd(26)} signature=${d.signature_valid ? 'VERIFIED' : 'FAILED'}  ` +
          `outcome=${d.outcome}`,
      );
      if (d.signature_detail) console.log(`      ${d.signature_detail}`);
      if (d.outcome_detail) console.log(`      ${d.outcome_detail}`);
    }

    // --- 4. did it move our KYC status? -------------------------------------
    const { rows: events } = await client.query<{
      status: string;
      provider_ref: string | null;
      reason: string | null;
    }>(
      `SELECT status::text AS status, provider_ref, reason FROM kyc_events
        WHERE customer_id = $1::uuid ORDER BY effective_at, recorded_at, id`,
      [customer.id],
    );

    console.log(`\n4. KYC history for ${customer.legal_name} (append-only):\n`);
    for (const e of events) {
      console.log(
        `   ${e.status.padEnd(12)} ${(e.provider_ref ?? '').padEnd(30)} ${e.reason ?? ''}`,
      );
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(
      deliveries.some((d) => d.signature_valid)
        ? 'Persona delivered signed webhooks to the deployed system and they verified.'
        : 'No verified Persona webhook yet — see above.',
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nKYC smoke test failed:\n', error instanceof Error ? error.message : error);
  process.exit(1);
});
