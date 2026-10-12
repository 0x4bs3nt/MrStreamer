# Home

## Sub-features

Compact muted live preview, Continue watching and next useful episodes, bounded local recommendations, first-page Watchlist, favourite/recent channels, new titles and current category. Persisted order and visibility use stable row IDs; new rows append predictably, unknown future rows survive edits, Reset restores defaults.

## How to get to it

**Home** in the window bar. **Watchlist** at the top opens the full list in one step even when its row is empty or hidden. **Customize** opens a plain list of every row, including empty ones, with native checkboxes and up/down controls. Tab reaches controls, Space changes visibility, Enter moves a row. **Done** closes controls; **Reset to defaults** restores order and visibility. Changes save immediately and survive restart.

Default order: Continue watching, Recommendations, Watchlist, Favourites, Recently watched, New movies, New series, Current category. Only nonempty visible rows render. Explicitly mapped playlists use catalogue titles instead of unreliable added dates. Loading/error/empty catalogue states keep the permanent Home actions reachable. Live-only profiles can open an empty Watchlist without enabling Movies or Series.

A pending row save blocks further edits even after Done, toggling Customize or leaving Home and returning. Once it settles, edits use the latest saved preferences. Failed saves leave the saved rows intact, show the error and allow retry; moving a hidden row keeps it hidden after restart.

## Driving it with Electron CDP

Build and run `pnpm verify:desktop home`, prefixed with `xvfb-run -a` on headless Linux. The scenario drives empty-row controls, pointer and keyboard moves/visibility, hidden-row full Watchlist entry, reset and restart, a real saved title and local viewing recommendations, retaining actions, screenshots, read-only state and request counts. It asserts Watchlist stays hidden after moving and after restart, retaining both preference snapshots. Renderer Home tests hold preference writes to prove notification-gap and close/reopen blocking, settled edits and failure/retry. Inspect screenshots as well as proof. `live-tv` proves advancing decoded muted preview and one shared provider stream when returning to Watch. `watchlist` proves saving and the new permanent entry. `language` visits the Home controls in all five locales at the smallest window.

Deeper existing paths: `apps/desktop/test/e2e/watchlist-app.ts` covers sorting/removal/unavailable entries/restart/multiple subscriptions; `episode-marks.ts` covers next useful episodes on Home and owner-specific marks. Renderer `home`, `resume`, `next-episode`, `episode-marks` and `watchlist` test the public controls and transitions. Service `related`, `watchlist`, `viewing` and `preferences` tests cover bounded recommendation work, ownership, mapped playlists, adult safety and persistence.

## Marketing capture

`apps/desktop/scripts/marketing-capture.ts` uses the licensed demo manifest and a real Mac mini source build. It plays Canyon Hours through the UI, then requires Continue watching, Recommendations and the actual seed reason on Home. The master keeps the compact muted preview and permanent Watchlist/Customize actions. Additional ignored proof opens the row controls. These selected native captures strengthen screenshot evidence only; they do not establish every locale, mapped-M3U, installed-package, audio/GPU or receiver acceptance path. Follow `docs/contributing/marketing-artwork.md` for masters and provenance.

## Gotchas

Recommendations rank up to three distinct available nonadult seeds from at most 32 recent started plays, including finished films, against loaded catalogues only. They return at most twelve deduplicated titles, up to four per seed. Their reasons name the actual local seed and existing related-title match. Missing/removed seeds and candidates stay out. Provider category/name fallback matches only within its owner; known genres can match across saved owners. Home triggers no recommendation list/details/file request. No history means no personalized row, and incomplete metadata uses existing fallback rules. No content/history leaves the device.

Home's Watchlist query excludes adult entries at its owner, including unavailable adult saves, even when Settings allows them. The full Watchlist keeps that setting. Recommendations and Continue watching also always exclude adult titles. Existing preview ownership and playback controllers are unchanged.

Native audible sound/GPU use, installed packages, actual providers and receiver behavior require coordinator-owned acceptance; Linux Xvfb does not prove those.

Source: `docs/user/live-tv.md#home`, `docs/user/movies-and-series.md#watchlist`, `apps/desktop/src/renderer/src/features/home/`, `apps/desktop/src/main/ondemand/catalogue-worker.ts`.
