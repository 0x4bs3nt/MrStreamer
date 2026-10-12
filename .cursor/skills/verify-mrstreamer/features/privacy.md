# Basic app-use statistics

## How to get to it

Open Settings > General > Privacy. Share basic usage statistics is on by default. Turn it off with the checkbox; the short helper describes profile-first-seen and weekly app use, and Privacy policy opens the canonical policy in the system browser. No first-use notice or upgrade prompt is shown. Settings > About retains its Privacy link.

## Driving the built app

After `pnpm build`, run `xvfb-run -a node apps/desktop/test/e2e/analytics-app.ts` on headless Linux. The helper owns an isolated profile, loopback capture endpoint and debugging ports. It drives the Settings checkbox with pointer input, observes ordinary preferences and actual capture payloads, restarts the same isolated profile, and retains screenshots, payloads, instance identity and cleanup proof under `.local/verification/analytics-*`. It uses fake provider/TMDB boundaries only, with automatic updates off. Production transport is impossible for this isolated profile, even if a release bundle contains production configuration.

Require a checked default, exactly one installation_observed plus one app_active_day with only allowed properties, a visibly unchecked control after disabling, no further captures after disabling or restarting, and the same installation identity with no duplicate first-seen/day capture after enabling again. Inspect screenshots and actual local payloads. Renderer/service reads establish results; pointer and keys perform mutations. All five translated controls are checked by focused renderer tests; native platform acceptance remains separate.

## Limits

The maintainer completed EU Cloud/free-plan account setup and reported saving the three dashboard insights. The recorded policy reviews usage and retention monthly, with no additional automatic deletion. `docs/privacy.md` holds the selected policy and attributed provider retention terms. Loopback payloads prove the integration contract; live ingestion, dashboard counts and server deletion deadlines remain unverified. `apps/desktop/test/analytics.test.ts` checks long foreground/date rollover, upgrade/unknown origins, persistence failure, races, retries, bounded queue and quit deadlines through the public owner and capture contracts. Exact-nightly installed native checks remain on Release 0.0.11. Real-provider playback uses the separate authorized acceptance workflow.
