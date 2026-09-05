-- =============================================================================
-- 0003_domain.sql — the domain around the ledger.
--
-- Rule applied throughout: anything that is a FACT WE LEARNED is append-only
-- and carries (effective_at, recorded_at). Anything that is merely CURRENT
-- STATE is derived from those facts, not stored as a second truth.
--
-- That is why there is no `orders.status` column, no `positions` table, and no
-- `customers.balance`. Status is the latest order_event; positions are a fold
-- over journal_lines; balances are a fold over journal_lines. A projection that
-- can drift from the ledger is a bug waiting for an audit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- People
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('customer', 'ops');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name   text NOT NULL,
  email        text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  display_name  text NOT NULL,
  -- ops users have no customer_id; customer users must have one
  customer_id   uuid REFERENCES customers (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_customer_role_consistent
    CHECK ((role = 'customer') = (customer_id IS NOT NULL))
);

-- KYC as an append-only event stream. The brief demands pending and rejected,
-- not just approved, so the *history* of states is the interesting artefact —
-- current status is the latest row, never an overwritten column.
DO $$ BEGIN
  CREATE TYPE kyc_status AS ENUM ('not_started', 'pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS kyc_events (
  id           bigserial PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers (id),
  status       kyc_status NOT NULL,
  provider     text NOT NULL,
  provider_ref text,
  reason       text,
  raw          jsonb,
  effective_at timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_events_customer_idx ON kyc_events (customer_id, recorded_at DESC);

-- -----------------------------------------------------------------------------
-- Instruments and prices
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instruments (
  symbol      text PRIMARY KEY,
  name        text NOT NULL,
  asset_class text NOT NULL CHECK (asset_class IN ('equity', 'bond', 'cash')),
  is_active   boolean NOT NULL DEFAULT true
);

-- Prices are append-only and SUPERSEDED, never updated. A corrected close for
-- a past date inserts a NEW row for the same (symbol, price_date) with a later
-- recorded_at. That single decision is what makes restatement possible:
--
--   as-published on date T  ->  latest row WHERE recorded_at <= T
--   as-corrected now        ->  latest row, full stop
--
CREATE TABLE IF NOT EXISTS prices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        text NOT NULL REFERENCES instruments (symbol),
  price_date    date NOT NULL,
  -- Price per unit expressed in cents, exact decimal to 6dp. A price is a RATE,
  -- not an amount of money, so it is allowed sub-cent precision. Amounts derived
  -- from it are rounded to integer cents at the point of booking.
  price_cents   numeric(20, 6) NOT NULL CHECK (price_cents > 0),
  source        text NOT NULL,
  is_correction boolean NOT NULL DEFAULT false,
  supersedes_id uuid REFERENCES prices (id),
  note          text,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prices_lookup_idx ON prices (symbol, price_date, recorded_at DESC);

DROP TRIGGER IF EXISTS prices_append_only ON prices;
CREATE TRIGGER prices_append_only
  BEFORE UPDATE OR DELETE ON prices
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Corporate actions. Dividends carry three dates because the money arrives
-- days after the entitlement is earned; splits carry a ratio and must move
-- units and basis without moving value or return.
DO $$ BEGIN
  CREATE TYPE corporate_action_kind AS ENUM ('cash_dividend', 'split');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS corporate_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              corporate_action_kind NOT NULL,
  symbol            text NOT NULL REFERENCES instruments (symbol),
  declared_date     date,
  ex_date           date NOT NULL,
  pay_date          date,
  -- cash_dividend: cents per unit, exact to 6dp
  amount_per_unit   numeric(20, 6),
  -- split: 2-for-1 is numerator 2, denominator 1
  split_numerator   integer,
  split_denominator integer,
  source            text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corporate_actions_shape CHECK (
    (kind = 'cash_dividend' AND amount_per_unit IS NOT NULL AND pay_date IS NOT NULL)
    OR
    (kind = 'split' AND split_numerator > 0 AND split_denominator > 0)
  )
);

DROP TRIGGER IF EXISTS corporate_actions_append_only ON corporate_actions;
CREATE TRIGGER corporate_actions_append_only
  BEFORE UPDATE OR DELETE ON corporate_actions
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- -----------------------------------------------------------------------------
-- Model portfolios, versioned. When the model changes, existing customers do
-- not silently jump to it: they drift against the version they were bought
-- into until a rebalance moves them.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_portfolios (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL,
  risk_rank   integer NOT NULL
);

CREATE TABLE IF NOT EXISTS model_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id     text NOT NULL REFERENCES model_portfolios (id),
  version      integer NOT NULL,
  effective_at timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);

