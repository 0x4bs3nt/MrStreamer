# Marketing artwork

The website shows five captures of the real app. They live in `docs/assets`:

| File                     | Shows                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `marketing-home.png`     | Stage preview and compact channel list, rounded actions, Continue watching and a local recommendation |
| `marketing-live-tv.png`  | Live TV, with eight channels and what's on now and next                                               |
| `marketing-tv-guide.png` | The guide grid, an aired programme open with Play from start and the catch-up signs                   |
| `marketing-library.png`  | A series' details, with its story, cast, Play, Save and a related title                               |
| `marketing-watching.png` | An episode playing, its subtitle on screen and the subtitle panel beside it                           |

Each is the whole window at 1280 × 800 points and twice the pixels, 2560 × 1600, saved as a lossless PNG. `apps/marketing/scripts/prepare-assets.ts` cuts every size the page uses from these five files, and the social picture too: the whole Home window for social links, the hero fan of Home/Live TV/TV Guide, and the two detail/subtitle features. The fan uses the Home stage cut on phones. The page changes when you commit new captures and at no other time.

The README shows the same captures as committed files in `docs/assets`: `readme-poster.webp`, the Home window with the Live TV and TV Guide cuts in front of it on black, and `readme-mark-light.svg` and `readme-mark-dark.svg`, the mark in GitHub's text colours. `node apps/marketing/scripts/prepare-assets.ts --readme` writes them from the same masters and `apps/desktop/assets/brand/mark.svg`; commit the result with new captures. Nothing is painted into a capture: the poster only places whole cuts beside each other.

Nothing in them comes from a real provider, film or person. The channels, programmes, titles, cast and subtitles are invented, and [`docs/assets/marketing-demo-sources.json`](../assets/marketing-demo-sources.json) lists every one. The moving pictures are public domain. Keep it that way. No provider's catalogue, no real posters, no real faces, no agency emblems.

## What you need

Native marketing captures use the workbench Mac mini. Follow the installed `mac-mini` skill, run `onmac check` first, and stop if the Mac or its GUI grants are unavailable. Never switch to a personal Mac. Name the native target before launch. The checkout's own unsigned source build uses a temporary profile, mock keychain, fake provider and fake TMDB. No signing or account is needed.

The Mac needs ffmpeg/ffprobe and the installed CuaDriver daemon with Accessibility and Screen Recording granted to `com.trycua.driver`. Start it with `workbench-cua-driver start`; do not restart a healthy shared daemon. The capture script uses a dedicated session and the owned PID's window titled `Mr. Streamer`. It records full native window captures alongside the page masters and closes only its own instance and session.

For a fresh media cache, allow 2.2 GB for the two source downloads and clips. `MR_STREAMER_FFMPEG` can name another ffmpeg, with ffprobe beside it. Existing cache clips and stills can be copied into this checkout's ignored cache. Check the original download sizes/hashes against the demo manifest and retain that evidence, then compare the copied clip/still hashes. Install dependencies on the Mac, never copy Linux `node_modules`.

## Run it

From this checkout on the workbench:

```sh
onmac check
onmac run -- pnpm install --frozen-lockfile
onmac run -- pnpm build
onmac run -- pnpm verify:desktop doctor
onmac run -- node apps/desktop/scripts/marketing-demo.ts --cache-dir .local/marketing-media
onmac run -- node apps/desktop/scripts/marketing-capture.ts --cache-dir .local/marketing-media [--only tv-guide]
onmac pull docs/assets .local/marketing-masters
onmac pull .local/marketing-captures .local/marketing-proof
```

