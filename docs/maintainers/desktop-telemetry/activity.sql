WITH toDate(formatDateTime(now(), '%Y-%m-%d', 'UTC')) AS utc_today
SELECT
    activity_day AS utc_activity_date,
    if(activity_day = utc_today, 'partial today', 'complete') AS period_status,
    if(addDays(activity_day, -6) < toDate('2026-10-12'), 'partial tracking history', 'available tracking history') AS wau_history,
    uniqExactIf(installation_id, active_that_day AND installation_id != '') AS dau,
    uniqExactIf(installation_id, installation_id != '') AS wau
FROM (
    SELECT
        addDays(toDate(properties.activity_date), offset) AS activity_day,
        distinct_id AS installation_id,
        offset = 0 AS active_that_day
    FROM events
    ARRAY JOIN range(7) AS offset
    WHERE event = 'app_active_day'
      AND timestamp >= toDateTime(concat(toString(addDays(utc_today, -36)), ' 00:00:00'), 'UTC')
      AND timestamp < toDateTime(concat(toString(addDays(utc_today, 1)), ' 00:00:00'), 'UTC')
      AND properties.os IN ('windows', 'macos', 'linux')
      AND ({variables.desktop_build_channel} = 'all' OR properties.build_channel = {variables.desktop_build_channel})
      AND ({variables.desktop_distribution} = 'all' OR properties.distribution = {variables.desktop_distribution})
      AND {filters}
    UNION ALL
    SELECT addDays(utc_today, -offset) AS activity_day, '' AS installation_id, false AS active_that_day
    FROM (SELECT arrayJoin(range(31)) AS offset)
)
WHERE activity_day >= addDays(utc_today, -30)
  AND activity_day <= utc_today
  AND activity_day >= toDate('2026-10-12')
GROUP BY activity_day
ORDER BY activity_day
LIMIT 31
