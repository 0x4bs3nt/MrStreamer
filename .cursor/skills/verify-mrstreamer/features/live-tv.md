# Live TV

## Sub-features

Pick channels through global search, Live TV, guide or favourites. Watch shares its live stream with the muted Home preview. Other paths include codec conversion, captions, recovery and favourite ordering.

## How to get to it (user POV)

After connecting, **Search** or Ctrl-K/Cmd-K finds channels and programmes. Enter starts the selected channel. **Live TV** provides channel/category and guide browsing. Escape leaves Watch for Home; **Watch** returns to the current channel. Favourites are saved from channel controls and appear on Home and Live TV. **CC** lists the channel's subtitles and, under them, **Timing** while teletext, captions or HLS text shows, and the look's Size, Background and Position. **More** has no subtitle settings.

## Driving it with Electron CDP

Preconditions: `pnpm build`, a display and the fake provider's `h264-aac.mpegts` fixture. Run `pnpm verify:desktop live-tv`. Search `TEST | H.264 + AAC`, press Enter and observe Watch, an advancing video clock, nonzero picture width and decoded audio bytes. Press Escape and observe a playing, muted compact Home preview. Click Watch and observe unmuted playback, exactly one active provider connection and zero extra stream requests. Retain screenshots of the connected app, Watch, Home preview and final Watch.

For converted codecs, titles and subtitle rendering use `apps/desktop/test/e2e/packaged-app.ts`; recovery uses `live-recovery-app.ts`; favourites use `favourite-order.ts`; external guide settings use `guide-source.ts`. Follow their documented executable arguments and capture the affected entry point, not only global search.

For category compatibility, read `docs/user/category-compatibility.md`. `provider-categories.test.ts` exercises Xtream memberships across Live/Movie/Series; `library.test.ts` checks duplicate-category counts, unknown-reference All reachability, adult filtering, refresh and restart. Core catalogue cases keep conflicting country/language/guide metadata from joining variants. Guide suffixes use ISO countries, so `.ar` means Argentina while a reseller's `AR |` prefix can mean Arabic.

The baseline alone does not prove these category paths. In an isolated fixture session, select a category, check its count and programmes, star a channel, search it and play two quality choices. Refresh reordered rows through Settings > Subscriptions, restart the same disposable profile, and check the selected category, Favourites, Recently watched and remembered quality. Include inherited M3U `#EXTGRP` groups and resets; inherited adult entries must be absent from ordinary lists and Home. Retain screenshots and playback observations. Real-provider and installed-platform acceptance remain separate.

A failed channel's message, here or on a TV and in the mini player, closes with its cross (**Close message**). The channel stays failed and the message stays closed while the controls wake; **Watch** or R tries again and the next failure shows its own message. A lost TV's closed message stays closed while receivers are found or the list scans; reaching the TV again and losing it shows it again. R on a lost TV that has gone from the list is refused before it connects, so the TV stays lost and "… didn't answer" shows at the top right for a few seconds, each retry its own and closed with its own cross. Closed from the keyboard, focus moves to Watch, and Enter or Space on the cross is its own rather than the channel list's or a retry's. A TV connect that reached no receiver closes the same way, though its note sits outside the picture area. Renderer cases are in `renderer/live-recovery.test.ts` ("a failure's message") and `renderer/receiver.test.ts`.

For subtitle availability and subtitle-only outages, use `apps/desktop/test/e2e/live-subtitle-errors-app.ts`. Select cases with `MR_STREAMER_SUBTITLE_ERRORS_ONLY`; use `live-six-off` and `live-six-remembered` for discovery, and `live-segment-outage` to observe subtitle expiry followed by a video reconnect. For timing and look, open CC on `TEST | Subtitles and two sound tracks`, pick the teletext track, reopen CC and press Later, Earlier and Reset, then a Size, Background and Position: the value beside Timing follows, the menu stays open, and Escape hands G and H back. `renderer/live-more.test.ts` covers the rows, their show rules and the greyed rows while a TV plays. Require actual subtitle cues before the CC control appears, advancing picture during subtitle failure, restoration of the chosen language on reconnect and explicit Off remaining off. The fixture remains synthetic; actual-provider and native-platform acceptance stay separate.

Source: `docs/user/live-tv.md`, `apps/desktop/src/renderer/src/player/`, `apps/desktop/test/e2e/packaged-app.ts`.

## Gotchas

Only the synthetic codec-test channels play media. A final frame can conceal stopped playback; require clock progress and decoded sound. Home deliberately keeps the stream running. Linux Xvfb proves functional decoding only; audible sound, GPU use, real streams and AirPlay/Cast remain separate checks.