If doctor reports a missing Electron binary, run the documented `onmac run -- node apps/desktop/node_modules/electron/install.js`, then repeat doctor. Inspect the pulled original PNGs before copying masters and `marketing-capture.json` from the pulled `assets/` folder into `docs/assets`. `--only` with capture names (`library`, `watching`, `live-tv`, `tv-guide`, `home`) refreshes those alone: it takes only the stages they need, writes only their masters and replaces only their manifest entries, each with its own `provenance`. Every master's entry is replaced as soon as the master is written, so a stage that fails later leaves no stale hash. Copy just those files. Keep the unchanged masters and their original provenance; an entry's `provenance` overrides the manifest's top-level capture provenance. Retain raw PNGs and proof on Linux, then run `onmac clean` for this checkout only. Leave every other app, checkout and capture alone.

Finally run `pnpm build:marketing` locally and inspect the real site at wide and 390px widths, then `node apps/marketing/scripts/prepare-assets.ts --readme` for the README's poster. This builds local output; deployment is separate.

Linux captures remain available with `xvfb-run -a node apps/desktop/scripts/marketing-capture.ts --cache-dir <ignored cache>`. Linux needs Inter and fontconfig. A Linux capture does not establish native macOS rendering. Do not replace masters with partial or blank captures.

## Sources

