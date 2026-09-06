-- Nothing below the threshold goes through the queue at all.
--
-- The queue previously held a mixture: $150 and $250 requests alongside
-- $1,500 ones, all behaving identically, which made the threshold look
-- decorative — if a $150 request needs the same two people as a $1,500 one,
-- what is the threshold for?
--
-- The rule is now single and visible: money-out enters the approvals queue
-- ONLY above the threshold, and everything in the queue therefore needs a
-- maker and a checker. There is no second band to explain.
--
-- KEEP IN SYNC with APPROVAL_THRESHOLD_CENTS in src/lib/approvals.ts, the same
-- way 0008 did. An invariant probes this boundary from the TypeScript constant.
--
-- NOT VALID, deliberately. Executed approvals already exist for $150 and $250,
-- and each one has a journal entry behind it — real money that really moved
-- under the rule as it stood at the time. Validating against them would either
-- fail the migration or invite deleting settled history to make a constraint
-- pass, and a constraint is never worth rewriting the past for. New rows are
-- checked; the old ones stay exactly as they were recorded.

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_above_threshold;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_above_threshold
  CHECK (
    action_type <> 'withdrawal'
    OR amount_cents IS NULL
    OR amount_cents > 100000
  ) NOT VALID;
