# Development

Needs Node 24 and pnpm 11. `package.json` lists every script.

```sh
pnpm install
pnpm dev          # the app with hot reload
pnpm knip         # unused files, exports and dependencies
pnpm lint         # oxlint
pnpm fmt:check    # Prettier
pnpm typecheck    # main, preload and shared code, then the renderer
pnpm test         # Vitest
pnpm build        # production bundles in apps/desktop/out/
```

The repository is a pnpm workspace: the app is `apps/desktop`, the website is `apps/marketing`, shared contracts and rules are in `packages/`; [architecture](architecture.md) shows the layout. `pnpm dev:marketing`, `pnpm build:marketing` and `pnpm preview:marketing` run the website, which [its README](../../apps/marketing/README.md) describes. The scripts above run from the root. If `pnpm dev` reports that Electron failed to install, as a fresh install from pnpm's store can leave it, run `node node_modules/electron/install.js`.

## Running the app

Live TV works without a subscription: on the Connect screen, choose **Use an M3U link** and paste iptv-org's public playlist, `https://iptv-org.github.io/iptv/index.m3u`. [Testing](testing.md#a-real-provider) says what it covers and how to read a channel that fails. Movies and series need a provider that offers them, through an Xtream Codes login. If you use your own subscription, keep its details out of the repository: the gitignored `.local/` folder is the place for private notes and test access.

Genres, streaming services and popularity in Movies and Series come from TMDB. A development build has no key built in: set `MR_STREAMER_TMDB_KEY`, or paste one in Settings > General with **Own key…**. A free TMDB account gets one.

Streams the player can't decode go through ffmpeg, and every movie and episode goes through ffprobe and ffmpeg (see [architecture](architecture.md#playback)). Development builds use the `ffmpeg` and `ffprobe` on your PATH (`brew install ffmpeg`, `apt install ffmpeg` or `winget install Gyan.FFmpeg`); packaged builds use their bundled copies.