| Footage             | Source                                                                                                                                                                                                                                                                    | Part used      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Earth, on a channel | [4K Earth Views Extended Cut for Earth Day 2021](https://images.nasa.gov/details/jsc2021m000138_4K_Earth_Views_Extended_Cut_for_Earth_Day_%202021_210422-4KMP4), NASA Johnson Space Center. The 1080p download, 2,040,459,091 bytes.                                      | 09:00 to 11:00 |
| Canyon, in a series | [Grand Canyon South Rim summer time-lapse](https://www.nps.gov/grca/learn/photosmultimedia/b-roll_hd01.htm), U.S. National Park Service. The [1080p file](https://www.nps.gov/nps-audiovideo/audiovideo/49968ade-360e-4946-bfee-facd5086245d1080p.mp4), 33,836,539 bytes. | 00:10 to 00:40 |

The manifest holds each file's address, SHA-256 and the day it was fetched, 4 October 2026. `marketing-demo.ts` checks the SHA-256 before it uses a download.

Credit them as "NASA" and "U.S. National Park Service" wherever the pictures appear. Both are free to use: [NASA's media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) and the [park's B-roll archive](https://www.nps.gov/grca/learn/photosmultimedia/b-roll_hd_index.htm) say so. Neither agency endorses Mr. Streamer, and the captures show neither's emblem. The original sound of both clips is left out.

## What the scripts do

`marketing-demo.ts` cuts three things from the downloads:

- `earth-loop.ts`, two minutes of Earth as H.264 with silent AAC sound, in an MPEG-TS file. Every channel plays it.
- `canyon-hours.mkv`, thirty seconds of the canyon as H.264, with two generated AAC sound tracks marked English and Dutch and two SubRip subtitle tracks in the same languages. ffprobe has to find exactly those tracks.
- Stills of the same canyon clip for the series' poster, backdrop and episodes.

It also starts the made-up subscription, on loopback ports of its own:

- The fake provider from the tests, unchanged, streaming the Earth loop through its `streams` option.
- An adapter in front of it. The app logs in to the adapter. It lists the manifest's eight channels and seven series under the fake provider's ids, answers the guide, and serves the episode's file by byte range. Channels with `catchupDays` in the manifest say they keep that many days of catch-up, for the grid's signs and Play from start; the adapter serves no recording.
- The fake TMDB behind a wrapper that answers with the manifest's names, stories and credits. The app reaches it through `MR_STREAMER_TMDB_API` with a made-up key.

`marketing-capture.ts` starts the development build with a throwaway profile and update checks off, then drives it through its DevTools port as a viewer would:

1. Logs in through the form.
2. Opens Canyon Hours and captures its details.
3. Plays the first episode, turns on English subtitles, selects Higher under Position, opens the subtitle panel and captures the actual active cue.
4. Leaves the actually played episode, which seeds Continue watching and recommendations through normal viewing history.
5. Stars two channels in Live TV, watches one and captures Live TV.
6. Opens the guide grid from **Guide**, presses Left until the first channel's selected programme has aired, requires Play from start before Watch live and a catch-up sign beside every channel the manifest gives catch-up, and captures the grid. **List** goes back.
7. Watches another channel, goes Home and requires the permanent actions, Continue watching and the recommendation naming the actual seed before capturing. Opens Customize for additional ignored native proof.

Each capture is the page of the window, taken with `Emulation.setDeviceMetricsOverride` at 1280 × 800 and a scale of 2, then `Page.captureScreenshot`. `Emulation.setScrollbarsHidden` keeps scroll bars out of it, as on a Mac, where they show only while scrolling. A page capture doesn't include the window's buttons. Home, Live TV, the guide grid and the details are captured in full screen, where the top bar keeps no room for those buttons. The episode is captured in a window, because in full screen the player hides the top bar.

The app's pictures never come from the network. The script answers the image addresses the demo hands out from the page's DevTools session, with the canyon stills and drawn artwork, and refuses any other remote image.

A capture is written only once it holds what it should: the right size, the names and tracks on screen, a decoded picture where the video is, and for the episode the subtitle "By evening, the colours change again." still showing after the capture was taken. The clock times in the captures are the moment you ran it.

The script verifies the owned CDP arguments and renderer URL, then retains raw page PNGs, accessibility trees, native window PNGs, actions, version/platform/source, main bundle and media hashes in `.local/marketing-captures/capture-*/`. `marketing-capture.json` records the committed masters' dimensions, bytes and hashes with their source provenance. The script requests a graceful app exit, closes its fixture servers and CuaDriver session, and removes the temporary profile. It touches no other process.

## Before you commit new captures

- Look at all five files at full size. Check the names, the pictures and the subtitle against the manifest.
- Run `pnpm build:marketing` and look at the page on a wide screen and a phone. The hero fan and two features show parts of the windows, set in `CUTS` in `prepare-assets.ts`. If the app's layout moved, move those parts with it and keep `index.html`'s sizes in step. Regenerate the README's poster with `--readme` and look at it too.
- Put the new files' sizes in the pull request, each and in total. They are lossless and run to a few megabytes.

The original PR 208 captures were made on the Mac mini on 11 October 2026 from Personal Home source `7b54b5265a9a62c1b20ed890c012f2041baa443a`. Live TV, details and watching retain those masters and the manifest's original top-level provenance.

Home was replaced on 12 October 2026 from merged Stage source `5db40b13ec7b3bf7a39781a71363f4fb17f2ad6d`, tree `c7d534d273b787d20d4728db6660f40857052bd0`. Its entry records the new capture provenance. This unsigned source build reports 0.0.10 on macOS 27.0.1, arm64 and Electron 44.4.5; it is not an installed 0.0.11 release. Exact capture, bundle and master hashes are in `marketing-capture.json`.

The TV Guide was added on 14 October 2026 with `--only tv-guide` on the Mac mini, with this capture script and demo manifest (their hashes are in its entry). Its `appSource`, `7bfb1a0f`, is this branch before its commits were squashed; its app code is that of `401072a16537c8b57658776440463656339cf0cc`. That unsigned source build reports 0.0.12 on macOS 27.0.1, arm64 and Electron 44.4.5. Its phone asset is 632 × 564 points at 250,236: the catch-up signs, the open programme with Play from start, and the now line.

The cuts are in points of the 1280 × 800 window. A phone's hero shows the Home stage, 574 × 540 at 16,56: the stage preview, favourites and the start of Continue watching. The Live TV/TV Guide fan layers and details use one 6:5 shape: Live TV 600 × 500 at 236,56, the TV Guide 600 × 500 at 246,236 with the catch-up signs and the open programme, the details 600 × 500 at 174,60, and watching 884 × 737 at 396,42, keeping the real subtitle beside the right-hand panel. The 1200 × 630 social asset fits the complete Home window instead of cutting off the recommendation reason. All assets derive from captured pixels; never paint missing UI into a capture.
