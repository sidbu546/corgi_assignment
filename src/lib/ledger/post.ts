/**
 * post.ts — the only way money is ever written.
 *
 * Every journal entry in this system goes through `postEntry`. There is no
 * other INSERT into journal_entries or journal_lines anywhere in the codebase,
 * which means every invariant below holds for every entry without exception.
 *
 * The validation here is deliberately redundant with the database constraints.
 * The database is the guarantee — it holds even if someone connects with psql.
 * These checks exist so that a developer gets a legible error at the call site
 * ("buy AAPL: USD legs do not sum to zero, off by $0.40") instead of a
 * constraint violation surfacing at COMMIT with no clue which entry caused it.
 */

import type { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { type Cents, type Units, formatCents, UNIT_DP } from '../money';

export const USD = 'USD' as const;

export interface LineOptions {
  customerId?: string | null;
  memo?: string;
  /**
   * Which instrument this USD line is ABOUT. Cost basis, realised gain and
   * dividend income are USD amounts that belong to a specific symbol.
   */
  symbol?: string;
}

/** A USD leg, in integer cents. Positive increases the account's balance. */
export interface UsdLine {
  account: string;
  customerId?: string | null;
  commodity: typeof USD;
  cents: Cents;
  memo?: string;
  relatedSymbol?: string | null;
}

/** An instrument leg, in units. Positive increases the position. */
export interface UnitLine {
  account: string;
  customerId?: string | null;
  commodity: string;
  units: Units;
  memo?: string;
}

export type EntryLine = UsdLine | UnitLine;

export function isUsdLine(line: EntryLine): line is UsdLine {
  return line.commodity === USD;
}

/** Build a USD leg. Sign convention: assets/expenses positive when they rise. */
export function usd(account: string, cents: Cents, opts: LineOptions = {}): UsdLine {
  return {
    account,
    commodity: USD,
    cents,
    customerId: opts.customerId ?? null,
    memo: opts.memo,
    relatedSymbol: opts.symbol ?? null,
  };
}

/** Build an instrument leg, denominated in units of `symbol`. */
export function shares(
  account: string,
  symbol: string,
  qty: Units,
  opts: Omit<LineOptions, 'symbol'> = {},
): UnitLine {
  if (symbol === USD) {
    throw new Error('USD is not an instrument; use usd() for cash legs');
  }
  return {
    account,
    commodity: symbol,
    units: qty,
    customerId: opts.customerId ?? null,
    memo: opts.memo,
  };
}

export interface PostEntryInput {
  /** Short machine-readable label: 'buy', 'sell', 'deposit.settled', ... */
  kind: string;
  /** When it economically happened. May be backdated; that is the point. */
  effectiveAt: Date;
  /** Where this came from: 'alpaca.webhook', 'ops.console', 'agent.mcp', ... */
  source: string;
  /** The provider's id, our order id, whatever makes this traceable. */
  sourceRef?: string | null;
  /** A sentence a human auditor can read. Required, deliberately. */
  narrative: string;
  /** The acting user or system identity. Required, deliberately. */
  createdBy: string;
  lines: EntryLine[];
  /** Set when this entry reverses another. Never set together with corrects. */
  reversesEntryId?: string | null;
  /** Set when this entry re-books a corrected version of another. */
  correctsEntryId?: string | null;
}

export interface PostedEntry {
  id: string;
  recordedAt: Date;
}

/**
 * Validate that an entry balances to zero, per commodity, before it is sent.
 *
 * Exported because the invariants page runs it over hypothetical entries to
 * demonstrate the rule, and the tests use it directly without a database.
 */
export function assertBalanced(lines: EntryLine[], context: string): void {
  if (lines.length < 2) {
    throw new Error(`${context}: an entry needs at least two legs, got ${lines.length}`);
  }

  const cents = new Map<string, Cents>();
  const qty = new Map<string, Decimal>();

  for (const line of lines) {
    if (isUsdLine(line)) {
      if (typeof line.cents !== 'bigint') {
        throw new Error(
          `${context}: USD leg on ${line.account} must be a bigint of cents, ` +
            `got ${typeof line.cents}. Money is never a float.`,
        );
      }
      cents.set(line.commodity, (cents.get(line.commodity) ?? 0n) + line.cents);
    } else {
      if (!Decimal.isDecimal(line.units)) {
        throw new Error(
          `${context}: instrument leg on ${line.account} must carry a Decimal of units`,
        );
      }
      qty.set(
        line.commodity,
        (qty.get(line.commodity) ?? new Decimal(0)).plus(line.units),
      );
    }
  }

  for (const [commodity, sum] of cents) {
    if (sum !== 0n) {
      throw new Error(
        `${context}: ${commodity} legs do not sum to zero, off by ${formatCents(sum)}`,
      );
    }
  }
  for (const [commodity, sum] of qty) {
    if (!sum.isZero()) {
      throw new Error(
        `${context}: ${commodity} units do not sum to zero, off by ${sum.toFixed(UNIT_DP)}`,
      );
    }
  }
}

/**
 * Write one balanced entry.
 *
 * MUST be called inside a transaction (see db.transaction). This is not a
 * style preference: the balance trigger is DEFERRED and fires at COMMIT, so in
 * autocommit each line inserts and commits on its own and the trigger sees a
 * one-legged entry. The failure is real but confusing — Postgres reports
 * "entry has 1 line(s)" rather than "you forgot a transaction". Every
 * production caller goes through db.transaction(); anything else must too.
 */
export async function postEntry(
  client: PoolClient,
  input: PostEntryInput,
): Promise<PostedEntry> {
  const context = `${input.kind} entry`;

  if (input.reversesEntryId && input.correctsEntryId) {
    throw new Error(
      `${context}: an entry may reverse or re-book, never both. A correction is ` +
        `two entries: a reversal, then a fresh booking at the right date.`,
    );
  }
  if (!input.narrative?.trim()) {
    throw new Error(`${context}: narrative is required — an auditor has to read this`);
  }
  if (!input.createdBy?.trim()) {
    throw new Error(`${context}: createdBy is required — every entry has an author`);
  }

  assertBalanced(input.lines, context);

  const { rows } = await client.query<{ id: string; recorded_at: Date }>(
    `INSERT INTO journal_entries
       (kind, effective_at, source, source_ref, narrative, created_by,
        reverses_entry_id, corrects_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, recorded_at`,
    [
      input.kind,
      input.effectiveAt,
      input.source,
      input.sourceRef ?? null,
      input.narrative,
      input.createdBy,
      input.reversesEntryId ?? null,
      input.correctsEntryId ?? null,
    ],
  );
  const entry = rows[0];

  for (const line of input.lines) {
    await client.query(
      `INSERT INTO journal_lines
         (entry_id, account_code, customer_id, commodity,
          amount_cents, units, related_symbol, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.id,
        line.account,
        line.customerId ?? null,
        line.commodity,
        isUsdLine(line) ? line.cents.toString() : null,
        isUsdLine(line) ? null : line.units.toFixed(UNIT_DP),
        isUsdLine(line) ? (line.relatedSymbol ?? null) : null,
        line.memo ?? null,
      ],
    );
  }

  return { id: entry.id, recordedAt: entry.recorded_at };
}

/**
 * Reverse an existing entry by posting its exact negation.
 *
 * This is half of the correction story. The other half is re-booking the
 * corrected figures at the right effective date, which the caller does as a
 * separate `postEntry` carrying `correctsEntryId`. Three rows tell the whole
 * story — original, reversal, re-book — and the original is never touched.
 *
 * The reversal is booked at the ORIGINAL entry's effective date, not today's.
 * Reversing at today's date would leave the original period overstated and the
 * current period understated, which is how a "correction" silently moves money
 * between reporting periods.
 */
export async function reverseEntry(
  client: PoolClient,
  entryId: string,
  opts: { reason: string; createdBy: string; source?: string },
): Promise<PostedEntry> {
  const { rows: originals } = await client.query<{
    id: string;
    kind: string;
    effective_at: Date;
    narrative: string;
    source_ref: string | null;
    reverses_entry_id: string | null;
  }>(
    `SELECT id, kind, effective_at, narrative, source_ref, reverses_entry_id
       FROM journal_entries WHERE id = $1`,
    [entryId],
  );
  const original = originals[0];
  if (!original) throw new Error(`cannot reverse ${entryId}: no such entry`);

  if (original.reverses_entry_id) {
    throw new Error(
      `cannot reverse ${entryId}: it is itself a reversal. Reversing a reversal ` +
        `to "undo" a correction hides the history; re-book instead.`,
    );
  }

  // Reversing twice would double the correction. The ledger would still
  // balance, which is exactly why this needs an explicit guard.
  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM journal_entries WHERE reverses_entry_id = $1`,
    [entryId],
  );
  if (existing.length > 0) {
    throw new Error(
      `cannot reverse ${entryId}: already reversed by ${existing[0].id}`,
    );
  }

  const { rows: lines } = await client.query<{
    account_code: string;
    customer_id: string | null;
    commodity: string;
    amount_cents: bigint | null;
    units: string | null;
    related_symbol: string | null;
    memo: string | null;
  }>(
    `SELECT account_code, customer_id, commodity, amount_cents, units,
            related_symbol, memo
       FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
    [entryId],
  );

  // The negation is mechanical and total: every leg, flipped, nothing dropped.
  // That is what makes a reversal provably a no-op against the original rather
  // than a hand-written "undo" that might miss a leg.
  const negated: EntryLine[] = lines.map((line) =>
    line.commodity === USD
      ? usd(line.account_code, -(line.amount_cents as bigint), {
          customerId: line.customer_id,
          symbol: line.related_symbol ?? undefined,
          memo: `reversal: ${line.memo ?? ''}`.trim(),
        })
      : shares(
          line.account_code,
          line.commodity,
          new Decimal(line.units as string).negated(),
          {
            customerId: line.customer_id,
            memo: `reversal: ${line.memo ?? ''}`.trim(),
          },
        ),
  );

  return postEntry(client, {
    kind: `${original.kind}.reversal`,
    // Booked at the original's effective date, on purpose. See doc comment.
    effectiveAt: original.effective_at,
    source: opts.source ?? 'correction',
    sourceRef: original.source_ref,
    narrative: `Reversal of ${original.kind}: ${opts.reason}`,
    createdBy: opts.createdBy,
    reversesEntryId: entryId,
    lines: negated,
  });
}
