-- A corporate action can be withdrawn, and withdrawing it is itself an event.
--
-- corporate_actions is append-only, so a split announced in error cannot be
-- deleted and should not be: it was announced, holders saw it, and the record
-- of that is the point. The honest shape is the one the ledger already uses for
-- money — a reversing row that points at what it reverses, leaving both.
--
-- Without this, a split could be undone in the ledger (reverse the entry,
-- restore the price, replace the lots back) while the announcement stood, so
-- the one-split-per-symbol-per-day guard would keep refusing a symbol whose
-- split no longer exists anywhere else.

ALTER TABLE corporate_actions
  ADD COLUMN IF NOT EXISTS reverses_id uuid REFERENCES corporate_actions (id);

-- A reversal must point at something, and nothing may be reversed twice.
CREATE UNIQUE INDEX IF NOT EXISTS corporate_actions_one_reversal
  ON corporate_actions (reverses_id)
  WHERE reverses_id IS NOT NULL;
