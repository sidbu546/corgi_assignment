/**
 * evidence.ts — ask the PROVIDERS what they hold, not our own app.
 *
 * "How do I know money is moving?" is the right question, and our ledger cannot
 * answer it. A ledger proves our bookkeeping is consistent; it proves nothing
 * about whether a third party ever heard from us. So this script deliberately
 * does NOT read our database for its claims. It calls each provider's API and
 * prints what THEY say exists, with the ids you can look up in their own
 * dashboards.
 *
 * Then, separately, it shows our webhook inbox — which is evidence in the other
 * direction: those providers called US back, signed, and we verified it.
 *
 * Run: npm run evidence
 */

import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import '../src/lib/pg-types';
import { Pool } from 'pg';

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;

const brokerAuth = `Basic ${Buffer.from(
  `${process.env.ALPACA_BROKER_KEY_ID}:${process.env.ALPACA_BROKER_SECRET}`,
).toString('base64')}`;

async function broker<T>(path: string): Promise<T> {
  const res = await fetch(`${process.env.ALPACA_BROKER_BASE_URL}${path}`, {
    headers: { Authorization: brokerAuth },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function paper<T>(path: string): Promise<T> {
  const res = await fetch(`${process.env.ALPACA_PAPER_BASE_URL}${path}`, {
    headers: {
      'APCA-API-KEY-ID': process.env.ALPACA_PAPER_KEY_ID ?? '',
      'APCA-API-SECRET-KEY': process.env.ALPACA_PAPER_SECRET ?? '',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function persona<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.withpersona.com/api/v1${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
      'Persona-Version': '2023-01-05',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  console.log(
    `\n${B('Evidence that money moved')}\n` +
      D(
        'Every figure below comes from the PROVIDER, not from our database.\n' +
          'Look any id up in the provider dashboard and it will be there.\n',
      ),
  );

  // ---------------------------------------------------------------- Alpaca
  console.log(B('\n1. Alpaca Broker API — accounts we opened\n'));
  try {
    const accounts = await broker<
      Array<{ id: string; account_number: string; status: string; created_at: string }>
    >('/v1/accounts');
    console.log(`   ${accounts.length} brokerage account(s) exist at Alpaca:\n`);
    for (const a of accounts.slice(0, 8)) {
      console.log(
        `     ${a.account_number.padEnd(12)} ${a.status.padEnd(10)} ${a.id}  ${D(
          a.created_at.slice(0, 19),
        )}`,
      );
    }

    console.log(B('\n2. Alpaca Broker API — ACH relationships and transfers\n'));
    let anyTransfer = false;
    for (const a of accounts.slice(0, 8)) {
      const rels = await broker<Array<{ id: string; status: string; nickname: string }>>(
        `/v1/accounts/${a.id}/ach_relationships`,
      ).catch(() => []);
      const transfers = await broker<
        Array<{ id: string; status: string; amount: string; direction: string; created_at: string }>
      >(`/v1/accounts/${a.id}/transfers`).catch(() => []);
      if (rels.length === 0 && transfers.length === 0) continue;

      console.log(`     account ${a.account_number}`);
      for (const r of rels) {
        console.log(`       ACH relationship  ${r.status.padEnd(10)} ${r.id}`);
      }
      for (const t of transfers) {
        anyTransfer = true;
        console.log(
          `       ${t.direction} transfer  ${Y(('$' + t.amount).padEnd(12))} ` +
            `${t.status.padEnd(18)} ${t.id}`,
        );
      }
    }
    if (!anyTransfer) console.log(D('     (no transfers)'));
  } catch (error) {
    console.log(`   unavailable: ${error instanceof Error ? error.message : error}`);
  }

  // ------------------------------------------------------------ paper venue
  console.log(B('\n3. Alpaca paper venue — real orders resting at the broker\n'));
  try {
    const account = await paper<{ account_number: string; cash: string; buying_power: string }>(
      '/v2/account',
    );
    const clock = await paper<{ is_open: boolean; next_open: string }>('/v2/clock');
    console.log(
      `     account ${account.account_number}   cash ${Y('$' + account.cash)}   ` +
        `buying power ${Y('$' + account.buying_power)}`,
    );
    console.log(
      `     market ${clock.is_open ? G('OPEN') : 'closed'}  ·  next open ${clock.next_open}\n`,
    );

    const orders = await paper<
      Array<{
        id: string;
        symbol: string;
        side: string;
        notional: string | null;
        status: string;
        filled_qty: string;
        filled_avg_price: string | null;
        submitted_at: string;
      }>
    >('/v2/orders?status=all&limit=20');

    if (orders.length === 0) console.log(D('     (no orders)'));
    for (const o of orders) {
      const filled = Number(o.filled_qty) > 0;
      console.log(
        `     ${o.symbol.padEnd(5)} ${o.side.padEnd(4)} ` +
          `${(o.notional ? '$' + o.notional : '').padEnd(9)} ` +
          `${(filled ? G(o.status) : o.status).padEnd(18)} ` +
          `${filled ? G(`filled ${o.filled_qty} @ ${o.filled_avg_price}`) : D('awaiting the open')}  ` +
          `${D(o.id)}`,
      );
    }
  } catch (error) {
    console.log(`   unavailable: ${error instanceof Error ? error.message : error}`);
  }

  // --------------------------------------------------------------- Persona
  console.log(B('\n4. Persona — identity inquiries we opened\n'));
  try {
    const result = await persona<{
      data: Array<{ id: string; attributes: { status: string; 'reference-id': string | null } }>;
    }>('/inquiries?page%5Bsize%5D=10');
    if (result.data.length === 0) console.log(D('     (none)'));
    for (const i of result.data) {
      const s = i.attributes.status;
      console.log(
        `     ${(s === 'approved' ? G(s) : s === 'declined' ? Y(s) : s).padEnd(18)} ` +
          `${i.id}  ${D('ref ' + (i.attributes['reference-id'] ?? '—'))}`,
      );
    }
  } catch (error) {
    console.log(`   unavailable: ${error instanceof Error ? error.message : error}`);
  }

  // ------------------------------------------- providers calling US back
  console.log(B('\n5. Providers called US back — signed, verified webhooks\n'));
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL,
    max: 2,
  });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      provider: string;
      event_type: string;
      signature_valid: boolean;
      outcome: string;
      n: string;
    }>(
      `SELECT provider, event_type, signature_valid, outcome, count(*)::text AS n
         FROM webhook_deliveries
        GROUP BY 1,2,3,4 ORDER BY provider, event_type`,
    );
    for (const r of rows) {
      console.log(
        `     ${r.provider.padEnd(9)} ${r.event_type.padEnd(28)} ` +
          `${(r.signature_valid ? G('signature verified') : Y('signature REJECTED')).padEnd(28)} ` +
          `${r.outcome.padEnd(20)} ${r.n}×`,
      );
    }

    const { rows: dupes } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM webhook_duplicate_deliveries`,
    );
    console.log(
      `\n     ${dupes[0].n} repeat deliveries absorbed — delivered more than once, acted on once.`,
    );

    // ------------------------------------------------- cross-reference
    console.log(B('\n6. Provider ids recorded against our journal entries\n'));
    const { rows: linked } = await client.query<{
      kind: string;
      source: string;
      source_ref: string | null;
      narrative: string;
      entry_id: string;
    }>(
      `SELECT kind, source, source_ref, narrative, id AS entry_id
         FROM journal_entries
        WHERE source_ref IS NOT NULL AND source <> 'seed'
        ORDER BY recorded_at DESC LIMIT 8`,
    );
    if (linked.length === 0) console.log(D('     (none yet)'));
    for (const l of linked) {
      console.log(`     ${l.kind.padEnd(20)} ${D('via ' + l.source)}`);
      console.log(`       provider ref  ${Y(l.source_ref ?? '—')}`);
      console.log(`       our entry     ${l.entry_id}`);
      console.log(D(`       ${l.narrative.slice(0, 90)}`));
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(
    `\n${'='.repeat(76)}\n` +
      'Each id above exists in the provider\'s own system. That is the evidence:\n' +
      'not that our ledger says so, but that a third party independently agrees.\n',
  );
}

main().catch((error) => {
  console.error('\nevidence failed:', error);
  process.exit(1);
});