CREATE TABLE IF NOT EXISTS model_weights (
  model_version_id uuid NOT NULL REFERENCES model_versions (id),
  symbol           text NOT NULL REFERENCES instruments (symbol),
  -- basis points so weights are integers and sum to exactly 10000
  weight_bps       integer NOT NULL CHECK (weight_bps >= 0 AND weight_bps <= 10000),
  PRIMARY KEY (model_version_id, symbol)
);

CREATE TABLE IF NOT EXISTS customer_mandates (
  id               bigserial PRIMARY KEY,
  customer_id      uuid NOT NULL REFERENCES customers (id),
  model_version_id uuid NOT NULL REFERENCES model_versions (id),
  effective_at     timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Orders. Immutable submission facts here; every lifecycle transition is an
-- append-only event. Current status = latest event. A replayed fill webhook
-- collides on (broker_event_id) and is a no-op, so positions cannot double.
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE order_side AS ENUM ('buy', 'sell');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers (id),
  symbol           text NOT NULL REFERENCES instruments (symbol),
  side             order_side NOT NULL,
  -- exactly one of these: notional orders are how fractional investing works
  requested_units  numeric(28, 6),
  requested_cents  bigint,
  -- idempotency key we send to the broker so a retry cannot double-submit
  client_order_id  text NOT NULL UNIQUE,
  broker_order_id  text UNIQUE,
  rebalance_id     uuid,
  submitted_by     text NOT NULL,
  effective_at     timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_units_xor_notional
    CHECK ((requested_units IS NOT NULL) <> (requested_cents IS NOT NULL))
);

