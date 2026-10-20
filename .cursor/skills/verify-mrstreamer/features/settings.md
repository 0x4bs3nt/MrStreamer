# Settings

Settings opens over playback with Cmd/Ctrl comma or the header button. The rail order is General, Playback, Live TV, Movies and series, Subtitles, Home, Subscriptions, Guides, Updates, Privacy, About. Privacy is directly above About. Both the rail and each section scroll independently. Visited forms stay mounted while Settings is open, preserving drafts, pending/error feedback and scroll positions.

Find a setting searches translated labels, section names and translated synonyms locally in English, Dutch, French, German and Spanish. Enter opens the first result; Down reaches the results. Selecting a result scrolls to and focuses its real control. Clear search recovers from no results. Escape clears a nonempty search, cancels delay editing, closes a nested dialog first, returns licences to About, or closes Settings from outside text editing. Closing Settings clears any unresolved destination and restores the opener's focus when it remains connected, otherwise the playing Title/Watch root or the header Settings button. Ordinary save controls retain keyboard focus while pending and reject repeated writes. Delay Enter commits without blurring; Escape cancels its draft. Keyboard Retry returns to the associated control before its button disappears, or the current rail item or search field when there is no associated control. This includes online-subtitle read recovery. Settings holds the existing next-episode countdown through the UI store; the controller still owns its policy and active countdown snapshot.

## Control inventory

| Previous location           | Current location and retained actions                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| General / App               | General: Interface language and System default                                                                                        |
| General / Movies and series | Playback: Audio in, Next episode autoplay, exact delay                                                                                |
| General / Live TV           | Live TV: Quality and reset channel-specific qualities, including row failure/retry                                                    |
| General / Movies and series | Movies and series: Titles in, For adults, TMDB own key/app key/progress                                                               |
| General / Movies and series | Subtitles: language, Off and Only when forced                                                                                         |
| Watch / CC                  | Subtitles / Subtitle look: new Settings editor of existing size/background/position preferences, using shared choices and publication |
| General / Online subtitles  | Subtitles / Online subtitles: enable, services, languages, credentials, replace/remove                                                |
| Home                        | Home: visibility, order and reset                                                                                                     |
| Subscriptions               | Subscriptions: add, repair, import, refresh, edit, remove and guide mapping                                                           |
| Guides                      | Guides: sources, names, order, refresh and removal                                                                                    |
| General / Updates           | Updates: channel, check, download, cancel, restart, Store and release notes                                                           |
| General / Privacy           | Privacy: consent and policy                                                                                                           |
| About                       | About: version, website/source, licences, privacy, report, diagnostics, Store rating and TMDB/JustWatch notice                        |

The guide's G List/Guide toggle stays there. No new Downloads, cache, codecs or custom-list controls. Online-subtitle openers retain their intent alias and target Online search. Subscription and guide intents retain their existing state. Update notices target Updates; TMDB progress targets its key control.

## Verification

Build and run `pnpm verify:desktop settings`, with `xvfb-run -a` on headless Linux. It uses the real built Electron/CDP window and fake provider/TMDB with an owned temporary profile. It captures all eleven sections at 960x600, translated label/synonym results in all five locales, no-result recovery, licences return, exact/clamped delay and Shift+Up, select save focus and following Tab/Escape, a real preference-file replacement failure for both delay and quality, keyboard retry focus after refusal and success, independent TMDB draft retention, subtitle look, section scroll, wide/text scaling and restart. It also opens Online subtitles from a playing title's CC panel, checks focus and continued playback underneath, and returns to the title. The failure replaces only the owned profile's preferences path temporarily with a directory, retains the previous file, verifies the failed UI save does not acknowledge a value, then restores the file before clicking Retry. Product edits use actual input, never an IPC setter. PNGs, accessibility trees, action records and cleanup remain under `.local/verification/settings-*`.

The Settings scenario also retains the TMDB key draft and its focused field after a real failed save, and asserts focus on the playing title when its CC opener disappeared. Focused read-Retry cases cover subtitle settings and the no-current-rail-item state while Find a setting has a query.

Run `preferences` for Settings/player track publication and restart; `next-episode` for active countdown/Settings hold, instant and cancellation; `language` for the interface language and other translated pages; `subscriptions` and `guides` for those retained paths. Privacy uses its existing loopback analytics scenario. Focused renderer `settings-navigation`, `settings-tracks`, `analytics-setting`, `online-subtitle-panel`, `home` and `about` cases cover search/focus, delayed publication, row failure/retry, draft retention, consent and special actions. Native installers/Store, audible audio/GPU, real providers and receivers remain separate acceptance.
