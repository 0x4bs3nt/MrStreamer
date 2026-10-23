WITH source AS (
SELECT
    toString(uuid) AS event_uuid,
    distinct_id AS installation_id,
    timestamp AS observed_at,
    toString(properties.app_version) AS app_version,
    toString(properties.build_channel) AS build_channel,
    toString(properties.distribution) AS distribution,
    toString(properties.os) AS os,
    toString(properties.observation_kind) AS observation_kind,
    coalesce(toString(properties.previous_app_version), '') AS previous_app_version,
    coalesce(toString(properties.previous_build_channel), '') AS previous_build_channel
FROM events
WHERE event = 'app_version_observed'
  AND timestamp >= toDateTime('2026-10-12 00:00:00', 'UTC')
  AND timestamp < now() + INTERVAL 1 DAY
  AND properties.os IN ('windows', 'macos', 'linux')
  AND {filters}
), deduplicated AS (
    SELECT event_uuid,
        argMin(tuple(installation_id, observed_at, app_version, build_channel, distribution, os,
                     observation_kind, previous_app_version, previous_build_channel), observed_at) AS observation
    FROM source
    GROUP BY event_uuid
), first_arrivals AS (
    SELECT tupleElement(observation, 1) AS installation_id,
        tupleElement(observation, 3) AS app_version,
        argMin(observation, tuple(tupleElement(observation, 2), event_uuid)) AS first_observation
    FROM deduplicated
    GROUP BY installation_id, app_version
), classified AS (
    SELECT installation_id, app_version,
        tupleElement(first_observation, 2) AS first_observed_at,
        tupleElement(first_observation, 4) AS build_channel,
        tupleElement(first_observation, 5) AS distribution,
        tupleElement(first_observation, 6) AS os,
        tupleElement(first_observation, 7) AS observation_kind,
        tupleElement(first_observation, 8) AS previous_app_version,
        tupleElement(first_observation, 9) AS previous_build_channel,
        match(app_version, '^[0-9]+[.][0-9]+[.][0-9]+(-nightly[.][0-9]{8}[.][0-9]+)?$') AS version_known,
        match(previous_app_version, '^[0-9]+[.][0-9]+[.][0-9]+(-nightly[.][0-9]{8}[.][0-9]+)?$') AS previous_version_known,
        tuple(toIntOrZero(extract(app_version, '^([0-9]+)[.]')), toIntOrZero(extract(app_version, '^[0-9]+[.]([0-9]+)[.]')), toIntOrZero(extract(app_version, '^[0-9]+[.][0-9]+[.]([0-9]+)')), if(match(app_version, '-nightly[.]'), 0, 1), toIntOrZero(extract(app_version, '-nightly[.]([0-9]{8})[.]')), toIntOrZero(extract(app_version, '-nightly[.][0-9]{8}[.]([0-9]+)$'))) AS version_key,
        tuple(toIntOrZero(extract(previous_app_version, '^([0-9]+)[.]')), toIntOrZero(extract(previous_app_version, '^[0-9]+[.]([0-9]+)[.]')), toIntOrZero(extract(previous_app_version, '^[0-9]+[.][0-9]+[.]([0-9]+)')), if(match(previous_app_version, '-nightly[.]'), 0, 1), toIntOrZero(extract(previous_app_version, '-nightly[.]([0-9]{8})[.]')), toIntOrZero(extract(previous_app_version, '-nightly[.][0-9]{8}[.]([0-9]+)$'))) AS previous_version_key,
        multiIf(
            observation_kind = 'new_profile' AND version_known, 'new profile',
            observation_kind != 'transition' OR NOT version_known OR NOT previous_version_known
                OR build_channel = 'unknown' OR previous_build_channel IN ('', 'unknown'), 'unknown history',
            build_channel != previous_build_channel, 'channel transition',
            version_key > previous_version_key, 'known upgrade',
            version_key < previous_version_key, 'downgrade',
            'unknown history'
        ) AS arrival_category
    FROM first_arrivals
)
SELECT installation_id, app_version, first_observed_at, previous_app_version,
    previous_build_channel, build_channel, distribution, os
FROM classified
WHERE arrival_category = 'known upgrade'
  AND app_version = {variables.desktop_target_version}
  AND ({variables.desktop_build_channel} = 'all' OR build_channel = {variables.desktop_build_channel})
  AND ({variables.desktop_distribution} = 'all' OR distribution = {variables.desktop_distribution})
ORDER BY first_observed_at DESC, installation_id
LIMIT 100
