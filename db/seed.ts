/**
 * seed.ts — stand up believable demo data from zero.
 *
 *   npm run seed            populate an empty database
 *   npm run seed -- --reset drop the schema, re-migrate, then populate
 *
 * WHY --reset EXISTS, AND WHY IT IS NOT A CONTRADICTION.
 * Money rows are append-only: the database refuses UPDATE, DELETE and TRUNCATE
 * on every journal table, and this script does not attempt any of them. `--reset`
 * DROPs the entire schema — a DDL operation on a development database, not a
 * mutation of money rows in a live one. Re-running the seed without `--reset`
 * against a populated database is refused rather than silently duplicating.
 *
 * WHAT IT BUILDS, and why each piece is there:
 *
 *   4 model portfolios, versioned      the model can change without existing
 *                                      customers silently jumping to it
 *   5 instruments, ~90 days of closes  deterministic, with real calendar gaps
 *   1 deliberately missing close       so the stale-price path runs on real data
 *   4 customers                        approved x2, pending x1, rejected x1 —
 *                                      the brief wants the unhappy states visible
 *   deposits -> T+1 settlement         settled and unsettled cash genuinely diverge
 *   notional buys                      fractional shares, model weights allocated
 *                                      by largest-remainder
 *   a dividend, ex-date and pay-date   the receivable exists in between
 *   a partial sell across two lots     FIFO consumption with a real realised gain
 *
 * A NOTE ON recorded_at, stated plainly because it matters for the as-published
 * demo: `recorded_at` is assigned by the database and can never be backdated —
 * that is the point of it. So every seeded entry carries a recorded_at of "when
 * the seed ran", which is honest: we did learn all of it at once. The
 * *effective* dates are genuinely historical, so "the portfolio as it stood on
 * 15 July" works fully. The as-published axis becomes interesting from the seed
 * forward, which is exactly where the restatement demo operates.
 */

import '../src/lib/pg-types';
import { Client, Pool, type PoolClient } from 'pg';
import { config } from 'dotenv';
import Decimal from 'decimal.js';

config({ path: '.env.local', quiet: true });

import { applyMigrations } from './apply-migrations';
import { hashPassword } from '../src/lib/auth';
import { allocate, decimalToCents, units as toUnits, formatCents } from '../src/lib/money';
import { postEntry, usd, shares } from '../src/lib/ledger/post';
import { recordBuyFill, recordSellFill, settleBuy, settleSell } from '../src/lib/ledger/trades';
import { generateSeries, publishClose, PROFILES } from '../src/lib/providers/marketdata';
import { settlementDate, marketDateOf, type MarketDate } from '../src/lib/calendar';

const SEED_ACTOR = 'seed';

// -----------------------------------------------------------------------------
// The demo timeline. Fixed dates so the demo is reproducible.
// -----------------------------------------------------------------------------

const SERIES_START: MarketDate = '2026-06-08';
const TODAY: MarketDate = marketDateOf(new Date());

/** A close deliberately withheld, so the stale-price path is exercised for real. */
const MISSING_CLOSE = { symbol: 'VXUS', date: '2026-07-22' as MarketDate };

const MODELS = [
  {
    id: 'conservative',
    name: 'Conservative',
    description: 'Capital preservation. Mostly investment-grade bonds.',
    riskRank: 1,
    weights: { BND: 6000, VTIP: 2000, VOO: 1500, VXUS: 500 },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'A classic 55/45 split between equities and bonds.',
    riskRank: 2,
    weights: { VOO: 4000, VXUS: 1500, BND: 3500, VTIP: 1000 },
  },
  {
    id: 'growth',
    name: 'Growth',
    description: 'Equity-led, with a bond sleeve to damp drawdowns.',
    riskRank: 3,
    weights: { VOO: 5500, VTI: 1500, VXUS: 2000, BND: 1000 },
  },
  {
    id: 'aggressive',
    name: 'Aggressive',
    description: 'All equity, global. No bond allocation.',
    riskRank: 4,
    weights: { VOO: 4500, VTI: 3000, VXUS: 2500 },
  },
] as const;

