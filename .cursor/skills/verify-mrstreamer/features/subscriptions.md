# Subscriptions

## Sub-features

Connect an Xtream account or an M3U link; add, rename, refresh, repair or remove subscriptions in Settings. Libraries combine subscriptions rather than switching between accounts.

## How to get to it (user POV)

An empty profile opens Connect. Enter server, username and password, then submit. Use **Use an M3U link** for a playlist. With a connected account, open **Settings > Subscriptions**. Add subscription takes a name and connection details. Removal asks for confirmation and optionally removes viewing/watchlist data.

## Driving it with Electron CDP

Preconditions: built app and fixture media, ffmpeg/ffprobe, a display or Xvfb. Run `pnpm verify:desktop subscriptions`. The helper fills the real Connect form with its fake provider, submits it, waits for the library header, and opens Settings > Subscriptions. Proof must show one saved subscription row, a created `mrstreamer.db`, and no active playback. Screenshots include empty Connect, the connected app and subscription settings.

For playlist paths use `apps/desktop/test/e2e/playlist-app.ts`; for merged libraries, rename, refresh, removal and credential repair use `apps/desktop/test/e2e/multiple-subscriptions.ts`. Their executable/argument recipes are in `docs/contributing/testing.md`. Preserve before/after UI evidence for the changed path, including removal confirmation where relevant.

Run `pnpm verify:desktop background-refresh` to connect through the real form, stay on Live TV while the fixture holds its guide, and observe movie/series readiness without opening Movies. Home also requests missing lists, so this scenario checks playback and request counts while the guide waits; the public Roster cases prove background scheduling. The proof requires one set of title-list requests, no title details or files, then a usable guide after release. Xtream guide and title refresh run beside each other once channels are ready, on add, secret repair and stale startup; their service owners retain cancellation and refresh joining. Public `roster.test.ts` also checks repair/startup, foreground joining and a second subscription progressing. This scenario uses a fresh source, so cached startup and installed-platform acceptance still need their own checks.

Source: `docs/user/subscriptions.md`, `apps/desktop/src/renderer/src/features/settings/SubscriptionSection.tsx`, `apps/desktop/src/main/services/` and the named harnesses.

## Gotchas

M3U `#EXTGRP` applies to subsequent entries until an empty directive or explicit `group-title` resets inheritance. `packages/core/test/playlist.test.ts` checks chunked reads, multiple memberships and inherited adult categories. Explicit Live/Movie/Series mappings remain authoritative; no category name automatically chooses a title kind. See `docs/user/category-compatibility.md` for provenance and supported conventions.

An existing user's profile hides Connect and can write real secrets. Always use a fresh profile; macOS requires mock keychain. A row proves initial connection only, not refresh, restart or removal. A fake provider proves the app's contract with it, not acceptance of a real provider or entitlement.
