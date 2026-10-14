-- Recovery rate
-- Share of claimed dollars the carriers actually paid, including money won back in disputes.
-- Only decided claims count: open claims have no outcome yet, so including them would
-- understate recovery.
-- Result on the sample data: 75.0%

SELECT
    SUM(final_recovered) / SUM(claimed_amount) AS recovery_rate
FROM claims
WHERE decision IS NOT NULL;
