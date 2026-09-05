/**
 * trades.ts — a fill becomes journal entries and tax lots, atomically.
 *
 * THE SHAPE OF A BUY (trade date):
 *
 *   assets:positions           +10.000000 AAPL   units in
 *   equity:external:market     -10.000000 AAPL   the market gave them up
 *   assets:positions:cost        +150,100 USD    basis, commission capitalised
 *   liabilities:trade_payable    -150,100 USD    we owe the custodian
 *
 *   AAPL: +10 - 10 = 0.  USD: +150100 - 150100 = 0.  Both dimensions balance.
 *
 * Note what does NOT happen on trade date: cash does not move. The customer
 * owes for the trade, and that debt is settled T+1:
 *
 *   liabilities:trade_payable    +150,100 USD
 *   assets:cash:settled          -150,100 USD
 *
 * THE SHAPE OF A SELL (trade date):
 *
 *   assets:positions            -5.000000 AAPL
 *   equity:external:market      +5.000000 AAPL
 *   assets:positions:cost         -75,050 USD    basis of the lots consumed
 *   assets:cash:unsettled_procee  +79,900 USD    proceeds, net of commission
 *   income:realized_gain           -4,850 USD    whatever makes it balance
 *
 * Realised gain is not computed twice. It is computed once by the lot engine,
 * and the ledger entry uses that number; if the two disagreed the entry would
 * not sum to zero and Postgres would refuse the COMMIT. The invariant is
 * enforced by arithmetic rather than by a reconciliation job.
 */

import type { PoolClient } from 'pg';
import {
  type Cents,
  type PriceCents,
  type Units,
  marketValueCents,
} from '../money';
import { postEntry, shares, usd } from './post';
import {
  loadLots,
  openLot,
  planDisposal,
  recordConsumptions,
  type DisposalPlan,
} from './lots';

export interface FillInput {
  customerId: string;
  symbol: string;
  units: Units;
  priceCents: PriceCents;
  /** Commission or SEC/TAF fee on this fill. Capitalised into basis on a buy. */
  feeCents?: Cents;
  /** Trade date. The holding-period clock starts here, not at settlement. */
  tradeDate: Date;
  orderId?: string | null;
  source: string;
  sourceRef?: string | null;
  createdBy: string;
}

export interface BuyResult {
  entryId: string;
  lotId: string;
  costCents: Cents;
}

/**
 * Book a buy fill: units in, basis recognised, payable raised, lot opened.
 *
 * Partial fills call this once per fill. Each partial fill opens its OWN tax
 * lot, because each executed at a different price and therefore has a different
 * basis and its own holding period. Collapsing partial fills into one lot at an
 * average price is a small lie that becomes a wrong 1099-B.
 */
export async function recordBuyFill(
  client: PoolClient,
  input: FillInput,
): Promise<BuyResult> {
  const fee = input.feeCents ?? 0n;
  const gross = marketValueCents(input.units, input.priceCents);
  // Commission capitalises into basis; it is not an expense. See DECISIONS.md.
  const costCents = gross + fee;

  const entry = await postEntry(client, {
    kind: 'trade.buy',
    effectiveAt: input.tradeDate,
    source: input.source,
    sourceRef: input.sourceRef,
    createdBy: input.createdBy,
    narrative:
      `Buy ${input.units.toString()} ${input.symbol} @ ` +
      `${input.priceCents.div(100).toFixed(4)} USD` +
      (fee > 0n ? ` plus ${fee} cents commission capitalised into basis` : ''),
    lines: [
      shares('assets:positions', input.symbol, input.units, {
        customerId: input.customerId,
      }),
      shares('equity:external:market', input.symbol, input.units.negated()),
      usd('assets:positions:cost', costCents, {
        customerId: input.customerId,
        symbol: input.symbol,
        memo: fee > 0n ? `gross ${gross} + fee ${fee}` : undefined,
      }),
      usd('liabilities:trade_payable', -costCents, {
        customerId: input.customerId,
        memo: `settles T+1 from trade date ${input.tradeDate.toISOString().slice(0, 10)}`,
      }),
    ],
  });

  const lotId = await openLot(client, {
    customerId: input.customerId,
    symbol: input.symbol,
    units: input.units,
    costCents,
    acquiredAt: input.tradeDate,
    orderId: input.orderId,
    entryId: entry.id,
  });

  return { entryId: entry.id, lotId, costCents };
}

