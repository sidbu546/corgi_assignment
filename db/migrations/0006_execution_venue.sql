-- =============================================================================
-- 0006_execution_venue.sql
--
-- Two real Alpaca sandboxes, two account models, and the difference recorded
-- on every order rather than inferred.
--
--   'broker'  Broker API. A brokerage account per customer, in their own name.
--             The correct model. Funded by ACH, which settles on trading days.
--
--   'paper'   Trading API paper. ONE account, pre-funded, shared by every
--             customer routed to it — an OMNIBUS arrangement. The broker cannot
--             tell our customers apart; the segregation exists only in our
--             ledger.
--
-- Recording the venue per ORDER rather than only per customer is deliberate: a
-- customer can be moved between venues, and an order placed last week must
-- still say where it actually went. Reconciliation depends on that, because you
-- cannot reconcile against a venue without knowing which venue you traded on.
--
-- The omnibus case is also exactly why reconciliation matters more, not less:
-- when the broker holds one pooled account, OUR ledger is the only record of
-- who owns what.
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE execution_venue AS ENUM ('broker', 'paper');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which venue a customer's orders are routed to. Reference data, not a money
-- row, so it is mutable and carries no append-only trigger.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS execution_venue execution_venue NOT NULL DEFAULT 'broker';

-- Which venue actually executed this order. Written once, at submission.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS venue execution_venue NOT NULL DEFAULT 'broker',
  ADD COLUMN IF NOT EXISTS venue_account_ref text;

CREATE INDEX IF NOT EXISTS orders_venue_idx ON orders (venue, effective_at DESC);

COMMENT ON COLUMN orders.venue IS
  'Where this order was actually executed. Never inferred from the customer''s '
  'current setting, because that can change after the fact.';

COMMENT ON COLUMN orders.venue_account_ref IS
  'The account number at that venue. For the paper venue this is the SHARED '
  'omnibus account, which is why our ledger is the only per-customer record.';
