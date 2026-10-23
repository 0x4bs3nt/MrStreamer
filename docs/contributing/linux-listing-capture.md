# Linux listing screenshot candidates

These are source-build candidates for the artwork card's desktop 0.0.19 work. They were recaptured after integration at `384840f83b4be4fd6fd8d8693a8578d426418279`, using Electron 44.9.3. The development manifest still reports **0.0.18**. They need final artwork acceptance before listing use and do not establish an installed Flatpak, native GPU, audible audio or compositor acceptance.

The [Flathub quality guidelines](https://docs.flathub.org/docs/for-app-authors/metainfo-guidelines/quality-guidelines#screenshots), checked 23 October 2026, ask for unedited Linux app windows with native decoration, shadow and corners, default settings, English language tags, useful content and brief external captions. The suggested window limit is 1000 × 700, or twice that for HiDPI. Do not crop, add text, graphics or decoration after capture.

The current portable Openbox session has no compositor. It retains the actual app controls and any manager frame, but supplies no shadow, transparent padding or rounded outer corners. **Flathub's shadow/corner quality check remains unmet.** Preserve these honest candidates; recapture using a native Linux desktop window screenshot tool with compositing before claiming that check passes. Never synthesize missing shadows or reuse Mac masters.

## Prepare local tools

Use Ubuntu 24.04 amd64 with Node 24+, the pinned pnpm, Xvfb, ImageMagick `import`, `wmctrl`, ffmpeg/ffprobe and fontconfig. This recipe downloads and extracts tools only inside ignored `.local/`. It does not install packages, run package scripts, change global configuration or start host services.

```sh
mkdir -p .local/linux-capture-tools .local/verification/linux-listing
cd .local/linux-capture-tools
apt-get download openbox libobrender32v5 libobt2v5 libstartup-notification0 \
  libxcb-util1 libpangoxft-1.0-0 libxft2 libimlib2t64 x11-utils
for package in *.deb; do dpkg-deb -x "$package" root; done
cd ../..
```

Retain package versions and SHA-256 hashes with the evidence. The capture records the executable hashes and Openbox/ImageMagick versions. Other distributions may require different portable libraries; do not use this recipe to change the host.

## Build and capture

```sh
pnpm install --frozen-lockfile
# Explicitly disable production analytics in this source build.
MR_STREAMER_ANALYTICS_RELEASE_BUILD=0 pnpm build \
  > .local/verification/linux-listing/build.log 2>&1
pnpm verify:desktop doctor > .local/verification/linux-listing/doctor.json
node apps/desktop/scripts/marketing-demo.ts --cache-dir .local/marketing-media
node apps/desktop/scripts/marketing-capture.ts \
  --linux-listing --linux-tools .local/linux-capture-tools/root \
  --cache-dir .local/marketing-media --only library,watching,tv-guide,home
```

Do not prefix this command with `xvfb-run`: the Linux mode owns its display, chooses a free display number and starts its own Openbox. It uses the extracted default Openbox configuration and the system's default font. It resizes the actual unmaximized app window to 1000 × 700 without renderer device emulation or scrollbar hiding. Existing marketing capture commands and `--only` behavior remain available.

The existing `capturePlan`, UI driver, invented manifest, fake provider/TMDB, image interception and public-domain media preparation are reused. The app gets an isolated temporary automated profile and loopback services, with update checks off and ambient `MR_STREAMER_*` overrides removed. The source build has no production analytics configuration; automated/unpackaged sessions also disable production transport. Never use real provider accounts, stream URLs or a daily-driver profile.

Media preparation checks the original downloads before cutting clips. The Linux mode additionally requires both original files even when the derived cache already exists, checks their sizes and SHA-256 against `marketing-demo-sources.json`, and records the exact derived hashes. Retain downloads and clips in the ignored cache for recapture. If a download is interrupted, resume the documented URL into its `.part` file with `curl --continue-at -`, rename only after successful completion, then run media preparation again for its hash check.

## Outputs and review

`docs/assets/linux-listing/` contains unchanged native PNG bytes and `manifest.json`, with per-capture build, fixture, media, source, method, language, caption and limitation records. It never writes `marketing-*.png` or the marketing manifest. A partial `--only` run replaces only the requested Linux entries. No Flatpak build manifest is generated.

Each `.local/verification/linux-listing/capture-*/` retains raw native PNGs, window PID/XID/properties/geometry, CDP page PNGs and accessibility trees, action timestamps, app/profile/port/renderer identity, build hashes, fixture hashes, source media hashes, Electron/X session logs and cleanup results. Page PNGs are diagnostic evidence only. The committed files come directly from `import -silent -window <owned XID> -frame`; no image processing follows. Compare their hashes with the raw native PNGs, inspect every full-size candidate, then check that app, fixtures, profile, window manager and X server closed. Failed attempts remain evidence and do not qualify a candidate.

Captions and credits stay outside the images. Credit **NASA** for the Earth footage and **U.S. National Park Service** for the canyon footage wherever these candidates appear. Neither agency endorses Mr. Streamer. The original sound is omitted. The [demo source manifest](../assets/marketing-demo-sources.json) records original URLs, terms, cuts, invented names and subtitles; [marketing artwork](marketing-artwork.md#sources) explains the media. Use pinned commit URLs if these candidates are eventually referenced publicly. Listing/publication permission and Flathub review are separate.

## Baseline candidates, 23 October 2026

The integrated run is `.local/verification/linux-listing/capture-9m9nVu/`. All four PNGs are 1000 × 700, with no alpha, and total 1,121,427 bytes. Their hashes equal the raw native captures. The manifest records source `384840f8`, Electron 44.9.3, fixture/media/build hashes and external captions. Both original download hashes matched. Each full-size image was inspected. Cleanup passed for the app, profile, fixture servers, window manager and X server; the owned CDP port was closed. Earlier failed attempts remain evidence.

| Candidate      |   Bytes | Visible content                                                        |
| -------------- | ------: | ---------------------------------------------------------------------- |
| `home.png`     | 236,815 | Earth preview, favourites, Continue watching and recommendation reason |
| `tv-guide.png` | 159,980 | Live Earth preview, selected aired programme and Play from start       |
| `library.png`  | 257,772 | Canyon Hours details, Play/Download/Save and invented cast             |
| `watching.png` | 466,860 | Canyon footage, active English subtitle and subtitle panel             |

The compact views retain the app's real scrolling and ellipsis. In Watching, the full-window subtitle extends across the subtitle panel's boundary; the image preserves that current rendering. Details offers another candidate if that makes Watching unsuitable. The missing compositor shadow/padding/rounding still requires native desktop recapture. The integrated candidates await listing acceptance. Prefer Home, Guide and details while the existing Watching subtitle overlap remains visible.

The public manifest uses portable media basenames, a repository-relative evidence reference and OS/kernel/architecture without a host name. Full local paths remain only in the ignored raw receipts.
