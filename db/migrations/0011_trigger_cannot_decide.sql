-- Asking an agent to raise it does not make it somebody else's request.
--
-- The ops console now has one way to put money-out into the queue: type an
-- amount and the AGENT raises it. That is the right shape — an agent proposes,
-- a human decides — but it opens a hole if left there.
--
-- `requested_by` becomes 'agent:ops-console', so approvals_no_self_approval
-- sees two different identities and is satisfied. The human who typed the
-- amount could then approve and execute their own request, with an agent's
-- name on the row standing in for the second pair of eyes. Maker-checker would
-- be decorative, and worse, it would LOOK enforced.
--
-- So the console records who triggered the agent, and that person is barred
-- from deciding and from executing, exactly as if they had raised it directly.
-- In the database, not just in the route: the payload is JSONB and a CHECK
-- constraint can read it.
--
-- An agent proposal with no human behind it — from the MCP server, or from
-- agent-demo — has triggeredBy null, and any human may decide it. That is the
-- intended case and is unaffected.

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_trigger_cannot_decide;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_trigger_cannot_decide
  CHECK (
    decided_by IS NULL
    OR payload->>'triggeredBy' IS NULL
    OR decided_by <> payload->>'triggeredBy'
  );

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_trigger_cannot_execute;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_trigger_cannot_execute
  CHECK (
    executed_by IS NULL
    OR payload->>'triggeredBy' IS NULL
    OR executed_by <> payload->>'triggeredBy'
  );
