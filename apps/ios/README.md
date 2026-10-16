# Mr. Streamer for iOS

React Native on Hermes (Expo SDK 58), building toward the desktop app's features. It shares
`@mrstreamer/contracts` and the parts of `@mrstreamer/core` that run without Node, and brings its
own native adapters: the Keychain, app storage and one native player so far. Nothing of it is in
the desktop's install, build or packages.

So far it connects one Xtream subscription. Live plays channels; Films and Series browse the
desktop's collections (For you, New, Genres, Services, 4K and All) and open details pushed on
their tab, with seasons and episodes, the version menu, the watchlist and episodes marked by hand.
A movie or an episode plays in Watch from where it stopped, and Home shows Continue watching and
the watchlist; Search finds films, series and channels. Downloads are a route that says they
aren't on iPhone yet, and the details' Download button is shown disabled. What the desktop does
and iOS doesn't yet is tracked in the parity report on the iOS card.

## Its own install

`apps/ios` is left out of the root workspace and has its own `pnpm-workspace.yaml` and lockfile,
so React Native never changes what the desktop installs. The shared packages are linked as source;
`metro.config.cjs` resolves their imports (arktype, effect) from this app, one copy of each, so
keep those two at the versions the root lockfile holds. Native modules are pinned to the versions
`expo@58.0.9` bundles (`node_modules/expo/bundledNativeModules.json`), not to what `expo install`
or the registry offers later, and the workspace doesn't install peers on its own, so only the
native modules named in `package.json` are linked into the build.

```sh
cd apps/ios
pnpm install --frozen-lockfile
../../node_modules/.bin/tsc --noEmit -p . && ../../node_modules/.bin/tsc --noEmit -p scripts
```

Expo SDK 58 is a prerelease (React Native 0.88 release candidate). It is the first SDK whose
template adopts the UIScene life cycle, without which an app built with the iOS 27 SDK stops at
launch. `patches/` adds `URL.parse` and `URL.canParse` to React Native's type of the global `URL`:
at runtime Expo installs a WHATWG `URL` that has both.

Xtream stream addresses carry the username and password in their path, so they stay out of logs
and failures. `patches/` changes expo-video's warnings, which named the address and printed the
whole error with it, to name an error by domain and code only, and describes its asset without
its address, which AVKit's logs print. The player's failures reach the screen through
`withoutLogin` (`src/errors.ts`). SDK 58 links prebuilt modules, which a patch can't reach, so
`package.json` has autolinking build ExpoVideo from its patched source.

## How it is built

Each responsibility has one owner, a plain module with a store the screens read:

- `src/account.ts`: the subscription and its live catalogue. It signs in with core's Xtream
  adapter (shared with the desktop), loads and reloads the channel list, cancels a load the
  viewer moved past, and disconnects. A sign-in overtaken by a newer one or by Disconnect saves
  nothing and signs nothing in.
- `src/library.ts`: the catalogue as the screens show it, by core's names, quality grouping and
  country rules.
- `src/titles.ts`: the movie and series lists through the same adapter, indexed by core's
  `indexCatalogue` (each kind in a task of its own, so input is handled between them), core's
  collections and search, details with TMDB's facts, and the file each title streams from.
  TMDB's metadata comes from core's store (`metadata/store.ts`, shared with the desktop) and is
  kept in Caches.
- `src/viewing.ts`: how far titles got, episode marks and Continue watching: core's
  `ViewingRecord` service over core's in-memory store, its snapshot in `viewing.json`.
- `src/watchlist.ts`: saved movies and series in `watchlist.json`, by core's watchlist rules.
- `src/playback.ts`: the one `expo-video` player and what it plays, a channel or a title. Home's
  preview, Watch, Picture in Picture and the accessory all show or control this player; none
  opens a stream of its own. Another channel or title, Stop, Disconnect and a failure each let go
  of the stream. `src/play-title.ts` plays movies and episodes in it, saving how far they got.
- `src/storage.ts`: what the app keeps between launches, apart from secrets, in one JSON file in
  Documents: the subscription's server and username, recent channels and the Live country.
  `src/files.ts` writes the viewing record and watchlist files whole, through a file beside them.
  Disconnect erases both.
- `src/secrets.ts`: passwords in the Keychain. Keychain items outlive the app, so the first launch
  after installing removes what an earlier install left there, by an index of the ids it wrote;
  writes, removals and clearing run one at a time so none loses another's change to the index.

Routes are in `src/app` (Expo Router): `(tabs)` are the system's native tabs, Home's Downloads and
Settings are pushed from its top bar, and `connect` shows until a subscription is signed in.
Watch (`src/watch.tsx`) is a layer over the navigation rather than a route, because the view that
starts Picture in Picture has to stay while it plays. `src/glass.tsx` draws the app's own controls
as Liquid Glass, and solid before iOS 26 or with Reduce Transparency on.

Live channels are asked for as HLS, which AVPlayer plays and panels serve beside MPEG-TS. On the
simulator the fixture channels showed what that covers: H.264 with AAC or AC-3 plays; MPEG-2 fails
with "Cannot Decode"; HEVC in MPEG-TS segments plays its sound without a picture. The formats the
desktop converts with ffmpeg don't play yet.

Titles are tried whatever their file type: a version that fails says so in Watch and in its
details, and the version menu marks it and offers the others. On the simulator, H.264 with AAC in
MP4 played (also behind an address ending in .mkv); the test MKV with E-AC-3 and subtitles failed
with "Cannot Open"; the test AVI (MPEG-4 Part 2, MP3) ran to its end without a picture.

