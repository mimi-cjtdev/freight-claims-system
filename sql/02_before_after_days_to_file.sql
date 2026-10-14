-- Before vs. after automation: median days to file with the carrier
-- Automation went live on Apr 1, 2026 (after_automation = 1 from that date).
-- SQLite has no MEDIAN(), so each group is ranked with window functions and the
-- middle value is taken (the average of the two middle values when the count is even).
-- The medians for hours to pick up and days to resolve use the same pattern.
-- Result on the sample data: Before 16.9 days, After 3.6 days

WITH ranked AS (
    SELECT
        after_automation,
        days_to_file,
        ROW_NUMBER() OVER (PARTITION BY after_automation ORDER BY days_to_file) AS rn,
        COUNT(*)     OVER (PARTITION BY after_automation)                       AS n
    FROM claims
    WHERE days_to_file IS NOT NULL
)
SELECT
    CASE after_automation WHEN 0 THEN 'Before' ELSE 'After' END AS period,
    ROUND(AVG(days_to_file), 1)                                  AS median_days_to_file
FROM ranked
WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
GROUP BY after_automation
ORDER BY after_automation;
