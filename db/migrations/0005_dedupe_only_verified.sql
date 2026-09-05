-- =============================================================================
-- 0005_dedupe_only_verified.sql
--
-- FIXES A REAL VULNERABILITY, found by the replay test in scripts/replay-test.ts.
--
-- The bug: webhook_deliveries had UNIQUE (provider, provider_event_id) across
-- ALL rows, and the pipeline claimed that key BEFORE verifying the signature.
-- So anyone who could guess or observe an event id could POST an unsigned
-- garbage body, claim the key, and every subsequent genuine delivery of that
-- event would be recorded as a "duplicate" and never processed.
--
-- In other words: a forged, unauthenticated request could permanently suppress
-- a real fill. The event would look handled on every screen. The ledger would
-- simply never hear about the trade.
--
-- The fix has two halves:
--
--   1. HERE: the uniqueness that drives deduplication now applies only to
--      deliveries whose signature actually verified. An unverified delivery is
--      still recorded — we want to see attacks — but it cannot occupy the
--      dedupe namespace and cannot shadow a legitimate event.
--
--   2. IN inbox.ts: the signature is verified BEFORE the key is claimed, so an
--      invalid delivery never reaches the conflict path at all.
--
-- The lesson, worth stating because it generalises: an idempotency key is a
-- form of authority. Letting an unauthenticated caller write to that namespace
-- is the same class of mistake as letting them write to the ledger.
-- =============================================================================

ALTER TABLE webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_provider_provider_event_id_key;

-- Only verified deliveries deduplicate against one another.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_verified_uidx
  ON webhook_deliveries (provider, provider_event_id)
  WHERE signature_valid;

-- Rejected and unverifiable deliveries are still queryable by event id, so an
-- operator can ask "did someone try to forge this event?" without a table scan.
CREATE INDEX IF NOT EXISTS webhook_deliveries_event_lookup_idx
  ON webhook_deliveries (provider, provider_event_id);
