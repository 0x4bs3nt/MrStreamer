# Product and reliability measurements

The main-process `Analytics` owner controls consent, installation identity, fixed daily counters and the durable outbox. Collection uses the existing default-on statistics preference. These definitions describe the payload contract and local queries; they do not change a live PostHog project or establish live ingestion or retention.

## Questions and events

| Event                   | Question                                                                 | Frequency                                                  |
| ----------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `installation_observed` | Which profiles were first observed using a configured build?             | Once per profile, unchanged                                |
| `app_active_day`        | Which installations use the primary window in the foreground?            | Once per UTC foreground day, unchanged                     |
| `app_summary_day`       | Which screens are entered, and how do observed requests/runs/checks end? | At most one completed-day aggregate per UTC foreground day |

The existing envelope contains a random installation UUID, event UUID and delivery-observation timestamp. The installation identifier is pseudonymous, not anonymous. Properties are `app_version`, `build_channel`, `update_channel`, `os`, `arch`, `distribution`, `profile_origin`, `$process_person_profile: false` and `$geoip_disable: true`. Activity adds `activity_date`; summaries add `summary_date` and `counts`. There are no individual action timestamps or content identities.

Each aggregate and completed snapshot records its own build dimensions. An upgrade before rollover cannot relabel prior-day counts. A dimension change within one UTC day resets current counts. This intentionally loses partial-day coverage; it never creates a per-build history or multiple summaries for that day. Outcomes of operations spanning a selected-channel change are excluded, including a change back to the original channel. Repeating the same channel preserves valid results, including across midnight.

## Fixed counters

`counts.features` has only `home`, `live_tv`, `movies`, `series`, `watchlist`, `downloads`, `search`, `settings`, `player` and `details`. Renderer notifications carry a single validated literal. Page changes and closed-to-open overlays count entries. Re-renders, text input, Settings tab changes and switching between player modes do not count again. Details count when visible, including a return from playback. Main owns all counters and outgoing payloads.

Each of `playback_open`, `download_transfer` and `update_check` has `started`, `success`, `failed`, `interrupted` and `failures`. Failures have only `network`, `credentials`, `unsupported`, `disk`, `unavailable` and `app` counters.

| Operation           | Observed start and terminal meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playback_open`     | One validated public `playback.open`, `playback.openTitle`, `playback.openCopy`, `output.playChannel` or `output.openTitle` handler execution. Success means the request resolved. Superseded opens and cancellation count as interrupted. A Home preview refused because a receiver holds playback is excluded before its turn and start. This includes accepted Home preview opens and prepared receiver-title opens; it does not prove displayed video, audible sound or a receiver's subsequent title load. |
| `download_transfer` | One leased transfer run, including file resolution and final rename. Success means the complete copy was kept. Failure includes transfer, disk and finalization failures. Cancellation, playback preemption and observed shutdown interruptions are separate. Queue additions, duplicate additions, progress and artwork fetching are excluded.                                                                                                                                                                 |
| `update_check`      | One actual shared release-discovery fiber, including automatic checks and channel changes. Success means discovery answered, even with no offered release. Awaiting callers do not multiply counts. Installer downloads and installation are excluded.                                                                                                                                                                                                                                                          |

Started and terminal counts use the UTC day on which main observes them, independently. A request starting before midnight and finishing afterward has a start on the earlier day and a result on the later one. Unfinished attempts and outcomes main never receives cannot be reconstructed.

Classification reads typed failure kinds and bounded HTTP status categories only to select a code. It never copies an exception, message, status number, log, stack, URL, path, title, channel, provider or search query. A refused stream with HTTP 401/403 maps to `credentials`; other refusals and unavailable/provider-error streams map to `unavailable`. Network and unsupported stream kinds keep those codes. Download folder/full-disk failures map to `disk`. Typed provider HTTP errors map to `unavailable`; unknown app failures map to `app`. Feed offline failures map to `network`; invalid feeds map to `app`; HTTP/rate-limit failures map to `unavailable`.

`counts.renderer` contains `starts`, `crashed`, `killed` and `other`. Main observes primary-window loading and Electron `render-process-gone` reasons. Clean exits, actual requested window closes and app shutdown are excluded. Reloads are new starts. These counts cannot observe a main-process crash, power loss or an OS termination main never receives. No crash report or raw exit reason leaves the process.

## Consent and bounds

Opt-out pauses collection synchronously before queued disk writes, aborts the owned request, clears pending events and clears daily counts. Restart stays off. Re-enable starts fresh counting; an operation can report its result only in the enabled generation and dimensions that observed its start. Disabled activity and old pending counts are never backfilled. Installation first-seen and daily foreground observation semantics remain unchanged.

Unconfigured builds count and send nothing. Development, automated and isolated profiles cannot use production capture. An isolated local verifier can explicitly select a literal loopback endpoint; it cannot fall back to production or follow redirects there.

Memory and persisted state retain the current UTC bucket and at most one completed bucket. Newer completed days replace older unsent buckets. Foreground observation queues a completed summary once, within the existing eight-event outbox and three attempts per event across restarts. Expiry and offline losses reduce coverage. Clock rollback drops notes until the current observed day is reached and never reopens reported days. A dropped start supplies no token, so its later result is also excluded.

Each counter stops at 1,000,000. `counts.saturated` marks any clipped increment. Exclude saturated summaries from rates. Notes mutate fixed-size memory and never wait for playback or transfers. One delayed checkpoint and one dirty flag coalesce bursts through the existing disk serializer; notes cannot create a per-action persistence queue. Foreground/outbox writes also checkpoint counts. Shutdown retains its 500 ms total wait; a hung disk or transport fails closed. Very recent uncheckpointed notes can be lost on abrupt termination.

## Local dashboard definitions

Group comparisons by recorded `app_version`, `build_channel`, `update_channel`, `os`, `arch` and `distribution`. Deduplicate events by UUID when inspecting capture attempts.

- Feature adoption for a day/build is the number of distinct installations with a positive fixed feature count divided by distinct installations with a received summary for that day/build.
- Operation reliability is `sum(success) / (sum(success) + sum(failed))`. Report the denominator beside the rate. Starts show volume and unmatched/in-flight attempts; interruptions stay separate. A zero terminal denominator yields no rate.
- Failure-category bars sum the six fixed failure counters for each operation.
- Renderer stability is `(sum(crashed) + sum(killed) + sum(other)) / sum(starts)`, with the observation limits above. A zero start denominator yields no rate.

Exclude saturated summaries from these calculations. Keep existing first-seen and foreground-active views separate. Received-summary coverage is not the entire active population. Short-lived users who never return, consent changes, partial-day dimension resets, offline expiry, startup before consent and selected-channel dimensions are known and interrupted processes all limit coverage.

Verify the contract through focused public-owner/capture tests and the built-app Privacy feature-map path. Settings helper, FAQ and privacy-policy claims must match this catalogue before release. Live dashboards and retention still require their own acceptance.
