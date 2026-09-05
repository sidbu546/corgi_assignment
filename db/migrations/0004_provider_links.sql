-- =============================================================================
-- 0004_provider_links.sql
--
-- Links from our customer to the identity a provider knows them by.
--
-- Kept as explicit columns on `customers` rather than a generic
-- (provider, external_id) join table: there are three providers, the
-- relationships are one-to-one, and a generic table would buy flexibility we do
-- not need at the cost of a join on every hot path. If a fourth provider
-- arrives with a many-to-one shape, that is the moment to generalise.
--
-- These are NOT money rows. They are mutable reference data — an Alpaca account
-- can legitimately be re-created — so no append-only trigger here. The
-- append-only guarantee is deliberately scoped to rows that represent money or
-- a statement about money, and widening it to everything would make the claim
-- mean less, not more.
-- =============================================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS alpaca_account_id  text,
  ADD COLUMN IF NOT EXISTS persona_inquiry_id text,
  ADD COLUMN IF NOT EXISTS plaid_item_id      text;

-- One Alpaca account maps to exactly one customer. If a fill arrives for an
-- account we have mapped twice, that is a data-integrity problem we want to
-- hear about from the database rather than discover in a reconciliation break.
CREATE UNIQUE INDEX IF NOT EXISTS customers_alpaca_account_uidx
  ON customers (alpaca_account_id) WHERE alpaca_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS customers_plaid_item_uidx
  ON customers (plaid_item_id) WHERE plaid_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS customers_persona_inquiry_idx
  ON customers (persona_inquiry_id) WHERE persona_inquiry_id IS NOT NULL;

-- The ACH relationship at the broker, so a deposit knows which rail it rode.
ALTER TABLE bank_links
  ADD COLUMN IF NOT EXISTS alpaca_relationship_id text;

-- Settlement scheduling.
--
-- `settlement_date` is written at INSERT time on the fill event, so the settler
-- is a query ("what is due today") rather than a recomputation of the market
-- calendar over every historical trade.
ALTER TABLE order_events
  ADD COLUMN IF NOT EXISTS settlement_date date;

-- Which fills have actually been settled lives in its OWN append-only table
-- rather than a nullable column on order_events.
--
-- Not a style preference: order_events carries a BEFORE UPDATE trigger that
-- raises, so a `settled_entry_id` column on it could never be filled in. The
-- append-only rule forces settlement to be a new fact rather than a mutation of
-- an old one — which is also the more truthful shape, because settling is
-- something that happens later, not something that was always true of the fill.
CREATE TABLE IF NOT EXISTS settlements (
  id             bigserial PRIMARY KEY,
  order_event_id bigint NOT NULL REFERENCES order_events (id),
  entry_id       uuid NOT NULL REFERENCES journal_entries (id),
  settled_on     date NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  -- A fill settles exactly once. The constraint, not the code, guarantees it,
  -- so a re-run of the settlement job is harmless.
  UNIQUE (order_event_id)
);

DROP TRIGGER IF EXISTS settlements_append_only ON settlements;
CREATE TRIGGER settlements_append_only
  BEFORE UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- "What is due to settle, and has not been?" — the settler's only query.
CREATE INDEX IF NOT EXISTS order_events_settlement_due_idx
  ON order_events (settlement_date)
  WHERE settlement_date IS NOT NULL;
