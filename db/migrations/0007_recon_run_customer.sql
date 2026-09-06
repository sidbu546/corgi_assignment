-- A reconciliation run is per CUSTOMER, but recon_runs never recorded which
-- one. The only way to associate a run with a customer was through the breaks
-- it produced.
--
-- That works right up until a run produces no breaks, which is the outcome we
-- most want to be able to show. A clean run was invisible: it could not be
-- found as "the latest run for this customer", so the previous run's breaks
-- stayed on screen indefinitely and the board could never be cleared. Pressing
-- "run this morning's reconciliation" reported zero breaks in its response
-- while the table below it still showed two criticals.
--
-- A screen whose purpose is that a break must not be lost had acquired the
-- opposite defect: breaks that no longer exist could not go away.

ALTER TABLE recon_runs
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers (id);

-- Backfill from the breaks, which is exactly the inference the page used to
-- make. It is correct for every historical run that produced at least one
-- break; older clean runs stay null and are simply never the latest, which is
-- the honest outcome for a run whose subject was never recorded.
UPDATE recon_runs r
   SET customer_id = b.customer_id
  FROM (
        SELECT DISTINCT ON (run_id) run_id, customer_id
          FROM recon_breaks
         WHERE customer_id IS NOT NULL
         ORDER BY run_id, customer_id
       ) b
 WHERE b.run_id = r.id
   AND r.customer_id IS NULL;

CREATE INDEX IF NOT EXISTS recon_runs_customer_asof_idx
  ON recon_runs (customer_id, as_of_date, started_at DESC);