TMDB's key is built in from `EXPO_PUBLIC_TMDB_KEY` (`EXPO_PUBLIC_TMDB_API` points at a test
server). Without one, collections that need TMDB are left out, details show the provider's
facts, and Settings shows no attribution.

## What Hermes lacks

The shared rules use some JavaScript that Hermes on iOS doesn't have or gets wrong.
`src/polyfills.ts` installs what the runtime proof showed missing, before anything else loads:
`Intl.Locale`, `PluralRules`, `ListFormat`, `DisplayNames` and `NumberFormat` (FormatJS, with the
interface languages' data) and `Array.prototype.toSorted` and `toReversed` (core-js). Still
missing and not polyfilled: `Buffer`, so `core/guide/xmltv` can't load, and `crypto.randomUUID`
and `crypto.subtle`, which `core/guide/address`, `service`, `ondemand/files` and
`playlist/import` take from `node:crypto`.

## On the simulator

On the workbench, with the Mac mini's simulator (see the `mac-mini` skill). The fixture panel is
the desktop tests' fake Xtream provider with live HLS in front, its movie and series files and a
fake TMDB under `/tmdb/3`; log in to `http://127.0.0.1:8791` as `fixture` / `fixture-pass`.
`FIXTURE_TITLES` sizes the movie and series lists. Its control port (8792) stays on the workbench
and makes the catalogue, a channel or title files fail, or holds movie and series details back to
try what a slow panel does; see `scripts/fixture-server.ts`.

```sh
node scripts/fixture-server.ts 8791 8792
node scripts/proof-server.ts 8790
REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_PROOF_URL=http://127.0.0.1:8790 \
  EXPO_PUBLIC_TMDB_KEY=fixture EXPO_PUBLIC_TMDB_API=http://127.0.0.1:8791/tmdb/3 \
  ./node_modules/.bin/expo start --port 8197 --clear
onmac tunnel 8197 8791 8790
onmac run -- zsh -c 'cd apps/ios && pnpm install --frozen-lockfile && npx expo run:ios --device <udid> --no-bundler'
ssh mac-mini xcrun simctl launch <udid> app.mrstreamer.player -RCT_jsLocation 127.0.0.1:8197
```

The build has no development client, so a deep link doesn't tell it where Metro is: launch it
with `-RCT_jsLocation`, at the port Metro advertises, which its lazy chunks use too. `app.json`
turns off Expo's tsconfig `paths` support, which the app doesn't use: it followed `extends` above
`apps/ios`, outside what Metro watches, and failed the first bundle after every start with
"Failed to collapse". Metro on the workbench has served transforms of files as they were before
an edit, so start it with `--clear` before taking evidence, and check the code that runs.

To check that no login reaches a log, start the panel with canary credentials, distinctive and
with characters an address encodes, sign in with them and make streams fail (the control port's
`fail-live` and the offline channel), then scan Metro's output, the app's stdout and stderr and
the simulator's unified log (`xcrun simctl spawn <udid> log show`). UI automation through XCTest
logs the accessibility values it reads, the username field's among them, under
`com.apple.dt.xctest`; leave those entries out of the scan.

```sh
FIXTURE_USERNAME='cnry Usr7Kq' FIXTURE_PASSWORD='cnry+Pw@9&Zq' node scripts/fixture-server.ts 8791 8792
node scripts/log-scan.ts 'cnry Usr7Kq' 'cnry+Pw@9&Zq' metro.log unified.log
```

## Runtime proof

`src/proof/` runs shared rules on Hermes, and `scripts/proof-server.ts` runs the same cases in
Node and compares them. Each area in `src/proof/groups/` loads on its own, so a module that fails
on Hermes fails only its group. It is a development screen, Runtime proof, linked from Connect and
Settings, so the guide group that fails on purpose never runs at launch. Each run sends one
report; receipts go to `.local/ios-proof/` at the repository's root. A release build leaves the
proof out: `src/app/proof.tsx` loads it only in development.

## For TestFlight

The app installs as `app.mrstreamer.player`, the desktop's `appId`, in development and release
builds alike. Its version is its own, not the desktop's: `version` in `app.json` is `0.1.0` for
the private beta, and `ios.buildNumber` goes up by one for every upload, because App Store Connect
refuses a build number it has seen.

Xtream panels are mostly plain `http://` servers at whatever address the viewer types, so
`app.json` lets the app load from any host without HTTPS. Expo's template allows local networking
only, and while that key is there iOS ignores the wider one: a panel over `http://` fails to load
on an iPhone. App Review will want a reason for this exception; internal TestFlight testing has no
review. `ITSAppUsesNonExemptEncryption` is false, because the app's only encryption is the
system's HTTPS and Keychain, so uploads skip the export compliance question.

The icon, `assets/icon.png`, is the desktop's Store tile at 1024 px, rendered with the desktop's
icons by `pnpm icons:export` in `apps/desktop`.

The build runs on the Mac mini from a committed checkout:

```sh
onmac run -- apps/ios/scripts/testflight.sh archive
onmac run -- apps/ios/scripts/testflight.sh upload
```

`archive` generates the native project and archives a Release build with its JavaScript inside,
so it runs without Metro, the fixtures or a launch argument, then prints the commit, identifier,
version and build it archived. `upload` sends that archive to App Store Connect for internal
testers only. The app's record has to exist there first; the API can't create one.