Playing on a TV uses Google Cast on Windows and AirPlay on macOS (see [architecture](architecture.md#receivers)). Cast needs nothing built. AirPlay needs the helper: `apps/desktop/scripts/build-airplay-helper.sh mac-arm64` on a Mac with Xcode's command line tools puts it in `apps/desktop/vendor/airplay`, where `pnpm dev` and `pnpm dist:mac` find it; without it a Mac build offers no output button. The ffmpeg on your PATH needs the `segment` muxer, which the usual builds have.

Environment variables for testing:

| Variable                    | Effect                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MR_STREAMER_FFMPEG`        | The ffmpeg to convert streams with, in development and packaged builds; its ffprobe must sit beside it. The tests and the marketing capture scripts read it too. |
| `MR_STREAMER_UPDATE_FEED`   | The update feed to read instead of the published one; see [releasing](../maintainers/releasing.md#testing-updates-against-another-feed).                         |
| `MR_STREAMER_UPDATE_API`    | A GitHub-compatible API for when the feed is missing, instead of `https://api.github.com`.                                                                       |
| `MR_STREAMER_UPDATE_CHECKS` | `off` stops the automatic update checks; checking from Settings still works. The packaged-app test and the measurements set it.                                  |
| `MR_STREAMER_TMDB_KEY`      | A TMDB key or read access token. At build time it's built into the app; at run time it replaces the built-in one. A key set in Settings still comes first.       |
| `MR_STREAMER_TMDB_API`      | A TMDB-compatible API instead of `https://api.themoviedb.org/3`, such as the tests' fake.                                                                        |
| `MR_STREAMER_CAST`          | `on` offers Google Cast on macOS and Linux too, where nobody has tried it.                                                                                       |
| `MR_STREAMER_AIRPLAY_LOG`   | `1` prints what the AirPlay helper says to the terminal: the record of what a receiver did.                                                                      |

## Installers

Each installer builds on its own system; the [release workflow](../maintainers/releasing.md) builds all of them. The bundled ffmpeg comes first:

```sh
apps/desktop/scripts/build-ffmpeg.sh mac-arm64   # or linux-x64, win-x64
pnpm dist:mac                                    # or dist:win, dist:msix, dist:linux; installers land in apps/desktop/dist
```

`build-ffmpeg.sh` needs a C compiler, make, nasm, pkg-config, Meson, Ninja, git and curl. On Windows, open an MSYS2 **UCRT64** shell and install the build tools there:

```sh
pacman -S --needed make git curl mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-nasm mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-meson mingw-w64-ucrt-x86_64-ninja
```

The script rejects other MSYS2 environments and checks that GCC uses UCRT headers. FFmpeg, x264 and dav1d are built together with that toolchain; MinGW-w64 support libraries and winpthreads link statically, while Windows provides UCRT. [MSYS2 recommends UCRT64](https://www.msys2.org/docs/environments/) and deprecated MINGW64 on 15 March 2026. Linux can still cross-compile the Windows build with mingw-w64 for local diagnostics; its README records the compiler's actual C runtime, which may be MSVCRT. Release Windows binaries are built natively in UCRT64.

The script puts `ffmpeg`, `ffprobe` and their licences in `apps/desktop/vendor/ffmpeg/<target>`, which electron-builder copies into the app. `README.txt` records all three build configurations, the compiler, assembler, Meson, Ninja and C runtime; native Windows builds also record the installed MSYS2 build-tool and UCRT64 package versions. Run `node apps/desktop/scripts/verify-ffmpeg.ts <target>` before packaging. It checks the actual tools, decodes the committed VP8, 10-bit VP9 and 10-bit AV1 fixtures, converts them to H.264, and decodes every output frame. CI runs it on cold and cached builds and retains the binary hashes and results. Without the binaries, the app still builds, but streams that need converting, and every movie and episode, report that they can't be played.

A Mac build signs with a Developer ID from your keychain when one exists and notarizes when `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set; see [signing](../maintainers/signing.md). Without a Developer ID, `apps/desktop/scripts/mac-ad-hoc-sign.ts` seals the app ad hoc, so a downloaded copy opens once through System Settings > Privacy & Security > Open Anyway instead of being called damaged.

## Third-party notices

Settings > About lists what the installers ship and under which licences. `pnpm build` writes the list to `apps/desktop/out/licences/third-party.json`, which electron-builder packages with the rest of `out/`. `apps/desktop/scripts/licences.ts` takes the packages whose modules ended up in the main, preload and renderer bundles, whether dependencies or devDependencies, reads their LICENSE, NOTICE and COPYING files, and adds what `apps/desktop/licences.config.json` describes:

- `packages`: packages the installers carry without a bundled module. Electron, and Tailwind for the base styles in the CSS.
- `overrides`: help for a package, with a `why`. `licence` for one that declares none, `files` to show instead of its own, or `standardText` to add the licence's standard text from `apps/desktop/licences/standard`, for a package without a licence file (with the author from its package.json) or with a notice that only refers to its licence.
- `embedded`: packages built into another package's prebuilt files and not installed, which the source maps reveal, under that package's `name@version`. Upgrading it fails the build until someone checks the entry and renames it.
- `components`: Chromium, its FFmpeg, Node.js, Microsoft's Direct3D files in Electron's Windows build, FFmpeg, x264, dav1d, the MinGW-w64 runtime that the Windows ffmpeg links in, NSIS and the plug-ins of the Windows setup program, and Mr. Streamer itself, with the GPL-3.0 text from the repository's `LICENSE`. `{app}` is the version being built, `{FFMPEG_VERSION}`, `{X264_COMMIT}` and `{DAV1D_VERSION}` come from `build-ffmpeg.sh`, `{electron}` and names such as `{CHROMIUM_FFMPEG_COMMIT}` come from `reviewed`, and the app fills `{chrome}` and `{node}` from the Electron it runs on.
- `exceptions`, on a component only: licences in its `licence` that `COMPATIBLE` doesn't list, each with the reason the installers carry the component anyway. Three components have one: Microsoft's files, which aren't open source, and two NSIS plug-ins that come without licence terms. The rest of the expression is still checked, and a package in the bundles can't take an exception.
- `reviewed`: the one version of Electron and of electron-builder that the notices and sources were checked for, with the facts recorded for it under `pins`, such as Chromium's FFmpeg revision. Under any other version the build fails; [licences](../maintainers/licences.md#upgrading-electron-or-electron-builder) has the steps of an upgrade.
- `sources`: the source archives every release attaches, each a download with its SHA-256 or a repository with a full commit hash. `apps/desktop/scripts/release-sources.ts` prepares them; see [licences](../maintainers/licences.md#sources-on-every-release).
- `installer`: the plug-ins NSIS puts in the Windows setup and in its uninstaller, by SHA-256. `apps/desktop/scripts/installer-plugins.ts` checks a built setup against it.

The build fails and lists every problem when a package declares no licence, has no licence file and no override, refers to Apache-2.0, the GPL or the LGPL without including its text, carries a package that is neither installed nor under `embedded`, or uses a licence missing from `COMPATIBLE` in `scripts/licences.ts`. Read a licence's terms before adding it there. It also fails when Electron or electron-builder isn't the version under `reviewed`, when a notice links a file on the app's release that `sources` doesn't list, and when `sources` lists a file no notice links.

Chromium's credits, which hold Node.js's licence too, are 20 MB of HTML from Electron's download: next to the executable on Linux and Windows, in the app's Resources on macOS, where `apps/desktop/scripts/mac-credits.ts` moves them. The main process turns them into plain text when the UI asks for Chromium or Node.js. `pnpm dev` serves the renderer instead of bundling it, so development shows the notices of the last `pnpm build`.

`pnpm build` also builds in the commit it comes from, `git rev-parse HEAD`, as `__BUILD_COMMIT__`. Settings > About links to that commit as the build's source. Outside a git checkout of this repository, such as an unpacked source archive, it's empty and About links only to the repository.

## Artwork

- App icons come from `apps/desktop/assets/brand/`; `pnpm --filter mrstreamer icons:export` renders `apps/desktop/build/icon.*` from `icon.svg` and the Store package's logos in `apps/desktop/build/appx` from `mark.svg` ([releasing](../maintainers/releasing.md#microsoft-store-package) lists them).
- The DMG window background is `apps/desktop/build/dmg-background.png` and its `@2x` twin; `pnpm --filter mrstreamer dmg:background` renders them on a Mac, so the text uses the system font.
- The README poster and light/dark marks come from the committed marketing captures and brand artwork. [Marketing artwork](marketing-artwork.md) describes how to regenerate them and records the sources. Never use a real provider's catalogue, posters or private media.
- The website's pictures, `docs/assets/marketing-*.png`, are captures of the whole window at 2560 × 1600, taken on Linux by `apps/desktop/scripts/marketing-capture.ts` against a made-up subscription and public-domain footage. [Marketing artwork](marketing-artwork.md) has the recipe and the sources.
