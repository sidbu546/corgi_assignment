/**
 * marketdata.ts — daily closing prices. SIMULATED, and labelled as such.
 *
 * Why simulated: Alpaca Broker sandbox credentials are not entitled to the
 * market data API. The brief lists this slot as "live or simulated" (unlike
 * brokerage, KYC and funding, which must be live), so this is a permitted
 * substitution rather than a shortcut — and it is the better choice regardless,
 * because the restatement test needs a CORRECTED CLOSE to arrive on demand for
 * a date three days ago. No real feed will do that for you.
 *
 * Two properties this simulator is built around:
 *
 *  DETERMINISM. The series is generated from a seeded PRNG keyed on the symbol,
 *  so the same symbol produces the same history on every run. A demo that shows
 *  different numbers each time it is seeded is impossible to reason about, and
 *  reproducibility is the whole point of a closed period re-running identically.
 *
 *  HONEST GAPS. Prices exist only on trading days. Weekends, holidays and
 *  deliberately-missing closes are absent from the series rather than filled in
 *  silently. Deciding what to do about a missing close is a valuation policy
 *  decision, and it belongs where it can be surfaced to the user — not hidden
 *  inside a data fetch.
 */

import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { type MarketDate, tradingDaysBetween } from '../calendar';
import { price as toPrice, type PriceCents } from '../money';

export const MARKET_DATA_SOURCE = 'simulator:v1';

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded from the symbol so each
 * instrument has its own stable random walk.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface InstrumentProfile {
  symbol: string;
  /** Starting price in cents at the beginning of the generated series. */
  startCents: number;
  /** Daily volatility as a fraction. Bonds move less than equities. */
  dailyVol: number;
  /** Annualised drift as a fraction. */
  annualDrift: number;
}

/**
 * Starting levels are in CENTS, and are roughly where these ETFs actually
 * trade — a demo where BND prints at $739 a share is a demo nobody who knows
 * the market will take seriously.
 *
 * Written as plain integers rather than with numeric separators: the first
 * version of this table used `7_390_0` intending $73.90 and produced $739.00,
 * a silent factor of ten that the ledger happily balanced.
 */
export const PROFILES: Record<string, InstrumentProfile> = {
  // $524.00
  VOO: { symbol: 'VOO', startCents: 52400, dailyVol: 0.0092, annualDrift: 0.09 },
  // $291.50
  VTI: { symbol: 'VTI', startCents: 29150, dailyVol: 0.0095, annualDrift: 0.09 },
  // $68.20
  VXUS: { symbol: 'VXUS', startCents: 6820, dailyVol: 0.0081, annualDrift: 0.05 },
  // $73.90
  BND: { symbol: 'BND', startCents: 7390, dailyVol: 0.0026, annualDrift: 0.03 },
  // $49.10
  VTIP: { symbol: 'VTIP', startCents: 4910, dailyVol: 0.0021, annualDrift: 0.025 },
};

export interface GeneratedClose {
  symbol: string;
  date: MarketDate;
  priceCents: PriceCents;
}

/**
 * Generate the close series for a symbol over a date range.
 *
 * `skipDates` lets the seed deliberately omit a close so the "missing close"
 * path is exercised by real data rather than by a unit test only.
 */
