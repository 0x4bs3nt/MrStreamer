# Watchlist

## Sub-features

Save/remove movies or whole series from details, browse Watchlist and Home, sort and keyboard-open entries, preserve saves across restart and subscription changes, handle unavailable titles.

## How to get to it (user POV)

A movie or series poster opens details. **Save** becomes **Saved** after saving; pressing it again removes the title. **Watchlist** at the top of Home permanently opens saved titles, including when its row is hidden or empty. Home also offers its Watchlist row and **All** entry. There is no Watchlist tab in the window bar. Tiles open details and have a removal control.

## Driving it with Electron CDP

Preconditions: fresh built desktop session with fake provider/TMDB. Run `pnpm verify:desktop watchlist`. Open the fixture movie through Movies > All movies, click Save, observe Saved, close details, and return Home and open its permanent Watchlist entry. Require the same title's saved tile, a persisted app database and before/after screenshots. The baseline proves the details-to-Home entry path, not restart persistence.

For removal, Home entry, keyboard actions, ordering, unavailable titles, database write failure, restart and multiple-subscription behavior use `apps/desktop/test/e2e/watchlist-app.ts`. Its real-click and keyboard recipes are reusable; IPC/database observations may confirm a save but cannot perform it for the proof.

Source: `docs/user/movies-and-series.md#watchlist`, `apps/desktop/src/renderer/src/features/watchlist/WatchlistPage.tsx`, `apps/desktop/test/e2e/watchlist-app.ts`.

Saved tiles share `PosterContent` with title grids and related rows. Their container assigns width; loaded and unavailable artwork keep the same 2:3 bounds. Verify long names, source attribution, selected focus and the removal cross after resizing. An unavailable entry uses the short `Sheet`, whose outer rounded frame clips its inner scroll viewport.

## Gotchas

Save is a toggle, so clicking twice undoes the first action. One displayed tile does not establish keyboard removal, series saves, ordering or persistence. A removed subscription can preserve its watchlist for reconnecting; ticked deletion has different acceptance. Verify the path the task actually changed.

Home uses a separate adult-free first-page query, even with adult titles enabled. The full Watchlist keeps its adult setting, sorting, removal and unavailable-entry behavior. For row controls and local recommendations, follow [Home](home.md).
