# Mr. Streamer for iOS

React Native on Hermes (Expo SDK 58), building toward the desktop app's features. It shares
`@mrstreamer/contracts` and the parts of `@mrstreamer/core` that run without Node, and brings its
own native adapters: the Keychain, app storage and one native player so far. Nothing of it is in
the desktop's install, build or packages.

So far it connects one Xtream subscription and plays live channels: Home with its preview, Live,
Search for channels, and Watch. Films, Series and Downloads are in place as tabs and routes that
say they aren't on iPhone yet. What the desktop does and iOS doesn't yet is tracked in the parity
report on the iOS card.

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
- `src/playback.ts`: the one `expo-video` player and what it plays. Home's preview, Watch,
  Picture in Picture and the accessory all show or control this player; none opens a stream of
  its own. Another channel, Stop, Disconnect and a failure each let go of the stream.
- `src/storage.ts`: what the app keeps between launches, apart from secrets, in one JSON file in
  Documents: the subscription's server and username, recent channels and the Live country.
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
the desktop tests' fake Xtream provider with live HLS in front; log in to
`http://127.0.0.1:8791` as `fixture` / `fixture-pass`. Its control port (8792) stays on the
workbench and makes the catalogue or a channel fail; see `scripts/fixture-server.ts`.

```sh
node scripts/fixture-server.ts 8791 8792
node scripts/proof-server.ts 8790
REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 EXPO_PUBLIC_PROOF_URL=http://127.0.0.1:8790 \
  ./node_modules/.bin/expo start --port 8197
onmac tunnel 8197 8791 8790
onmac run -- zsh -c 'cd apps/ios && pnpm install --frozen-lockfile && npx expo run:ios --device <udid> --no-bundler'
ssh mac-mini xcrun simctl launch <udid> app.mrstreamer.player.dev -RCT_jsLocation 127.0.0.1:8197
```

The build has no development client, so a deep link doesn't tell it where Metro is: launch it
with `-RCT_jsLocation`, at the port Metro advertises, which its lazy chunks use too. `app.json`
turns off Expo's tsconfig `paths` support, which the app doesn't use: it followed `extends` above
`apps/ios`, outside what Metro watches, and failed the first bundle after every start with
"Failed to collapse".

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
report; receipts go to `.local/ios-proof/` at the repository's root.