const INSTRUMENTS = [
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', assetClass: 'equity' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', assetClass: 'equity' },
  { symbol: 'VXUS', name: 'Vanguard Total International Stock ETF', assetClass: 'equity' },
  { symbol: 'BND', name: 'Vanguard Total Bond Market ETF', assetClass: 'bond' },
  { symbol: 'VTIP', name: 'Vanguard Short-Term Inflation-Protected Securities ETF', assetClass: 'bond' },
] as const;

const DIVIDENDS = [
  { symbol: 'VOO', exDate: '2026-08-14', payDate: '2026-08-18', perUnitCents: '165.4000' },
  { symbol: 'BND', exDate: '2026-08-03', payDate: '2026-08-05', perUnitCents: '19.7000' },
] as const;

// -----------------------------------------------------------------------------

function log(section: string, detail = '') {
  console.log(`${section.padEnd(46)}${detail}`);
}

async function priceOn(
  client: PoolClient,
  symbol: string,
  date: MarketDate,
): Promise<Decimal> {
  const { rows } = await client.query<{ price_cents: string }>(
    `SELECT price_cents FROM prices
      WHERE symbol = $1 AND price_date <= $2::date
      ORDER BY price_date DESC, recorded_at DESC LIMIT 1`,
    [symbol, date],
  );
  if (!rows[0]) throw new Error(`no price for ${symbol} on or before ${date}`);
  return new Decimal(rows[0].price_cents);
}

async function unitsHeld(
  client: PoolClient,
  customerId: string,
  symbol: string,
  asOf: MarketDate,
): Promise<Decimal> {
  const { rows } = await client.query<{ units: string | null }>(
    `SELECT sum(l.units) AS units
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid AND l.account_code = 'assets:positions'
        AND l.commodity = $2 AND e.effective_at <= $3::date + interval '1 day'`,
    [customerId, symbol, asOf],
  );
  return new Decimal(rows[0]?.units ?? 0);
}

/** Midday Eastern on a market date, so effective dates land inside a session. */
function at(date: MarketDate): Date {
  return new Date(`${date}T16:00:00Z`);
}

// -----------------------------------------------------------------------------
// Phases
// -----------------------------------------------------------------------------