export interface SellResult {
  entryId: string;
  plan: DisposalPlan;
  proceedsCents: Cents;
}

/**
 * Book a sell fill: units out, lots consumed FIFO, gain realised, proceeds
 * parked as unsettled until T+1.
 */
export async function recordSellFill(
  client: PoolClient,
  input: FillInput,
): Promise<SellResult> {
  const fee = input.feeCents ?? 0n;
  const gross = marketValueCents(input.units, input.priceCents);
  // On a sale the commission reduces proceeds, which reduces the realised gain.
  const proceedsCents = gross - fee;

  const lots = await loadLots(client, input.customerId, input.symbol);
  const plan = planDisposal(lots, input.units, proceedsCents, input.tradeDate);

  const entry = await postEntry(client, {
    kind: 'trade.sell',
    effectiveAt: input.tradeDate,
    source: input.source,
    sourceRef: input.sourceRef,
    createdBy: input.createdBy,
    narrative:
      `Sell ${input.units.toString()} ${input.symbol} @ ` +
      `${input.priceCents.div(100).toFixed(4)} USD; ` +
      `${plan.consumptions.length} lot(s) consumed FIFO, ` +
      `basis ${plan.totalCostCents} cents, ` +
      `realised ${plan.totalRealizedGainCents} cents`,
    lines: [
      shares('assets:positions', input.symbol, input.units.negated(), {
        customerId: input.customerId,
      }),
      shares('equity:external:market', input.symbol, input.units),
      usd('assets:positions:cost', -plan.totalCostCents, {
        customerId: input.customerId,
        symbol: input.symbol,
        memo: `basis of ${plan.consumptions.length} lot(s)`,
      }),
      usd('assets:cash:unsettled_proceeds', proceedsCents, {
        customerId: input.customerId,
        memo: fee > 0n ? `gross ${gross} less fee ${fee}` : undefined,
      }),
      // Sign: income increases negative. A gain credits income; a loss debits it.
      usd('income:realized_gain', -plan.totalRealizedGainCents, {
        customerId: input.customerId,
        symbol: input.symbol,
      }),
    ],
  });

  await recordConsumptions(client, plan, {
    orderId: input.orderId,
    entryId: entry.id,
    disposedAt: input.tradeDate,
  });

  return { entryId: entry.id, plan, proceedsCents };
}

/**
 * Settle a buy on T+1: the payable is discharged out of settled cash.
 *
 * This is a separate entry on a separate date on purpose. Collapsing trade and
 * settlement into one entry would make settled cash wrong for a day, which is
 * exactly the gap the customer sees when they try to withdraw.
 */
export async function settleBuy(
  client: PoolClient,
  input: {
    customerId: string;
    amountCents: Cents;
    settlementDate: Date;
    source: string;
    sourceRef?: string | null;
    createdBy: string;
  },
): Promise<string> {
  const entry = await postEntry(client, {
    kind: 'trade.buy.settled',
    effectiveAt: input.settlementDate,
    source: input.source,
    sourceRef: input.sourceRef,
    createdBy: input.createdBy,
    narrative: `Buy settlement: ${input.amountCents} cents paid from settled cash`,
    lines: [
      usd('liabilities:trade_payable', input.amountCents, {
        customerId: input.customerId,
      }),
      usd('assets:cash:settled', -input.amountCents, { customerId: input.customerId }),
    ],
  });
  return entry.id;
}

/**
 * Settle a sell on T+1: unsettled proceeds become settled, and therefore
 * withdrawable for the first time.
 */
export async function settleSell(
  client: PoolClient,
  input: {
    customerId: string;
    amountCents: Cents;
    settlementDate: Date;
    source: string;
    sourceRef?: string | null;
    createdBy: string;
  },
): Promise<string> {
  const entry = await postEntry(client, {
    kind: 'trade.sell.settled',
    effectiveAt: input.settlementDate,
    source: input.source,
    sourceRef: input.sourceRef,
    createdBy: input.createdBy,
    narrative:
      `Sell settlement: ${input.amountCents} cents of proceeds become settled ` +
      `and withdrawable`,
    lines: [
      usd('assets:cash:unsettled_proceeds', -input.amountCents, {
        customerId: input.customerId,
      }),
      usd('assets:cash:settled', input.amountCents, { customerId: input.customerId }),
    ],
  });
  return entry.id;
}