DO $$ BEGIN
  CREATE TYPE order_event_kind AS ENUM
    ('submitted', 'accepted', 'partial_fill', 'fill', 'canceled', 'rejected', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS order_events (
  id              bigserial PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders (id),
  kind            order_event_kind NOT NULL,
  -- fill legs only
  fill_units      numeric(28, 6),
  fill_price_cents numeric(20, 6),
  fee_cents       bigint NOT NULL DEFAULT 0,
  -- the broker's own event id: the dedupe key that makes replay a no-op
  broker_event_id text UNIQUE,
  entry_id        uuid REFERENCES journal_entries (id),
  raw             jsonb,
  effective_at    timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, recorded_at);

DROP TRIGGER IF EXISTS order_events_append_only ON order_events;
CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- -----------------------------------------------------------------------------
-- Tax lots, append-only in both directions.
--
-- A lot is never mutated as it is consumed. Remaining units on a lot =
-- opened units - SUM(consumptions). FIFO picks the oldest lot with remaining
-- units. Realised gain is recorded on the consumption, and the same number is
-- what the ledger books to income:realized_gain — computed once, asserted equal.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tax_lots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers (id),
  symbol       text NOT NULL REFERENCES instruments (symbol),
  units        numeric(28, 6) NOT NULL CHECK (units > 0),
  -- total cost of the lot in cents, commissions capitalised in
  cost_cents   bigint NOT NULL CHECK (cost_cents >= 0),
  -- trade date, which is what starts the holding-period clock, not settle date
  acquired_at  timestamptz NOT NULL,
  order_id     uuid REFERENCES orders (id),
  entry_id     uuid NOT NULL REFERENCES journal_entries (id),
  -- splits do not mutate a lot: they close it and open a replacement
  replaces_lot_id uuid REFERENCES tax_lots (id),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tax_lots_fifo_idx ON tax_lots (customer_id, symbol, acquired_at);

CREATE TABLE IF NOT EXISTS tax_lot_consumptions (
  id                  bigserial PRIMARY KEY,
  lot_id              uuid NOT NULL REFERENCES tax_lots (id),
  units               numeric(28, 6) NOT NULL CHECK (units > 0),
  cost_cents          bigint NOT NULL,
  proceeds_cents      bigint NOT NULL,
  realized_gain_cents bigint NOT NULL,
  order_id            uuid REFERENCES orders (id),
  entry_id            uuid NOT NULL REFERENCES journal_entries (id),
  disposed_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tax_lot_consumptions_lot_idx ON tax_lot_consumptions (lot_id);

DROP TRIGGER IF EXISTS tax_lots_append_only ON tax_lots;
CREATE TRIGGER tax_lots_append_only
  BEFORE UPDATE OR DELETE ON tax_lots
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

DROP TRIGGER IF EXISTS tax_lot_consumptions_append_only ON tax_lot_consumptions;
CREATE TRIGGER tax_lot_consumptions_append_only
  BEFORE UPDATE OR DELETE ON tax_lot_consumptions
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- A lot can never be consumed beyond what it holds. Deferred so a multi-lot
-- FIFO sell can insert all its consumptions before the check runs.
CREATE OR REPLACE FUNCTION assert_lot_not_oversold() RETURNS trigger AS $$
DECLARE
  opened   numeric(28, 6);
  consumed numeric(28, 6);
BEGIN
  SELECT units INTO opened FROM tax_lots WHERE id = NEW.lot_id;
  SELECT COALESCE(sum(units), 0) INTO consumed
    FROM tax_lot_consumptions WHERE lot_id = NEW.lot_id;

  IF consumed > opened THEN
    RAISE EXCEPTION
      'tax lot % oversold: opened %, consumed %', NEW.lot_id, opened, consumed;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tax_lot_consumptions_not_oversold ON tax_lot_consumptions;
CREATE CONSTRAINT TRIGGER tax_lot_consumptions_not_oversold
  AFTER INSERT ON tax_lot_consumptions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_lot_not_oversold();

-- -----------------------------------------------------------------------------
-- Cash transfers (ACH in and out), with the bounce as a first-class event.
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE transfer_direction AS ENUM ('deposit', 'withdrawal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS bank_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers (id),
  provider      text NOT NULL,
  provider_ref  text NOT NULL,
  institution   text NOT NULL,
  account_mask  text NOT NULL,
  account_name  text NOT NULL,
  -- verified against the identity on file, so we do not fund from someone
  -- else's account
  name_match    boolean,
  is_active     boolean NOT NULL DEFAULT true,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_transfers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid NOT NULL REFERENCES customers (id),
  bank_link_id   uuid REFERENCES bank_links (id),
  direction      transfer_direction NOT NULL,
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  rail           text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  provider_ref   text,
  initiated_by   text NOT NULL,
  effective_at   timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE transfer_event_kind AS ENUM
    ('initiated', 'pending', 'settled', 'returned', 'canceled', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cash_transfer_events (
  id                bigserial PRIMARY KEY,
  transfer_id       uuid NOT NULL REFERENCES cash_transfers (id),
  kind              transfer_event_kind NOT NULL,
  -- ACH return codes: R01 insufficient funds, R03 no account, etc.
  return_code       text,
  provider_event_id text UNIQUE,
  entry_id          uuid REFERENCES journal_entries (id),
  raw               jsonb,
  effective_at      timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_transfer_events_transfer_idx
  ON cash_transfer_events (transfer_id, recorded_at);

DROP TRIGGER IF EXISTS cash_transfer_events_append_only ON cash_transfer_events;
CREATE TRIGGER cash_transfer_events_append_only
  BEFORE UPDATE OR DELETE ON cash_transfer_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- -----------------------------------------------------------------------------
-- The webhook inbox. Every inbound event, whether we could process it or not,
-- with its signature verdict and delivery count. This is both the idempotency
-- mechanism and the screen we open when someone replays an event at us.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  -- the provider's own event id. UNIQUE is the whole idempotency story:
  -- the second delivery of the same event loses the race and is recorded as a
  -- duplicate rather than processed again. Twice is one.
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  signature_valid   boolean NOT NULL,
  signature_detail  text,
  payload           jsonb NOT NULL,
  headers           jsonb,
  outcome           text NOT NULL,
  outcome_detail    text,
  entry_id          uuid REFERENCES journal_entries (id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_recent_idx
  ON webhook_deliveries (received_at DESC);

-- Repeat deliveries of an event we have already accepted are logged here, so
-- "we received it 4 times and acted once" is demonstrable rather than asserted.
CREATE TABLE IF NOT EXISTS webhook_duplicate_deliveries (
  id           bigserial PRIMARY KEY,
  delivery_id  uuid NOT NULL REFERENCES webhook_deliveries (id),
  received_at  timestamptz NOT NULL DEFAULT now(),
  headers      jsonb
);
CREATE INDEX IF NOT EXISTS webhook_duplicate_idx
  ON webhook_duplicate_deliveries (delivery_id);

-- -----------------------------------------------------------------------------
-- Maker-checker. The initiator can never be the approver, and an agent can
-- never be either half of the approval — only the proposer.
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'executed', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type    text NOT NULL,
  payload        jsonb NOT NULL,
  amount_cents   bigint,
  customer_id    uuid REFERENCES customers (id),
  requested_by   text NOT NULL,
  -- 'human' or 'agent'. An agent may propose; it may never decide.
  requested_by_kind text NOT NULL CHECK (requested_by_kind IN ('human', 'agent')),
  status         approval_status NOT NULL DEFAULT 'pending',
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text,
  executed_entry_id uuid REFERENCES journal_entries (id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_no_self_approval
    CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status, requested_at DESC);

-- -----------------------------------------------------------------------------
-- Valuation and returns.
--
-- A valuation run is a SNAPSHOT of what we believed on a given as-of date at a
-- given moment. Restating a day does not edit the old run: it inserts a new run
-- for the same as_of_date with a later recorded_at, and the old one stays
-- queryable forever. published_returns records what we actually showed the
-- customer, which is the number a regulator will ask about.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS valuation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date    date NOT NULL,
  trigger       text NOT NULL,
  note          text,
  supersedes_id uuid REFERENCES valuation_runs (id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS valuation_runs_lookup_idx
  ON valuation_runs (as_of_date, recorded_at DESC);

CREATE TABLE IF NOT EXISTS valuation_positions (
  id              bigserial PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES valuation_runs (id),
  customer_id     uuid NOT NULL REFERENCES customers (id),
  symbol          text NOT NULL REFERENCES instruments (symbol),
  units           numeric(28, 6) NOT NULL,
  price_id        uuid NOT NULL REFERENCES prices (id),
  price_cents     numeric(20, 6) NOT NULL,
  -- units x price, rounded half-up to the cent at the moment of valuation
  market_value_cents bigint NOT NULL,
  cost_cents      bigint NOT NULL,
  -- how stale the price was when we used it, in calendar days. Surfaced in the
  -- UI rather than hidden: a valuation on a stale price is still a valuation,
  -- but the customer deserves to know.
  price_age_days  integer NOT NULL
);
CREATE INDEX IF NOT EXISTS valuation_positions_run_idx
  ON valuation_positions (run_id, customer_id);

CREATE TABLE IF NOT EXISTS valuation_totals (
  run_id             uuid NOT NULL REFERENCES valuation_runs (id),
  customer_id        uuid NOT NULL REFERENCES customers (id),
  settled_cash_cents bigint NOT NULL,
  unsettled_cash_cents bigint NOT NULL,
  pending_cash_cents bigint NOT NULL,
  positions_value_cents bigint NOT NULL,
  total_value_cents  bigint NOT NULL,
  cost_basis_cents   bigint NOT NULL,
  PRIMARY KEY (run_id, customer_id)
);

-- Time-weighted return, stored per sub-period. A sub-period is bounded by every
-- external cash flow, which is exactly how flows are prevented from polluting
-- performance.
CREATE TABLE IF NOT EXISTS return_subperiods (
  id                 bigserial PRIMARY KEY,
  customer_id        uuid NOT NULL REFERENCES customers (id),
  run_id             uuid NOT NULL REFERENCES valuation_runs (id),
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  begin_value_cents  bigint NOT NULL,
  external_flow_cents bigint NOT NULL,
  end_value_cents    bigint NOT NULL,
  -- (end - begin - flow) / (begin + flow), as exact decimal
  subperiod_return   numeric(20, 12) NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS return_subperiods_lookup_idx
  ON return_subperiods (customer_id, period_end, recorded_at DESC);

-- What we actually told the customer, and when. Never superseded in place: a
-- restatement inserts a new row for the same period, and the original stays.
CREATE TABLE IF NOT EXISTS published_returns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid NOT NULL REFERENCES customers (id),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  twr            numeric(20, 12) NOT NULL,
  end_value_cents bigint NOT NULL,
  run_id         uuid NOT NULL REFERENCES valuation_runs (id),
  restates_id    uuid REFERENCES published_returns (id),
  restatement_reason text,
  published_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS published_returns_lookup_idx
  ON published_returns (customer_id, period_end, published_at DESC);

DROP TRIGGER IF EXISTS published_returns_append_only ON published_returns;
CREATE TRIGGER published_returns_append_only
  BEFORE UPDATE OR DELETE ON published_returns
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- -----------------------------------------------------------------------------
-- Reconciliation. Breaks are aged and classified, because an ops team needs to
-- know which breaks are just T+1 timing and which are real.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recon_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date    date NOT NULL,
  source        text NOT NULL,
  file_ref      text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  positions_checked integer NOT NULL DEFAULT 0,
  breaks_found  integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recon_breaks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES recon_runs (id),
  customer_id    uuid REFERENCES customers (id),
  break_type     text NOT NULL,
  -- classification is the difference between a diff tool and an ops product
  classification text NOT NULL,
  symbol         text,
  ours_units     numeric(28, 6),
  theirs_units   numeric(28, 6),
  ours_cents     bigint,
  theirs_cents   bigint,
  -- when this break was first seen, so the screen can age it
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  expected_clear_date date,
  detail         text NOT NULL,
  resolved_at    timestamptz,
  resolution     text
);
CREATE INDEX IF NOT EXISTS recon_breaks_run_idx ON recon_breaks (run_id);
CREATE INDEX IF NOT EXISTS recon_breaks_open_idx ON recon_breaks (resolved_at, first_seen_at);
