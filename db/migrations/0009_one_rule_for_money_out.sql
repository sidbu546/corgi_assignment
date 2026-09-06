-- One rule for money-out: the maker raises it, a DIFFERENT person approves it,
-- and that same different person executes it.
--
-- 0008 made the threshold conditional so that a human could decide their own
-- request at or under $1,000. That was a faithful reading of the page copy, but
-- it produced a queue with two kinds of card that behave differently for no
-- reason a reviewer can see, and it let the maker execute their own money-out.
-- The simpler rule is also the stronger one, so the branch is removed rather
-- than kept and explained.
--
--   maker      raises the request. Human or agent, any amount.
--   checker    a DIFFERENT person approves it, and executes it.
--   agent      may raise, may never decide or execute.
--
-- The threshold survives as the policy statement — money-out above it requires
-- approval — and this build routes EVERY money-out through the queue, so the
-- control applies to all of it. That is stricter than the stated threshold and
-- the page now says so, rather than implying a lower band that behaves
-- differently.

-- Four rows were self-approved while 0008 was in force. None was executed, so
-- no journal entry depends on any of them and nothing about money changes here.
-- They are returned to pending, because the decision that approved them was
-- made under a rule that no longer exists and cannot stand under this one.
UPDATE approvals
   SET status = 'pending', decided_by = NULL, decided_at = NULL,
       decision_note = COALESCE(decision_note, '') ||
         ' [returned to pending by 0009: self-approved under the withdrawn ' ||
         'sub-threshold rule; never executed, so no money was affected]'
 WHERE decided_by = requested_by
   AND executed_entry_id IS NULL;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_no_self_approval;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_no_self_approval
  CHECK (decided_by IS NULL OR decided_by <> requested_by);

-- The maker may not execute either. Approving and executing are two acts, but
-- both belong to the checker, and neither belongs to whoever asked for the
-- money. Without this the maker could not approve their own withdrawal but
-- could still press "execute" on it once somebody else had approved.
--
-- Who executed was never recorded on the row at all — only the journal entry's
-- created_by held it — so there was nothing for a constraint to check. It is
-- recorded now, which also means the queue can show it.
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS executed_by text;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_no_self_execution;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_no_self_execution
  CHECK (executed_by IS NULL OR executed_by <> requested_by);
