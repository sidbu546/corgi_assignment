/**
 * custodian.ts — the morning file. SIMULATED, and the brief expects it to be.
 *
 * A custodian simulator that always agrees with us would be worthless. Its
 * entire job is to disagree in the ways a real custodian disagrees, so that
 * reconciliation has something to catch and an ops team has something to
 * classify. This one ships four kinds of disagreement:
 *
 *   TIMING          it settles T+1 and we book on trade date, so an unsettled
 *                   trade legitimately shows a different cash figure. This is
 *                   the noise a real breaks screen drowns in, and the reason
 *                   classification matters more than detection.
 *
 *   LATE DIVIDEND   the custodian knows about a distribution we have not booked
 *                   yet. Real, common, and the thing that forces a restatement
 *                   of a period we have already reported.
 *
 *   CORRECTED PRICE a closing price we already used turns out to be wrong. This
 *                   is the restatement trigger, and it is the reason this slot
 *                   is simulated rather than live: no market data feed will
 *                   issue a correction on demand for a demo.
 *
 *   GENUINE BREAK   a position that simply does not match, with no benign
 *                   explanation. The one that must not get lost in the noise.
 *
 * The file is generated FROM our own ledger and then perturbed, which is
 * deliberate: it means a clean run really is clean, so any break the
 * reconciliation reports is one the simulator planted or one we caused. There
 * is no ambient disagreement to hide a real problem behind.
 */

import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import type { MarketDate } from '../calendar';
import type { Cents } from '../money';

export const CUSTODIAN_SOURCE = 'custodian-sim:v1';

export interface CustodianPosition {
  symbol: string;
  units: string;
}

export interface CustodianTransaction {
  type: 'dividend' | 'trade' | 'transfer' | 'fee';
  symbol: string | null;
  amount_cents: number;
  settled_on: MarketDate;
  reference: string;
  memo: string;
}

export interface CustodianFile {
  as_of: MarketDate;
  account_ref: string;
  customer_id: string;
  generated_at: string;
  positions: CustodianPosition[];
  cash: { settled_cents: number };
  transactions: CustodianTransaction[];
  /** What the simulator deliberately did. Never read by reconciliation. */
  _injected: string[];
}

export interface AnomalyOptions {
  /** Report a position we do not hold, or a different quantity for one we do. */
  tamperPosition?: { symbol: string; deltaUnits: string };
  /** Report a distribution we have not booked. */
  lateDividend?: { symbol: string; amountCents: number };
  /** Report a cash figure that differs by this many cents. */
  cashDelta?: number;
}

/**
 * Build the morning file for a customer.
 *
 * `_injected` records what was perturbed so a demo can say what it planted, but
 * reconciliation never reads it — it must find the breaks from the data alone,
 * exactly as it would against a real custodian.
 */
