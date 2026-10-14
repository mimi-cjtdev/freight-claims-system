-- Carrier scorecard
-- One row per carrier:
--   claims         total claims against the carrier
--   per_100_loads  claims per 100 loads hauled, so big and small carriers compare fairly
--   recovery       recovered / claimed, decided claims only
--   ack_over_30    share of acknowledged claims where the carrier took over 30 days
--                  (49 CFR Part 370 requires acknowledgment within 30)
--   response_days  median days for the carrier to pay, decline or settle
-- The dashboard flags per_100_loads above 4 and ack_over_30 above 20% in red.

WITH loads AS (
    SELECT carrier, SUM(loads) AS loads
    FROM carrier_monthly_loads
    GROUP BY carrier
),
response_ranked AS (
    SELECT
        carrier,
        carrier_response_days,
        ROW_NUMBER() OVER (PARTITION BY carrier ORDER BY carrier_response_days) AS rn,
        COUNT(*)     OVER (PARTITION BY carrier)                                AS n
    FROM claims
    WHERE carrier_response_days IS NOT NULL
),
response_median AS (
    SELECT carrier, AVG(carrier_response_days) AS response_days
    FROM response_ranked
    WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
    GROUP BY carrier
)
SELECT
    c.carrier,
    COUNT(*)                                       AS claims,
    ROUND(COUNT(*) * 100.0 / l.loads, 1)           AS per_100_loads,
    SUM(CASE WHEN c.decision IS NOT NULL THEN c.final_recovered END)
      / SUM(CASE WHEN c.decision IS NOT NULL THEN c.claimed_amount END)
                                                   AS recovery,
    AVG(CASE WHEN c.carrier_ack_days IS NOT NULL
             THEN c.carrier_ack_days > 30 END)     AS ack_over_30,
    m.response_days
FROM claims AS c
JOIN loads           AS l ON l.carrier = c.carrier
JOIN response_median AS m ON m.carrier = c.carrier
GROUP BY c.carrier
ORDER BY per_100_loads DESC;
