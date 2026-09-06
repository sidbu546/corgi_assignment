-- Make the approval threshold a rule instead of a sentence.
--
-- The approvals page said "money-out above $1,000.00 needs a second pair of
-- eyes". APPROVAL_THRESHOLD_CENTS was referenced exactly once in the whole
-- codebase — to render that sentence. Nothing enforced it, and nothing relaxed
-- it either: EVERY withdrawal required a distinct approver regardless of size,
-- so the behaviour was stricter than advertised and the copy described a rule
-- that did not exist.
--
-- Stricter-than-advertised is a safe failure, but a stated control that is not
-- the implemented control is exactly the kind of thing that stops being safe
-- the moment somebody relies on the statement.
--
-- The threshold now lives in the CHECK constraint, so it holds even against a
-- direct psql session:
--
--   above $1,000.00      a DIFFERENT person must decide
--   $1,000.00 or under   the person who raised it may decide it, but only if a
--                        HUMAN raised it
--   raised by an agent   a different person must decide, at ANY amount. An
--                        agent may propose and never decide, and no threshold
--                        may erode that.
--   amount unknown       a different person must decide. A NULL amount cannot
--                        be shown to be under the threshold, so it is not
--                        treated as if it were.
--
-- KEEP IN SYNC with APPROVAL_THRESHOLD_CENTS in src/lib/approvals.ts. A CHECK
-- constraint cannot read application config, so the two are pinned together by
-- invariants that probe this exact boundary from the TypeScript constant: if
-- the constant moves and this migration does not, the invariant suite fails.

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_no_self_approval;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_no_self_approval
  CHECK (
    decided_by IS NULL
    OR decided_by <> requested_by
    OR (
         requested_by_kind = 'human'
     AND amount_cents IS NOT NULL
     AND amount_cents <= 100000
    )
  );
