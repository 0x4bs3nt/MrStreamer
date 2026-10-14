# Feature map

Source of truth for desktop and website verification paths. Run the relevant baseline, then cover the changed path's other entry points. Desktop helpers start a fresh app with fake IPTV/TMDB; the website helper starts a local build and isolated browser. Profiles and ports are owned by that run, and proof remains in gitignored `.local/verification/` after cleanup.

| Feature                              | Baseline                                      | Additional coverage                                                                             |
| ------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Home](home.md)                      | `home`                                        | Recommendations, permanent full Watchlist, empty/hidden row controls, move/reset/restart        |
| [Subscriptions](subscriptions.md)    | `subscriptions`                               | M3U, multiple subscriptions, credential repair, refresh, removal                                |
| [Live TV](live-tv.md)                | `live-tv`                                     | Live TV list, guide, favourites, recovery, codecs, captions, catch-up (`catch-up`, `-hls`)      |
| [Movies and series](titles.md)       | `titles`                                      | Search, filters, version selection, movie/episode playback, languages                           |
| [Watchlist](watchlist.md)            | `watchlist`                                   | Toggle removal, Home entry, restart persistence, keyboard, unavailable titles                   |
| [Downloads](downloads.md)            | `downloads`                                   | Preemption, cancel/retry/delete, offline restart, removed subscription, network record          |
| [Interface language](language.md)    | `language`                                    | Five languages, keyboard pick, restart, System default, unknown saved value, player and titles  |
| [Basic usage statistics](privacy.md) | `node apps/desktop/test/e2e/analytics-app.ts` | Settings opt-out/restart, loopback payload inspection; lifecycle and offline service contracts  |
| [Marketing website](website.md)      | `pnpm verify:website`                         | Responsive routes, download choices, guides, releases, privacy; live feed and Safari separately |

For desktop checks, use `pnpm verify:desktop doctor` first; the website helper performs its own live doctor. After a surprising result inspect retained proof and start a new owned session. PNGs and accessibility trees show the before/after state; `proof.json` records actions and observable side effects. A skipped entry point is a reported coverage gap. Passing one baseline never proves every path in a row. Installed packaging, updates, real provider services, hardware/audio output and receivers need their documented native checks. For native macOS behavior use the installed `mac-mini` skill and the parent skill's Mac recipes. Linux evidence is not macOS acceptance.

Release dry runs aggregate the seven required desktop paths through `pnpm verify:release-ui`, consuming the shared package bundle receipt and retaining each original helper proof. See [bounded release UI proof](../../../../docs/contributing/testing.md#bounded-release-ui-proof) for eligibility, cancellation, cost and native-acceptance limits.