export async function generateFile(
  client: PoolClient,
  input: {
    customerId: string;
    asOf: MarketDate;
    anomalies?: AnomalyOptions;
  },
): Promise<CustodianFile> {
  const anomalies = input.anomalies ?? {};
  const injected: string[] = [];

  // --- positions, as the custodian would see them --------------------------
  // The custodian records SETTLED positions. We book on trade date. That gap is
  // real and is the most common benign break, so the file is built from settled
  // reality rather than from our trade-date view.
  const { rows: positionRows } = await client.query<{
    commodity: string;
    units: string;
  }>(
    `SELECT l.commodity, sum(l.units) AS units
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid
        AND l.account_code = 'assets:positions'
        AND e.effective_at < ($2::date + 1)
      GROUP BY 1
     HAVING sum(l.units) <> 0
      ORDER BY 1`,
    [input.customerId, input.asOf],
  );

  const positions: CustodianPosition[] = positionRows.map((r) => ({
    symbol: r.commodity,
    units: new Decimal(r.units).toFixed(6),
  }));

  if (anomalies.tamperPosition) {
    const { symbol, deltaUnits } = anomalies.tamperPosition;
    const existing = positions.find((p) => p.symbol === symbol);
    if (existing) {
      existing.units = new Decimal(existing.units).plus(deltaUnits).toFixed(6);
      injected.push(`position ${symbol} altered by ${deltaUnits} units`);
    } else {
      positions.push({ symbol, units: new Decimal(deltaUnits).toFixed(6) });
      injected.push(`phantom position ${symbol} of ${deltaUnits} units`);
    }
  }

  // --- cash ----------------------------------------------------------------
  const { rows: cashRows } = await client.query<{ cents: bigint }>(
    `SELECT coalesce(sum(l.amount_cents), 0)::bigint AS cents
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid
        AND l.account_code = 'assets:cash:settled'
        AND e.effective_at < ($2::date + 1)`,
    [input.customerId, input.asOf],
  );

  let settledCents = Number(cashRows[0]?.cents ?? 0n);
  if (anomalies.cashDelta) {
    settledCents += anomalies.cashDelta;
    injected.push(`cash altered by ${anomalies.cashDelta} cents`);
  }

  // --- transactions --------------------------------------------------------
  const transactions: CustodianTransaction[] = [];

  if (anomalies.lateDividend) {
    const { symbol, amountCents } = anomalies.lateDividend;
    transactions.push({
      type: 'dividend',
      symbol,
      amount_cents: amountCents,
      settled_on: input.asOf,
      reference: `DIV-${symbol}-${input.asOf}`,
      memo: `${symbol} cash distribution`,
    });
    // The custodian's cash includes the dividend it has already paid; ours does
    // not, because we have not heard about it. That is the whole point.
    settledCents += amountCents;
    injected.push(`late ${symbol} dividend of ${amountCents} cents`);
  }

  const { rows: accountRow } = await client.query<{ ref: string | null }>(
    `SELECT alpaca_account_id AS ref FROM customers WHERE id = $1::uuid`,
    [input.customerId],
  );

  return {
    as_of: input.asOf,
    account_ref: accountRow[0]?.ref ?? `SIM-${input.customerId.slice(0, 8)}`,
    customer_id: input.customerId,
    generated_at: new Date().toISOString(),
    positions,
    cash: { settled_cents: settledCents },
    transactions,
    _injected: injected,
  };
}

/** The scenario the debrief expects: one planted break plus benign noise. */
export function debriefAnomalies(symbol = 'VOO'): AnomalyOptions {
  return {
    tamperPosition: { symbol, deltaUnits: '-0.750000' },
    lateDividend: { symbol: 'BND', amountCents: 1_247 },
  };
}

export interface LedgerSnapshot {
  positions: Map<string, Decimal>;
  settledCents: Cents;
  /** Trades booked but not settled by as-of, which explain benign cash gaps. */
  unsettledTradeCents: Cents;
  pendingDepositCents: Cents;
}

/** Our own view, for the same date, to diff the file against. */
export async function ourSnapshot(
  client: PoolClient,
  customerId: string,
  asOf: MarketDate,
): Promise<LedgerSnapshot> {
  const { rows: positionRows } = await client.query<{
    commodity: string;
    units: string;
  }>(
    `SELECT l.commodity, sum(l.units) AS units
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid
        AND l.account_code = 'assets:positions'
        AND e.effective_at < ($2::date + 1)
      GROUP BY 1
     HAVING sum(l.units) <> 0`,
    [customerId, asOf],
  );

  const { rows: cashRows } = await client.query<{
    account_code: string;
    cents: bigint;
  }>(
    `SELECT l.account_code, sum(l.amount_cents)::bigint AS cents
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.customer_id = $1::uuid
        AND l.commodity = 'USD'
        AND l.account_code IN ('assets:cash:settled',
                               'assets:cash:unsettled_proceeds',
                               'assets:cash:pending_deposit',
                               'liabilities:trade_payable')
        AND e.effective_at < ($2::date + 1)
      GROUP BY 1`,
    [customerId, asOf],
  );

  const get = (code: string) =>
    cashRows.find((r) => r.account_code === code)?.cents ?? 0n;

  return {
    positions: new Map(positionRows.map((r) => [r.commodity, new Decimal(r.units)])),
    settledCents: get('assets:cash:settled'),
    // A payable is money we owe for a trade that has not settled; the custodian
    // will not have moved it yet either, so it explains a cash difference.
    unsettledTradeCents: get('liabilities:trade_payable') + get('assets:cash:unsettled_proceeds'),
    pendingDepositCents: get('assets:cash:pending_deposit'),
  };
}