export function generateSeries(
  symbol: string,
  from: MarketDate,
  to: MarketDate,
  opts: { skipDates?: Set<MarketDate> } = {},
): GeneratedClose[] {
  const profile = PROFILES[symbol];
  if (!profile) throw new Error(`no price profile for ${symbol}`);

  const rand = seededRandom(seedFor(symbol));
  const days = tradingDaysBetween(from, to);
  const driftPerDay = profile.annualDrift / 252;

  const out: GeneratedClose[] = [];
  // Prices are carried in cents with 6dp so the walk does not quantise to whole
  // cents each step, which would bias a low-priced instrument's drift.
  let level = new Decimal(profile.startCents);

  for (const date of days) {
    // Box-Muller for a normal shock; a uniform walk produces a distribution
    // that looks obviously fake on a chart.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const shock = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    const change = driftPerDay + profile.dailyVol * shock;
    level = level.times(1 + change);
    if (level.lessThan(1)) level = new Decimal(1);

    if (opts.skipDates?.has(date)) continue;
    out.push({ symbol, date, priceCents: toPrice(level) });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Persistence — prices are append-only and superseded, never updated
// -----------------------------------------------------------------------------

export async function publishClose(
  client: PoolClient,
  input: {
    symbol: string;
    date: MarketDate;
    priceCents: PriceCents;
    source?: string;
    recordedAt?: Date;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO prices (symbol, price_date, price_cents, source, recorded_at)
     VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()))
     RETURNING id`,
    [
      input.symbol,
      input.date,
      input.priceCents.toFixed(6),
      input.source ?? MARKET_DATA_SOURCE,
      input.recordedAt ?? null,
    ],
  );
  return rows[0].id;
}

/**
 * Publish a CORRECTED close for a past date.
 *
 * This is the trigger for the whole restatement machinery, and note what it
 * does NOT do: it does not update the original row. It inserts a new row for
 * the same (symbol, price_date) with a later recorded_at and a supersedes_id
 * pointing at the row it replaces. The original stays queryable forever, which
 * is what makes "as published" and "as corrected" both answerable.
 */
export async function publishCorrection(
  client: PoolClient,
  input: {
    symbol: string;
    date: MarketDate;
    correctedPriceCents: PriceCents;
    note: string;
    source?: string;
  },
): Promise<{ id: string; supersedesId: string | null; previousCents: string | null }> {
  const { rows: existing } = await client.query<{ id: string; price_cents: string }>(
    `SELECT id, price_cents FROM prices
      WHERE symbol = $1 AND price_date = $2
      ORDER BY recorded_at DESC LIMIT 1`,
    [input.symbol, input.date],
  );
  const previous = existing[0] ?? null;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO prices
       (symbol, price_date, price_cents, source, is_correction, supersedes_id, note)
     VALUES ($1, $2, $3, $4, true, $5, $6)
     RETURNING id`,
    [
      input.symbol,
      input.date,
      input.correctedPriceCents.toFixed(6),
      input.source ?? MARKET_DATA_SOURCE,
      previous?.id ?? null,
      input.note,
    ],
  );

  return {
    id: rows[0].id,
    supersedesId: previous?.id ?? null,
    previousCents: previous?.price_cents ?? null,
  };
}

export interface ResolvedPrice {
  symbol: string;
  /** The date we asked for. */
  requestedDate: MarketDate;
  /** The date the price we found actually belongs to. */
  priceDate: MarketDate;
  priceCents: PriceCents;
  priceId: string;
  /** Calendar days between priceDate and requestedDate. 0 = fresh. */
  ageDays: number;
  isCorrection: boolean;
}

/**
 * The price to value `symbol` at on `asOf`, as known at `knownAt`.
 *
 * Carry-forward policy, stated explicitly because it is a policy and not a
 * detail: if there is no close on the requested date, the most recent EARLIER
 * close is used and its age in days is returned alongside it. The age is
 * carried all the way to the screen. A valuation on a stale price is still a
 * valuation; the customer simply deserves to be told.
 *
 * `knownAt` is what makes as-published reproducible: pass the timestamp of the
 * original statement and corrections that arrived later are excluded, exactly
 * as they were on the day.
 */
export async function resolvePrice(
  client: PoolClient,
  input: {
    symbol: string;
    asOf: MarketDate;
    knownAt?: Date;
    maxStaleDays?: number;
  },
): Promise<ResolvedPrice | null> {
  const { rows } = await client.query<{
    id: string;
    price_date: string;
    price_cents: string;
    is_correction: boolean;
  }>(
    `SELECT id, to_char(price_date, 'YYYY-MM-DD') AS price_date,
            price_cents, is_correction
       FROM prices
      WHERE symbol = $1
        AND price_date <= $2::date
        AND recorded_at <= coalesce($3::timestamptz, 'infinity')
      ORDER BY price_date DESC, recorded_at DESC
      LIMIT 1`,
    [input.symbol, input.asOf, input.knownAt ?? null],
  );

  const row = rows[0];
  if (!row) return null;

  const ageDays = Math.round(
    (Date.parse(`${input.asOf}T00:00:00Z`) -
      Date.parse(`${row.price_date}T00:00:00Z`)) /
      86_400_000,
  );

  if (input.maxStaleDays !== undefined && ageDays > input.maxStaleDays) return null;

  return {
    symbol: input.symbol,
    requestedDate: input.asOf,
    priceDate: row.price_date,
    priceCents: toPrice(row.price_cents),
    priceId: row.id,
    ageDays,
    isCorrection: row.is_correction,
  };
}

/** Full supersession history for a date — what we said, and what we say now. */
export async function priceHistory(
  client: PoolClient,
  symbol: string,
  date: MarketDate,
): Promise<
  Array<{
    id: string;
    priceCents: string;
    source: string;
    isCorrection: boolean;
    note: string | null;
    recordedAt: Date;
  }>
> {
  const { rows } = await client.query(
    `SELECT id, price_cents, source, is_correction, note, recorded_at
       FROM prices WHERE symbol = $1 AND price_date = $2
      ORDER BY recorded_at ASC`,
    [symbol, date],
  );
  return rows.map((r) => ({
    id: r.id,
    priceCents: r.price_cents,
    source: r.source,
    isCorrection: r.is_correction,
    note: r.note,
    recordedAt: r.recorded_at,
  }));
}
