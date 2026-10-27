# Interface language

## Sub-features

The app's own text in English, Dutch, French, German or Spanish, picked in **Settings > General > Interface language** or followed from the system (System default). It changes the window, the macOS menu and the save dialog at once, survives a restart, and leaves Titles in, Audio in and Subtitles as they are. Dates, numbers and plurals follow the language.

## How to get to it (user POV)

Open **Settings** (⌘, or Ctrl ,), stay on **General**, and pick a language in its select. System default names the language it follows. Every page, the player, its menus and messages, then read in that language.

## Driving it with Electron CDP

Preconditions: built app and fixture media, ffmpeg/ffprobe, a display or Xvfb. Run `pnpm verify:desktop language`. The helper waits for the Interface language select by its locale-valued options, so an earlier Quality select cannot satisfy readiness. It connects through the real form and sizes the page as the smallest window, 960 × 600. It checks the Settings > Home row list in English, then picks French, Dutch, Spanish and German with the keyboard (type-ahead on the focused select) and checks Settings, the window bar and all eight Home customization labels in each. It checks that the title, sound and subtitle languages are unchanged. It quits and restarts in German, then opens each available page and checks nothing runs past the window. An empty Watchlist stays out of navigation and is recorded as hidden. This baseline does not populate both Watchlist and Downloads before the German page sweep, so it does not prove the longest populated header; that combination needs a focused runtime check. It plays a channel from global search, checks the player's controls, walks More with Space and Down, and opens **TEST | Offline** for a failure message in German, then reaches its cross (Meldung schließen) with Tab and closes it with Enter: focus moves to Ansehen and no channel list opens. It switches to French, opens a movie's details, plays it, opens the subtitle panel, and opens a series' episodes. Still in French it plays **TEST | Missing file**, closes its message with the cross (Fermer le message) and checks Play stays to try again. It downloads a movie from its details and opens the Downloads page from the bar, checking its headings, buttons and that nothing runs past the window. It sets System default and, on Linux, restarts on a Dutch system via per-process `LANGUAGE`/`LANG`. On macOS and Windows it retains the actual host system language and verifies the System default choice and label after restart; it records that Dutch-system simulation is unavailable and never changes host settings. Last, it writes `interfaceLanguage: "it-IT"` into `preferences.json` as a later release would and restarts: English shows, and the rest of the file is unchanged. Expected text comes from the catalogue the app ships (`translate`), so a corrected translation doesn't break the check.

The proof holds a screenshot and accessibility tree for each step (`settings-<locale>`, `home-<locale>`, `page-*-de-DE`, `player-de-DE`, `more-de-DE`, `error-de-DE`, `error-closed-de-DE`, `movie-fr-FR`, `title-player-fr-FR`, `subtitles-fr-FR`, `series-fr-FR`, `title-error-fr-FR`, `title-error-closed-fr-FR`, `download-done-fr-FR`, `downloads-fr-FR`, `restart-de-DE`, `system-nl-NL`, `unknown-en`) and the observed labels.

Every Downloads state in French, through the same path as English: `pnpm verify:desktop downloads fr-FR` (see [Downloads](downloads.md)).

Source: `docs/contributing/architecture.md#interface-language`, `packages/core/src/i18n.ts` and `i18n/`, `apps/desktop/src/main/language.ts`, `apps/desktop/src/main/menu.ts`, `apps/desktop/src/renderer/src/app/language.ts`, `features/settings/GeneralSection.tsx`.

## Gotchas

On Linux the helper sets the system language through `LANGUAGE` and `LANG`; macOS and Windows take theirs from the system settings, so System default there needs a native check. The macOS menu bar, the save dialog's system-drawn buttons and the local network prompt can't be seen through CDP. A text the main process wrote before a change, such as a failure already on screen or the track names of a title already open, stays in the old language until it is made again. Packaged languages (`electronLanguages`, MSIX `languages`) need an installed build to check.
