-- Exception types
-- Volume, value and outcome for each exception type, in one pass using conditional
-- aggregation. Declined and recovery rates use decided claims only.
-- Finding: Delay claims are declined 67% of the time, since carriers rarely owe for
-- lateness alone.

SELECT
    exception_type,
    COUNT(*)            AS claims,
    SUM(claimed_amount) AS claimed,
    AVG(CASE WHEN decision IS NOT NULL THEN decision = 'Declined' END) AS declined,
    SUM(CASE WHEN decision IS NOT NULL THEN final_recovered END)
      / SUM(CASE WHEN decision IS NOT NULL THEN claimed_amount END)  AS recovery
FROM claims
GROUP BY exception_type
ORDER BY claims DESC;