async function seedReference(client: PoolClient) {
  for (const i of INSTRUMENTS) {
    await client.query(
      `INSERT INTO instruments (symbol, name, asset_class) VALUES ($1, $2, $3)
       ON CONFLICT (symbol) DO NOTHING`,
      [i.symbol, i.name, i.assetClass],
    );
  }
  log('  instruments', `${INSTRUMENTS.length}`);

  for (const m of MODELS) {
    await client.query(
      `INSERT INTO model_portfolios (id, name, description, risk_rank)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [m.id, m.name, m.description, m.riskRank],
    );
    const {
      rows: [version],
    } = await client.query<{ id: string }>(
      `INSERT INTO model_versions (model_id, version, effective_at)
       VALUES ($1, 1, $2) RETURNING id`,
      [m.id, at(SERIES_START)],
    );

    const total = Object.values(m.weights).reduce((a, b) => a + b, 0);
    if (total !== 10000) {
      throw new Error(`model ${m.id} weights sum to ${total} bps, must be 10000`);
    }
    for (const [symbol, bps] of Object.entries(m.weights)) {
      await client.query(
        `INSERT INTO model_weights (model_version_id, symbol, weight_bps)
         VALUES ($1, $2, $3)`,
        [version.id, symbol, bps],
      );
    }
  }
  log('  model portfolios', `${MODELS.length}, each version 1, weights sum to 10000bps`);

  let closes = 0;
  for (const profile of Object.values(PROFILES)) {
    const skip =
      profile.symbol === MISSING_CLOSE.symbol
        ? new Set([MISSING_CLOSE.date])
        : undefined;
    const series = generateSeries(profile.symbol, SERIES_START, TODAY, {
      skipDates: skip,
    });
    for (const close of series) {
      await publishClose(client, {
        symbol: close.symbol,
        date: close.date,
        priceCents: close.priceCents,
      });
      closes++;
    }
  }
  log('  daily closes', `${closes} (deterministic, trading days only)`);
  log(
    '  deliberately missing close',
    `${MISSING_CLOSE.symbol} on ${MISSING_CLOSE.date} — stale-price path`,
  );

  for (const d of DIVIDENDS) {
    await client.query(
      `INSERT INTO corporate_actions
         (kind, symbol, declared_date, ex_date, pay_date, amount_per_unit, source)
       VALUES ('cash_dividend', $1, $2::date - 10, $2, $3, $4, 'simulator:v1')`,
      [d.symbol, d.exDate, d.payDate, d.perUnitCents],
    );
  }
  log('  corporate actions', `${DIVIDENDS.length} cash dividends`);
}

interface DemoCustomer {
  id: string;
  name: string;
  email: string;
  model: string;
}

async function seedPeople(client: PoolClient): Promise<DemoCustomer[]> {
  const opsHash = await hashPassword('ops-password');
  const customerHash = await hashPassword('demo-password');

  const people = [
    { name: 'Dana Whitfield', email: 'dana@demo.ledgerly.app', kyc: 'approved', model: 'growth', kycDate: '2026-06-10' },
    { name: 'Marcus Ellery', email: 'marcus@demo.ledgerly.app', kyc: 'approved', model: 'balanced', kycDate: '2026-07-13' },
    { name: 'Priya Raman', email: 'priya@demo.ledgerly.app', kyc: 'pending', model: 'conservative', kycDate: '2026-09-02' },
    { name: 'Alex Okafor', email: 'alex@demo.ledgerly.app', kyc: 'rejected', model: 'balanced', kycDate: '2026-09-03' },
  ] as const;

  const out: DemoCustomer[] = [];

  for (const p of people) {
    const {
      rows: [customer],
    } = await client.query<{ id: string }>(
      `INSERT INTO customers (legal_name, email) VALUES ($1, $2) RETURNING id`,
      [p.name, p.email],
    );

    await client.query(
      `INSERT INTO users (email, password_hash, role, display_name, customer_id)
       VALUES ($1, $2, 'customer', $3, $4)`,
      [p.email, customerHash, p.name, customer.id],
    );

    // Every customer starts not_started, then moves. The history of states is
    // the artefact; the current status is just the latest row.
    await client.query(
      `INSERT INTO kyc_events (customer_id, status, provider, effective_at)
       VALUES ($1, 'not_started', 'persona', $2)`,
      [customer.id, at(p.kycDate)],
    );
    await client.query(
      `INSERT INTO kyc_events (customer_id, status, provider, provider_ref, effective_at)
       VALUES ($1, 'pending', 'persona', $2, $3)`,
      [customer.id, `inq_demo_${p.email.split('@')[0]}`, at(p.kycDate)],
    );
    if (p.kyc !== 'pending') {
      await client.query(
        `INSERT INTO kyc_events
           (customer_id, status, provider, provider_ref, reason, effective_at)
         VALUES ($1, $2, 'persona', $3, $4, $5)`,
        [
          customer.id,
          p.kyc,
          `inq_demo_${p.email.split('@')[0]}`,
          p.kyc === 'rejected'
            ? 'Government ID could not be matched to the submitted identity'
            : null,
          at(p.kycDate),
        ],
      );
    }

    if (p.kyc === 'approved') {
      const {
        rows: [version],
      } = await client.query<{ id: string }>(
        `SELECT id FROM model_versions WHERE model_id = $1 AND version = 1`,
        [p.model],
      );
      await client.query(
        `INSERT INTO customer_mandates (customer_id, model_version_id, effective_at)
         VALUES ($1, $2, $3)`,
        [customer.id, version.id, at(p.kycDate)],
      );
      out.push({ id: customer.id, name: p.name, email: p.email, model: p.model });
    }
  }

  await client.query(
    `INSERT INTO users (email, password_hash, role, display_name)
     VALUES ($1, $2, 'ops', $3)`,
    ['ops@demo.ledgerly.app', opsHash, 'Ops — Jordan Vance'],
  );
  await client.query(
    `INSERT INTO users (email, password_hash, role, display_name)
     VALUES ($1, $2, 'ops', $3)`,
    ['approver@demo.ledgerly.app', opsHash, 'Ops — Sam Whitlock (approver)'],
  );

  log('  customers', '4 — 2 approved, 1 pending, 1 rejected');
  log('  users', '4 customer logins + 2 ops logins (maker and checker)');
  return out;
}

/** Deposit -> pending -> settled, as two entries on two dates. */
async function deposit(
  client: PoolClient,
  input: { customerId: string; amountCents: bigint; initiatedOn: MarketDate },
) {
  const settlesOn = settlementDate(input.initiatedOn);

  await postEntry(client, {
    kind: 'deposit.initiated',
    effectiveAt: at(input.initiatedOn),
    source: 'plaid+alpaca',
    createdBy: SEED_ACTOR,
    narrative: `ACH deposit of ${formatCents(input.amountCents)} initiated from linked bank`,
    lines: [
      usd('assets:cash:pending_deposit', input.amountCents, {
        customerId: input.customerId,
        memo: 'in flight — not investable, not withdrawable',
      }),
      usd('equity:external:bank', -input.amountCents),
    ],
  });

  await postEntry(client, {
    kind: 'deposit.settled',
    effectiveAt: at(settlesOn),
    source: 'plaid+alpaca',
    createdBy: SEED_ACTOR,
    narrative: `ACH deposit of ${formatCents(input.amountCents)} became good funds`,
    lines: [
      usd('assets:cash:pending_deposit', -input.amountCents, {
        customerId: input.customerId,
      }),
      usd('assets:cash:settled', input.amountCents, { customerId: input.customerId }),
    ],
  });
}

/**
 * Invest a cash amount into a model, as notional (fractional) buys.
 *
 * The amount is split across the model's weights by largest-remainder so the
 * parts sum to exactly the amount. Units are then amount/price to 6dp, and the
 * few cents that fractional rounding leaves behind stay in settled cash —
 * which is what actually happens, rather than being quietly absorbed.
 */
async function investIntoModel(
  client: PoolClient,
  input: {
    customerId: string;
    modelId: string;
    amountCents: bigint;
    tradeDate: MarketDate;
  },
) {
  const { rows: weights } = await client.query<{ symbol: string; weight_bps: number }>(
    `SELECT w.symbol, w.weight_bps
       FROM model_weights w
       JOIN model_versions v ON v.id = w.model_version_id
      WHERE v.model_id = $1 AND v.version = 1
      ORDER BY w.symbol`,
    [input.modelId],
  );

  const parts = allocate(
    input.amountCents,
    weights.map((w) => new Decimal(w.weight_bps)),
  );

  const settlesOn = settlementDate(input.tradeDate);
  let totalCost = 0n;

  for (let i = 0; i < weights.length; i++) {
    const symbol = weights[i].symbol;
    const notional = parts[i];
    if (notional <= 0n) continue;

    const priceCents = await priceOn(client, symbol, input.tradeDate);
    const qty = toUnits(new Decimal(notional.toString()).div(priceCents));
    if (qty.lessThanOrEqualTo(0)) continue;

    const { costCents } = await recordBuyFill(client, {
      customerId: input.customerId,
      symbol,
      units: qty,
      priceCents,
      tradeDate: at(input.tradeDate),
      source: 'alpaca.broker',
      sourceRef: `seed-${input.modelId}-${symbol}-${input.tradeDate}`,
      createdBy: SEED_ACTOR,
    });
    totalCost += costCents;

    await settleBuy(client, {
      customerId: input.customerId,
      amountCents: costCents,
      settlementDate: at(settlesOn),
      source: 'alpaca.broker',
      createdBy: SEED_ACTOR,
    });
  }

  return totalCost;
}

async function payDividend(
  client: PoolClient,
  input: {
    customerId: string;
    symbol: string;
    exDate: MarketDate;
    payDate: MarketDate;
    perUnitCents: string;
  },
) {
  const held = await unitsHeld(client, input.customerId, input.symbol, input.exDate);
  if (held.lessThanOrEqualTo(0)) return 0n;

  const amount = decimalToCents(held.times(new Decimal(input.perUnitCents)));
  if (amount <= 0n) return 0n;

  // Ex-date: the entitlement is EARNED. Income is recognised here, not when the
  // cash happens to turn up, and the receivable is the gap between the two.
  await postEntry(client, {
    kind: 'dividend.accrued',
    effectiveAt: at(input.exDate),
    source: 'custodian.simulator',
    createdBy: SEED_ACTOR,
    narrative:
      `${input.symbol} dividend ${input.perUnitCents}c/unit on ` +
      `${held.toString()} units — entitlement earned on ex-date`,
    lines: [
      usd('assets:receivable:dividend', amount, {
        customerId: input.customerId,
        symbol: input.symbol,
      }),
      usd('income:dividend', -amount, {
        customerId: input.customerId,
        symbol: input.symbol,
      }),
    ],
  });

  // Pay-date: the cash arrives and the receivable clears.
  await postEntry(client, {
    kind: 'dividend.paid',
    effectiveAt: at(input.payDate),
    source: 'custodian.simulator',
    createdBy: SEED_ACTOR,
    narrative: `${input.symbol} dividend cash received`,
    lines: [
      usd('assets:cash:settled', amount, { customerId: input.customerId }),
      usd('assets:receivable:dividend', -amount, {
        customerId: input.customerId,
        symbol: input.symbol,
      }),
    ],
  });

  return amount;
}

async function seedJourneys(client: PoolClient, customers: DemoCustomer[]) {
  const dana = customers.find((c) => c.email.startsWith('dana'))!;
  const marcus = customers.find((c) => c.email.startsWith('marcus'))!;

  // --- Dana: two deposits, so TWR has more than one external flow ----------
  await deposit(client, {
    customerId: dana.id,
    amountCents: 2_500_000n,
    initiatedOn: '2026-06-10',
  });
  await investIntoModel(client, {
    customerId: dana.id,
    modelId: 'growth',
    amountCents: 2_499_000n,
    tradeDate: '2026-06-12',
  });
  log('  Dana Whitfield', '$25,000 deposit -> Growth model, 12 Jun');

  await deposit(client, {
    customerId: dana.id,
    amountCents: 1_000_000n,
    initiatedOn: '2026-08-03',
  });
  await investIntoModel(client, {
    customerId: dana.id,
    modelId: 'growth',
    amountCents: 999_500n,
    tradeDate: '2026-08-05',
  });
  log('', '$10,000 top-up -> Growth model, 5 Aug');

  // --- Marcus --------------------------------------------------------------
  await deposit(client, {
    customerId: marcus.id,
    amountCents: 1_000_000n,
    initiatedOn: '2026-07-15',
  });
  await investIntoModel(client, {
    customerId: marcus.id,
    modelId: 'balanced',
    amountCents: 999_500n,
    tradeDate: '2026-07-17',
  });
  log('  Marcus Ellery', '$10,000 deposit -> Balanced model, 17 Jul');

  // --- dividends -----------------------------------------------------------
  let dividendTotal = 0n;
  for (const d of DIVIDENDS) {
    for (const c of customers) {
      dividendTotal += await payDividend(client, {
        customerId: c.id,
        symbol: d.symbol,
        exDate: d.exDate,
        payDate: d.payDate,
        perUnitCents: d.perUnitCents,
      });
    }
  }
  log('  dividends', `${formatCents(dividendTotal)} across ex-date and pay-date`);

  // --- a partial sell, spanning two lots -----------------------------------
  // Dana bought VXUS twice (June and August). Selling 85% of the holding
  // exhausts the June lot ENTIRELY and takes part of the August lot, so the
  // disposal spans two lots with different bases and different holding periods
  // — which is the case that actually exercises FIFO, and the case where the
  // "exhausting consumption takes the remaining basis exactly" rule matters.
  // A smaller sale would sit inside the first lot and prove nothing.
  const sellDate: MarketDate = '2026-08-20';
  const heldVxus = await unitsHeld(client, dana.id, 'VXUS', sellDate);
  const sellUnits = toUnits(heldVxus.times('0.85'));
  const sellPrice = await priceOn(client, 'VXUS', sellDate);

  const sell = await recordSellFill(client, {
    customerId: dana.id,
    symbol: 'VXUS',
    units: sellUnits,
    priceCents: sellPrice,
    tradeDate: at(sellDate),
    source: 'alpaca.broker',
    sourceRef: `seed-sell-VXUS-${sellDate}`,
    createdBy: SEED_ACTOR,
  });
  await settleSell(client, {
    customerId: dana.id,
    amountCents: sell.proceedsCents,
    settlementDate: at(settlementDate(sellDate)),
    source: 'alpaca.broker',
    createdBy: SEED_ACTOR,
  });

  log(
    '  FIFO sell',
    `${sellUnits.toString()} VXUS across ${sell.plan.consumptions.length} lot(s), ` +
      `realised ${formatCents(sell.plan.totalRealizedGainCents)}`,
  );
}

// -----------------------------------------------------------------------------

async function main() {
  const reset = process.argv.includes('--reset');
  const connectionString = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env.local.');
    process.exit(1);
  }

  if (reset) {
    console.log('\n--reset: dropping schema and re-migrating\n');
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      // DDL on a development database. Note this is a DROP of the schema, not
      // an UPDATE or DELETE against money rows — those remain impossible.
      await admin.query('DROP SCHEMA public CASCADE');
      await admin.query('CREATE SCHEMA public');
      await applyMigrations(admin, (line) => console.log(line));
    } finally {
      await admin.end();
    }
    console.log('');
  }

  const pool = new Pool({ connectionString, max: 4 });
  const client = await pool.connect();

  try {
    const {
      rows: [counts],
    } = await client.query<{ entries: string }>(
      `SELECT count(*) AS entries FROM journal_entries`,
    );
    if (Number(counts.entries) > 0) {
      console.error(
        `\nRefusing to seed: the journal already has ${counts.entries} entries.\n` +
          `Money rows are append-only, so seeding on top would duplicate history ` +
          `rather than replace it.\n\n` +
          `Run:  npm run seed -- --reset\n`,
      );
      process.exit(1);
    }

    console.log('Seeding from zero\n');
    const startedAt = new Date();

    console.log('reference data');
    await client.query('BEGIN');
    await seedReference(client);
    await client.query('COMMIT');

    console.log('\npeople');
    await client.query('BEGIN');
    const customers = await seedPeople(client);
    await client.query('COMMIT');

    console.log('\nmoney');
    await client.query('BEGIN');
    await seedJourneys(client, customers);
    await client.query('COMMIT');

    // --- verify the whole thing balances -----------------------------------
    const { rows: totals } = await client.query<{
      commodity: string;
      cents: string | null;
      units: string | null;
    }>(
      `SELECT commodity, sum(amount_cents)::bigint AS cents, sum(units) AS units
         FROM journal_lines GROUP BY commodity ORDER BY commodity`,
    );

    console.log('\ntrial balance');
    let balanced = true;
    for (const t of totals) {
      const cents = BigInt(t.cents ?? '0');
      const units = new Decimal(t.units ?? 0);
      const ok = cents === 0n && units.isZero();
      if (!ok) balanced = false;
      log(
        `  ${t.commodity}`,
        `cents=${cents} units=${units.toString()} ${ok ? 'OK' : '*** OUT OF BALANCE ***'}`,
      );
    }

    const {
      rows: [summary],
    } = await client.query<{ entries: string; lines: string; lots: string; prices: string }>(
      `SELECT (SELECT count(*) FROM journal_entries) AS entries,
              (SELECT count(*) FROM journal_lines)   AS lines,
              (SELECT count(*) FROM tax_lots)        AS lots,
              (SELECT count(*) FROM prices)          AS prices`,
    );

    console.log('\nsummary');
    log('  journal entries', summary.entries);
    log('  journal lines', summary.lines);
    log('  tax lots', summary.lots);
    log('  price rows', summary.prices);
    log('  seeded at', startedAt.toISOString());

    console.log('\nlogins');
    log('  customer', 'dana@demo.ledgerly.app / demo-password');
    log('  customer', 'marcus@demo.ledgerly.app / demo-password');
    log('  customer (KYC pending)', 'priya@demo.ledgerly.app / demo-password');
    log('  customer (KYC rejected)', 'alex@demo.ledgerly.app / demo-password');
    log('  ops (maker)', 'ops@demo.ledgerly.app / ops-password');
    log('  ops (checker)', 'approver@demo.ledgerly.app / ops-password');

    if (!balanced) {
      console.error('\nSEED PRODUCED AN UNBALANCED LEDGER — this is a bug.');
      process.exit(1);
    }
    console.log('\nDone. The ledger balances.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\nSeed failed:\n');
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
