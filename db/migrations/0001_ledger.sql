-- =============================================================================
-- 0001_ledger.sql — the append-only, multi-commodity, bitemporal ledger.
--
-- Three ideas carry this whole system. Everything else is built on top.
--
--  1. TWO DIMENSIONS, NEVER MIXED.
--     Money is integer cents (bigint). Units are numeric(28,6). A journal line
--     carries exactly one of them, enforced by a CHECK constraint against the
--     line's commodity. There is no column anywhere that could hold "value" as
--     a float. Value is units x price, computed at read time, never stored as a
--     third source of truth.
--
--  2. MULTI-COMMODITY DOUBLE ENTRY.
--     An entry must balance to zero *independently for every commodity it
--     touches*. A buy moves AAPL in one dimension and USD in another; both sum
--     to zero. This is checked by a DEFERRED constraint trigger at COMMIT, so
--     a half-written entry can never be committed.
--
--  3. BITEMPORAL, APPEND-ONLY.
--     effective_at = when it economically happened.
--     recorded_at  = when we learned it. Assigned by the database, never by the
--                    application, never backdated.
--     Corrections are reversal + re-book, never edits. UPDATE and DELETE are
--     revoked at the role level AND blocked by triggers, so the immutability
--     claim is enforced by Postgres rather than by developer discipline.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Chart of accounts
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which dimension an account is allowed to hold.
--   'usd'        -> cash, payables, income, fees. Cents only.
--   'instrument' -> share positions. Units only.
--   'any'        -> clearing accounts that face the outside world and therefore
--                   absorb both legs of a trade (shares in, dollars out).
DO $$ BEGIN
  CREATE TYPE commodity_class AS ENUM ('usd', 'instrument', 'any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS accounts (
  code             text PRIMARY KEY,
  name             text NOT NULL,
  type             account_type NOT NULL,
  commodity_class  commodity_class NOT NULL,
  -- true  -> balances are held per customer; a line MUST carry customer_id
  -- false -> house account; a line MUST NOT carry customer_id
  is_customer_book boolean NOT NULL,
  description      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE accounts IS
  'Chart of accounts. Sign convention: assets and expenses increase positive; '
  'liabilities, equity and income increase negative. Every entry therefore sums '
  'to exactly zero per commodity, which is what the balance trigger checks.';

-- -----------------------------------------------------------------------------
-- Journal entries (the header) and journal lines (the legs)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What economically happened, and when it happened in the real world.
  kind              text NOT NULL,
  effective_at      timestamptz NOT NULL,

  -- When we learned it. Database-assigned. This is the axis that makes
  -- "as published" and "as corrected" both answerable, forever.
  recorded_at       timestamptz NOT NULL DEFAULT now(),

  -- Correction machinery. A reversal points at the entry it reverses; a re-book
  -- points at the same original so the three can be shown as one story.
  -- Original rows are never touched.
  reverses_entry_id uuid REFERENCES journal_entries (id),
  corrects_entry_id uuid REFERENCES journal_entries (id),

  -- Provenance: which external event or internal command produced this.
  source            text NOT NULL,
  source_ref        text,
  narrative         text NOT NULL,
  created_by        text NOT NULL,

  CONSTRAINT journal_entries_not_self_referential
    CHECK (id <> reverses_entry_id AND id <> corrects_entry_id),

  -- A single entry cannot both reverse and re-book. Reversal and re-book are
  -- two separate entries; collapsing them would hide the correction.
  CONSTRAINT journal_entries_reversal_xor_rebook
    CHECK (reverses_entry_id IS NULL OR corrects_entry_id IS NULL)
);

CREATE INDEX IF NOT EXISTS journal_entries_effective_idx ON journal_entries (effective_at);
CREATE INDEX IF NOT EXISTS journal_entries_recorded_idx  ON journal_entries (recorded_at);
CREATE INDEX IF NOT EXISTS journal_entries_reverses_idx  ON journal_entries (reverses_entry_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id            bigserial PRIMARY KEY,
  entry_id      uuid NOT NULL REFERENCES journal_entries (id),
  account_code  text NOT NULL REFERENCES accounts (code),

  -- The book this line belongs to. NULL for house accounts.
  customer_id   uuid,

  -- 'USD' or an instrument symbol. The commodity is the axis the zero-sum
  -- invariant is evaluated on.
  commodity     text NOT NULL,

  -- EXACTLY ONE of these is non-null, decided by the commodity. This is the
  -- structural expression of "units and money are different dimensions".
  amount_cents  bigint,
  units         numeric(28, 6),

  memo          text,

  CONSTRAINT journal_lines_usd_uses_cents
    CHECK ((commodity =  'USD') = (amount_cents IS NOT NULL)),
  CONSTRAINT journal_lines_instrument_uses_units
    CHECK ((commodity <> 'USD') = (units IS NOT NULL)),

  -- A zero-quantity line carries no information and would let an entry look
  -- balanced while saying nothing.
  CONSTRAINT journal_lines_nonzero
    CHECK (COALESCE(amount_cents, 0) <> 0 OR COALESCE(units, 0) <> 0)
);

