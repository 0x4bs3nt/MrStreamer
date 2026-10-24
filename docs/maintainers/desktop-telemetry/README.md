# Desktop installation reports

The reviewed PostHog definition change for desktop 0.0.19 was applied on
23 October 2026 with Wout's approval. The release's project card holds approval,
validation and remaining rollout checks. `changes.json` retains the original
preconditions and rollback alongside the applied IDs. Existing playback reports and the project's Europe/Brussels
timezone remain unchanged.

`changes.json` retains the tool inputs, original definitions for rollback and
the concurrent-edit preconditions used for this application. Before any further
application or rollback, read the current definitions and refresh the relevant
preconditions. Record returned IDs in the application receipt and preserve
unrelated dashboard content.

## Definitions

- Observed new profiles count distinct desktop installation UUIDs with
  `installation_observed` and `profile_origin: fresh`. All-time means since
  tracking began, not every installer ever downloaded or opened.
- DAU counts distinct foreground-active UUIDs on each recorded UTC
  `activity_date`. WAU counts their union across that day and its six preceding
  UTC dates. It never adds daily unique counts.
- `activity.sql` includes zero dates, 30 completed UTC days and labelled partial
  today. The first six tracking dates have incomplete seven-day history.
- `headlines.sql` reports yesterday's DAU, exactly seven completed UTC dates
  ending yesterday, and partial today's DAU.
- Initial `profile_origin` classifies the directory at first observation. It
  does not identify later completed updates. The rename corrects that
  claim while retaining the existing insight and query.

The all-time new-profile total and SQL reports are standalone insights, linked
from the desktop dashboard. Only the selected-period new-profile total inherits
the dashboard's date range.
Their source date filter stays all-time so the explicit UTC windows retain their
six-day warmup. Their advertised controls are `desktop_build_channel` and
`desktop_distribution`, defaulting to `all`. Channel values are `stable`,
`nightly` and `unknown`; distribution is `direct` or `store`. Historical Linux
`direct` attribution includes pacman and cannot separate it retrospectively.

Do not embed these SQL reports in a dashboard with a date override until its
tile can ignore that override and boundary checks pass. The
[`{filters}` placeholder](https://posthog.com/docs/data-warehouse/sql/variables#applying-dashboard-filters)
also applies dates, which can otherwise remove the WAU warmup. It retains the
source's configured internal/test exclusion. Standalone date controls must stay
all-time; the SQL itself owns the UTC window.

## Validation and remaining work

Read-only native Trends validation returned an all-time fresh-profile
`aggregated_value` of 197 on 23 October 2026. A BoldNumber response's empty
`data` and zero `count` did not mean the total was zero.

Read-only SQL with default variable literals and `filters=true` returned 33
active profiles on 22 October, a union of 151 across 16 to 22 October, and nine
on partial 23 October. These are diagnostic snapshots. Saved definitions,
filters and variables were read back after the authorized application; see
Applied reports below.

The client event contract is documented in [telemetry](../../telemetry.md).
`release-arrivals.sql` selects each identity's first target-version observation
across retained history, using original event time and deduplicating event UUIDs.
Build-channel and distribution controls apply after that selection. Each arrival
belongs to exactly one category: new profile, known same-channel upgrade,
downgrade, channel transition or unknown history. The denominator for the known
upgrade share includes unknown history. This is adoption by release, not a count
of installer executions or every repeated upgrade.

`release-upgrades.sql` shows up to 100 anonymous installation UUIDs whose first
arrival on `desktop_target_version` was a known upgrade. Its default is 0.0.19.
Existing profiles without a version baseline remain unknown. Historical
multi-version activity can suggest an upgrade but is excluded from this explicit
report. Recorded profile origin never substitutes for a previous version.

Read-only literal fixtures returned 11 arrivals on 0.0.19: two new profiles, two
known upgrades, two downgrades, one channel transition and four unknown histories.
Filtering to stable returned ten arrivals and three unknown histories. The
fixtures include duplicate UUIDs, delayed delivery, numeric version ordering,
cleared profiles and downgrade/re-upgrade sequences. Nightly ordering compares the numeric base, date and run, matching the client release contract. Same-base nightly date/run upgrades and downgrades have separate fixtures; equal or unsupported pairs stay unknown. The drilldown returned
exactly the two known-upgrade fixture UUIDs. No fixture entered event storage.
Final independent Claude and Codex reviews found no blocking source issues.

These are installation/profile counts, not named people or devices. Retained
reinstalls keep identity; clearing data can create another identity, and copied
profiles share one. Optional collection, offline expiry and bounded delivery
reduce coverage. Production ingestion and UUID deduplication need actual rollout
evidence. Local fixtures never enter production.

## Applied reports

The [desktop dashboard](https://eu.posthog.com/project/178919/dashboard/1013890)
retains its original eleven tiles and layouts. It adds the selected-period fresh
profile count and links to the standalone reports:

- [New profiles since tracking began](https://eu.posthog.com/project/178919/insights/99UimzE0)
- [Completed UTC activity and partial today](https://eu.posthog.com/project/178919/insights/bphaOVG7)
- [UTC daily and seven-day active profiles](https://eu.posthog.com/project/178919/insights/TCRXpm4b)
- [Release arrivals](https://eu.posthog.com/project/178919/insights/DAifasdI)
- [Profiles that upgraded](https://eu.posthog.com/project/178919/insights/5WvwlOYe)

Saved SQL, variable bindings and defaults, source test exclusions and all-time
filters were read back. Unmatched build-channel and distribution overrides
returned zero counts; the activity report retained zero-date rows. Rename-only
updates preserved both original queries. These are custom report definitions;
the project has no approved Data Catalog metrics yet.

With identical query bounds, both fresh-profile reports returned 199 on
23 October. The first cached all-time read returned 197. UTC headlines returned
33 for 22 October, 151 across 16 to 22 October and 12 for partial 23 October.
These are changing snapshots, not rollout evidence. Version-arrival reports
were empty before the new client event shipped. Production ingestion and UUID
reconciliation remain release checks. No fixture events were captured.
