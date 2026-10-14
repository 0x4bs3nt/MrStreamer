# Subscriptions

## Sub-features

Connect an Xtream account or an M3U link; add, rename, refresh, repair or remove subscriptions in Settings. Libraries combine subscriptions rather than switching between accounts. Settings > Guides holds XMLTV guides every subscription reads after its own; each subscription's Guide row says where its programmes come from.

## How to get to it (user POV)

An empty profile opens Connect. Enter server, username and password, then submit. Use **Use an M3U link** for a playlist. With a connected account, open **Settings > Subscriptions**. Add subscription takes a name and connection details. Removal asks for confirmation and optionally removes viewing/watchlist data. **Settings > Guides** adds an XMLTV address with **Add**, orders guides with the arrows and removes one with the cross; the subscription's **Guide** row links there with **Guides**.

## Driving it with Electron CDP

Preconditions: built app and fixture media, ffmpeg/ffprobe, a display or Xvfb. Run `pnpm verify:desktop subscriptions`. The helper fills the real Connect form with its fake provider, submits it, waits for the library header, and opens Settings > Subscriptions. Proof must show one saved subscription row, a created `mrstreamer.db`, and no active playback. Screenshots include empty Connect, the connected app and subscription settings.

For guides run `pnpm verify:desktop guides`, described in the [Live TV entry](live-tv.md), and `apps/desktop/test/e2e/guide-source.ts` for mapping, failure, restart and removal. For playlist paths use `apps/desktop/test/e2e/playlist-app.ts`; for merged libraries, rename, refresh, removal and credential repair use `apps/desktop/test/e2e/multiple-subscriptions.ts`. Their executable/argument recipes are in `docs/contributing/testing.md`. Preserve before/after UI evidence for the changed path, including removal confirmation where relevant.

Run `pnpm verify:desktop background-refresh` to connect through the real form, stay on Live TV while the fixture holds its guide, and observe movie/series readiness without opening Movies. Home also requests missing lists, so this scenario checks playback and request counts while the guide waits; the public Roster cases prove background scheduling. The proof requires one set of title-list requests, no title details or files, then a usable guide after release. Xtream guide and title refresh run beside each other once channels are ready, on add, secret repair and stale startup; their service owners retain cancellation and refresh joining. Public `roster.test.ts` also checks repair/startup, foreground joining and a second subscription progressing. This scenario uses a fresh source, so cached startup and installed-platform acceptance still need their own checks.

Run `pnpm verify:desktop remove-during-guide` (source `scripts/remove-during-guide.ts`) for removal while the guide takes its time, as the installed upgrade check's last start does after an upgrade from 0.0.12. It connects, quits, puts back the guide document 0.0.12 kept, a large one, and leaves the provider's guide unanswered, then starts again and removes the only subscription through Settings > Subscriptions while that document is indexed. Pass means Connect is back within 10 seconds, no guide was asked for after the removal began and no guide file is left in the profile. `guide-source.test.ts` holds the same at the service, also for a download asked for under a login stored anew since. A real 0.0.12 install and Windows file handles need the installed upgrade check.

Run `pnpm verify:desktop moved-guide` (source `scripts/moved-guide.ts`) for the first start after an upgrade from 0.0.12 with a guide address of the viewer's own, which `docs/user/subscriptions.md` says downloads again straight after the update. It adds the address in Settings > Guides only to have the app's keychain seal it, quits, puts the profile back as 0.0.12 kept it (no sources, the own guide and a large download of the address as XMLTV, a channel mapped against it) and starts again. Pass means the guide host is asked for the address once, within 20 seconds of the start while the moved download is still indexed, the Guides row then reads the new download, the mapping holds and the 0.0.12 file is let go of. `guide-source.test.ts` holds the same at the service, and that removing the source while it is indexed asks nothing. A real 0.0.12 install needs the installed upgrade check.

Source: `docs/user/subscriptions.md`, `apps/desktop/src/renderer/src/features/settings/SubscriptionSection.tsx`, `GuidesSection.tsx`, `GuideSource.tsx`, `apps/desktop/src/main/services/` and the named harnesses.

## Gotchas

M3U `#EXTGRP` applies to subsequent entries until an empty directive or explicit `group-title` resets inheritance. `packages/core/test/playlist.test.ts` checks chunked reads, multiple memberships and inherited adult categories. Explicit Live/Movie/Series mappings remain authoritative; no category name automatically chooses a title kind. See `docs/user/category-compatibility.md` for provenance and supported conventions.

An existing user's profile hides Connect and can write real secrets. Always use a fresh profile; macOS requires mock keychain. A row proves initial connection only, not refresh, restart or removal. A fake provider proves the app's contract with it, not acceptance of a real provider or entitlement.