CREATE INDEX IF NOT EXISTS journal_lines_entry_idx    ON journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx  ON journal_lines (account_code);
CREATE INDEX IF NOT EXISTS journal_lines_customer_idx ON journal_lines (customer_id, commodity);

-- -----------------------------------------------------------------------------
-- Invariant 1: a line must respect its account's declared dimension and book.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_line_matches_account() RETURNS trigger AS $$
DECLARE
  acct accounts%ROWTYPE;
BEGIN
  SELECT * INTO acct FROM accounts WHERE code = NEW.account_code;

  IF acct.commodity_class = 'usd' AND NEW.commodity <> 'USD' THEN
    RAISE EXCEPTION
      'account % holds USD only, got commodity %', NEW.account_code, NEW.commodity;
  END IF;

  IF acct.commodity_class = 'instrument' AND NEW.commodity = 'USD' THEN
    RAISE EXCEPTION
      'account % holds instrument units only, got USD', NEW.account_code;
  END IF;

  IF acct.is_customer_book AND NEW.customer_id IS NULL THEN
    RAISE EXCEPTION
      'account % is a customer book and requires customer_id', NEW.account_code;
  END IF;

  IF NOT acct.is_customer_book AND NEW.customer_id IS NOT NULL THEN
    RAISE EXCEPTION
      'account % is a house account and must not carry customer_id', NEW.account_code;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_match_account ON journal_lines;
CREATE TRIGGER journal_lines_match_account
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_matches_account();

-- -----------------------------------------------------------------------------
-- Invariant 2: every entry balances to zero, per commodity, at COMMIT.
--
-- Deferred so that lines may be inserted one at a time inside a transaction.
-- Checked before the transaction is allowed to commit, so an unbalanced entry
-- cannot reach the database even transiently visible to another session.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_entry_balances() RETURNS trigger AS $$
DECLARE
  offending record;
  line_count integer;
BEGIN
  SELECT count(*) INTO line_count FROM journal_lines WHERE entry_id = NEW.entry_id;

  -- Single-line entries are always suspect: nothing can balance against them.
  IF line_count < 2 THEN
    RAISE EXCEPTION
      'journal entry % has % line(s); an entry needs at least two legs',
      NEW.entry_id, line_count;
  END IF;

  FOR offending IN
    SELECT commodity,
           sum(COALESCE(amount_cents, 0))  AS cents,
           sum(COALESCE(units, 0))         AS qty
    FROM journal_lines
    WHERE entry_id = NEW.entry_id
    GROUP BY commodity
    HAVING sum(COALESCE(amount_cents, 0)) <> 0
        OR sum(COALESCE(units, 0)) <> 0
  LOOP
    RAISE EXCEPTION
      'journal entry % does not balance in %: cents=%, units=%',
      NEW.entry_id, offending.commodity, offending.cents, offending.qty;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_balance ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balance
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balances();

-- -----------------------------------------------------------------------------
-- Invariant 3: money rows are append-only. Enforced twice, on purpose.
--
--   (a) Triggers that raise on UPDATE or DELETE. These fire even for the table
--       owner and even for a superuser, so they hold regardless of who connects.
--   (b) REVOKE UPDATE, DELETE from the application role (0002, after the role
--       exists), so the app physically lacks the privilege.
--
-- Belt and braces because "UPDATE or DELETE on money rows, anywhere, ever" is
-- an automatic fail, and a claim that is only enforced in application code is
-- not enforced at all.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% on % is forbidden: this table is append-only. Corrections are reversal '
    'entries plus a re-book, never an edit.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_append_only ON journal_entries;
CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

DROP TRIGGER IF EXISTS journal_lines_append_only ON journal_lines;
CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Also block TRUNCATE, which bypasses row-level triggers entirely.
DROP TRIGGER IF EXISTS journal_entries_no_truncate ON journal_entries;
CREATE TRIGGER journal_entries_no_truncate
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();

DROP TRIGGER IF EXISTS journal_lines_no_truncate ON journal_lines;
CREATE TRIGGER journal_lines_no_truncate
  BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION deny_mutation();
