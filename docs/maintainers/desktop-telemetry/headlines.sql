WITH toDate(formatDateTime(now(), '%Y-%m-%d', 'UTC')) AS utc_today
SELECT
    toString(addDays(utc_today, -1)) AS completed_utc_day,
    uniqExactIf(distinct_id, toDate(properties.activity_date) = addDays(utc_today, -1)) AS dau_completed_day,
    toString(addDays(utc_today, -7)) AS wau_first_utc_day,
    uniqExactIf(distinct_id, toDate(properties.activity_date) >= addDays(utc_today, -7) AND toDate(properties.activity_date) < utc_today) AS wau_seven_completed_days,
    toString(utc_today) AS partial_utc_day,
    uniqExactIf(distinct_id, toDate(properties.activity_date) = utc_today) AS dau_partial_today
FROM events
WHERE event = 'app_active_day'
  AND timestamp >= toDateTime(concat(toString(addDays(utc_today, -7)), ' 00:00:00'), 'UTC')
  AND timestamp < toDateTime(concat(toString(addDays(utc_today, 1)), ' 00:00:00'), 'UTC')
  AND properties.os IN ('windows', 'macos', 'linux')
  AND ({variables.desktop_build_channel} = 'all' OR properties.build_channel = {variables.desktop_build_channel})
  AND ({variables.desktop_distribution} = 'all' OR properties.distribution = {variables.desktop_distribution})
  AND {filters}
