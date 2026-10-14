---
name: verify-mrstreamer
description: Verify MR Streamer's desktop player and marketing website through real UI paths, isolated sessions, screenshots and observed side effects. Use when implementing, fixing or reviewing player or website behavior, or reproducing a problem.
---

# Verify MR Streamer

This is the repo's control skill. The installed task skill owns the implementation, investigation or review method; this skill supplies launch, driving and proof. Choose desktop or website by the changed user surface; read the relevant entry in [the feature map](features/README.md) before deciding what a passing check means.

## Launch

Run from the repository root with Node 24+ and the pinned pnpm. Prepare once, and rebuild after product changes:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:desktop doctor
pnpm verify:desktop live-tv
```

On Linux without a display, replace the last command with `xvfb-run -a pnpm verify:desktop live-tv`. Use the same prefix for other scenarios. The helper resolves this checkout's Electron executable, starts the built desktop app with a fresh temporary profile and a loopback debugging port, and starts the existing fake IPTV provider and TMDB API. Each invocation is a complete fresh session, including teardown; there is no shared app for later commands to attach to. Readiness means CDP answers, its command line matches the owned profile/port/checkout, and the window loads this checkout's built renderer.

Prerequisites are Electron's downloaded binary, ffmpeg and ffprobe, plus a display or Xvfb on Linux. `pnpm install` may download Electron; `doctor` checks files and tools without downloading it. If the Electron binary is missing after installation, follow [development](../../../docs/contributing/development.md); do not change host sandbox policy to start the app. The Linux helper uses the repo's documented `--no-sandbox` recipe only for this disposable instance. macOS uses `--use-mock-keychain`. Native macOS and Windows runs still need verification on those systems.

## Doctor

`pnpm verify:desktop doctor` is a read-only preflight. It reports app version, Git revision, the built main bundle's SHA-256, executable, ffmpeg/ffprobe versions and display availability. It does not launch the app or prove a live session healthy. A changed source tree requires a fresh build; a hash does not establish that source and output agree.

Every scenario also runs a live doctor before driving and after success. It checks that the owned process is alive, that CDP's browser arguments name our profile, port and app directory, and that the renderer URL belongs to our build. A surprising result ends the session with retained failure evidence and cleanup. Diagnose the output, run preflight again, correct the demonstrated problem and start a fresh scenario. Never attach to an unverified daily-driver instance.

## Drive

```sh
pnpm verify:desktop --help
pnpm verify:desktop subscriptions
pnpm verify:desktop remove-during-guide
pnpm verify:desktop live-tv
pnpm verify:desktop guides
pnpm verify:desktop catch-up
pnpm verify:desktop catch-up-hls
pnpm verify:desktop guide-grid
pnpm verify:desktop titles
pnpm verify:desktop watchlist
pnpm verify:desktop downloads
pnpm verify:desktop language
```

The executable [control helper](scripts/control.ts) reuses `apps/desktop/test/e2e/app.ts` for CDP and the repo's provider/TMDB fixtures. It uses DOM handles from real ARIA labels, button text and poster titles to send pointer/key/text input to the window. Login, navigation and saving go through the UI. On Linux every scenario starts on an English system (`LANGUAGE`/`LANG`), so the app's System default reads in English; `language` restarts on others. Read-only DOM observations and fixture request counters establish results; invoking an IPC setter or modifying the database cannot substitute for the user path.

These scenarios are baseline proofs, not exhaustive acceptance. Each feature entry names additional supported paths and the existing deeper harness. For a changed path outside the baseline, drive it through the existing harness or extend this helper with a focused UI scenario and retained evidence. For a running Electron desktop window use its repo CDP harness; for a web surface use T3's collaborative browser. For website proof, follow [the website entry](features/website.md). Prefer T3 collaborative preview for browser driving: status, open, snapshot and focused interactions. If tools are absent or opening the browser reports it unavailable, the repo fallback below uses the same pinned Electron/CDP machinery.

## Website launch and proof

Build locally from the repo root:

```sh
pnpm build:marketing
pnpm verify:website --help
pnpm verify:website
```

On headless Linux: `xvfb-run -a pnpm verify:website`. The executable [website helper](scripts/website.ts) starts the existing Vite preview on an OS-selected loopback port and an isolated browser/profile. Its live doctor checks both child processes, browser/profile/port identity and the local site origin before interaction and after navigation. Each invocation drives Home at 1280px and 390px, then keeps the 390px viewport while clicking FAQ, the Downloads guide, Guides, Subscriptions, Downloads, Releases and Privacy, checking each route's layout, rendered heading and HTTP status. It then reads FAQ and follows its Downloads guide link with page scripts disabled. It validates all four installer destinations or their GitHub Releases fallback, plus the Microsoft Store product. Unknown routes must answer 404. Screenshots, accessibility trees, actions, served-build hash, route metadata, installer/Store links and teardown results remain in `.local/verification/website-<unique>/`.

The build reads public GitHub releases and verifies installer links; it writes ignored local output, never publishes Vercel. The fallback browser blocks external requests, so proof records build-time links rather than live feed refresh or actual installer downloads. For an interactive collaborative preview, start the documented `pnpm preview:marketing` with a unique strict port, bind to the owned local server and follow the website feature entry; retain actions and screenshots, then stop that owned server. A tools failure grants no host sandbox-setup or production-deployment authority.

## Native macOS on the Mac mini

Use the installed `mac-mini` skill for native Mac checks. It is the access and control workflow; reuse its `onmac`, `cua-driver` and capture guidance. Start with `onmac check`, then run from this MR Streamer checkout:

```sh
onmac run -- pnpm install --frozen-lockfile
onmac run -- pnpm build
onmac run -- pnpm verify:desktop doctor
onmac run -- pnpm verify:desktop live-tv
```

Other desktop scenarios use the same command. Install the Mac's own dependencies; Linux `node_modules` is not a Mac build. The helper keeps its temporary profile and mock keychain. For native controls, audible output, AirPlay or Safari-specific website behavior, use the Mac mini skill's installed window-control tools against your own instance. Keep provider logins off the rented Mac. When signing is authorized, use the Mac mini skill's managed signing setup. Pull retained `.local/verification/` evidence with `onmac pull` before scoped cleanup. Leave other agents' windows and checkouts intact, and report an unavailable Mac or missing GUI permission as a blocked native check. These recipes describe capability; claim macOS coverage only after an actual Mac run.

## Evidence

Each desktop scenario prints an absolute `.local/verification/<scenario>-<unique>/` directory containing:

- `proof.json`: action timestamps, build/instance identity, observations, limitations, pass/fail and cleanup outcome.
- Before/after PNGs and matching accessibility-tree JSON. Live TV also captures playback and the muted Home preview.
- `electron.log` and a failure screenshot when the window is still reachable.

Website runs retain the same proof, screenshots and accessibility trees, plus `session.log`, under their printed `website-<unique>` directory.

Check `status`, the actual observations and `cleanup`, then visually inspect the retained screenshots. A blank or unfinished screenshot is failed evidence even when DOM assertions pass. Pair the actions with the resulting state and side effects: subscription/database creation, TMDB detail requests, a saved title shown in Watchlist, or decoded video/audio and one provider stream shared by Home and Watch. A decode counter is not audible output, and headless decoding is not GPU or performance acceptance.

Desktop fixtures replace external production API boundaries only. Automatic update checks are off; ambient `MR_STREAMER_*` overrides are discarded except the explicit local ffmpeg path. This is a real built app using mock services, not a dry-run. Manual update checks, receiver discovery and real provider acceptance require their own authorized checks. Keep private credentials and stream URLs in gitignored `.local/`; desktop proof uses fake data only. Inspect evidence before sharing and publish only when authorized.

## Cleanup

The helpers request `Browser.close` for their browser/app and SIGTERM for their preview server, wait for owned children and escalate only against owned PIDs/process groups. The desktop helper closes its fixture servers; both remove their temporary profile or scratch directory in `finally`, including failed runs. Evidence remains in `.local/verification/`; verify the named files still exist after teardown. An unkillable app is a cleanup failure and its profile must be retained for recovery. Interrupt with Ctrl-C for normal cleanup; forced termination cannot run `finally`.

## Helpers

The public helper invocation is `pnpm verify:desktop <command>`. The website helper uses `pnpm verify:website`; its executable source is `scripts/website.ts`. Website analytics have their own scenario, `scripts/website-analytics.ts`, run as the website entry describes. Shared process ownership/cleanup lives in `scripts/session.ts`. The desktop source is also callable as `node .cursor/skills/verify-mrstreamer/scripts/control.ts <command>`. No global skill installation or additional daemon is needed.

## Maintenance

When product changes alter a documented path, update that feature entry in the same change and re-drive it. For a full audit, follow [maintenance](references/maintenance.md), the adapted pstack maintenance loop. Report source and live coverage separately. Keep run notes in `.local/`, not in committed maps. Ask the installed stack workflows to implement or review product work; this skill adds no commit, PR, merge, release or deployment authority.

Generated using [pstack's create-verification-skill template](https://github.com/cursor/plugins/blob/ccb5507cec1546dc88135c1139c811e6c59115ba/pstack/skills/create-verification-skill/SKILL.md). Workflow adaptations retain the [upstream MIT notice](../LICENSE.pstack).
