# Mr. Streamer for iOS

React Native on Hermes (Expo SDK 58), building toward the desktop app's features. It shares
`@mrstreamer/contracts` and the parts of `@mrstreamer/core` that run without Node, and brings its
own native adapters: the Keychain, app storage and one native player so far. Nothing of it is in
the desktop's install, build or packages.

It connects Xtream subscriptions, one or several, and shows everything from all of them
together, as the desktop does: there is no subscription to switch to. Live opens on All, every
provider's channels of every country once, with their providers' logos; For you leads with the
channel watched last behind Play, then recent channels and category shelves, and Categories has
every category as a tile that opens its channels; a country is an optional filter before those
tabs (`src/live-screen.tsx`). Movies and Series browse the
desktop's collections (For you, New, Genres, Services, 4K and All) and open details pushed on
their tab, with seasons and episodes, the version menu, the watchlist and episodes marked by hand.
A version chosen from the menu plays again whenever the title opens, until Automatic is chosen; a
4K tile or Continue watching asks for its own version over it.
A movie or an episode plays in Watch from where it stopped. Home leads with the preview, then
channels to preview (On now: recent ones, else the country last chosen in Live), Continue watching, the watchlist
and Movies for you, which falls back to the provider's own list without TMDB. Rows show a
channel's category where the desktop shows its programme: iOS reads no guide yet. Search finds
movies, series and channels. A movie's details and each episode row have a download button whose
symbol is the download's state; Downloads lists the queue, then the copies on the phone, with
Cancel, Retry, Remove, Play offline and Delete as each state allows (`src/downloads-screen.tsx`,
`src/download-controls.tsx`). Play and Resume always stream; a copy plays offline from Downloads,
its menu and an episode's check. A download under way goes on in the background, but the next in
the queue starts only once the app is open again: not yet the desktop's queue. What the desktop
does and iOS doesn't yet is tracked in the parity report on the iOS card.

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

After shared package or export changes, also resolve and bundle the real iOS entry with Metro:

```sh
CI=1 pnpm exec expo export --platform ios --output-dir ../../.local/ios-export --max-workers 2
```

This export needs no native build or signing. It proves bundle resolution; native behavior still
needs a simulator or device run.

Expo SDK 58 is a prerelease (React Native 0.88 release candidate). It is the first SDK whose
template adopts the UIScene life cycle, without which an app built with the iOS 27 SDK stops at
launch. `patches/` adds `URL.parse` and `URL.canParse` to React Native's type of the global `URL`:
at runtime Expo installs a WHATWG `URL` that has both.

Xtream stream addresses carry the username and password in their path, so they stay out of logs
and failures. `patches/` changes expo-video's warnings, which named the address and printed the
whole error with it, to name an error by domain and code only, and describes its asset without
its address, which AVKit's logs print. The player's failures reach the screen through
`withoutLogin` (`src/errors.ts`). `patches/` also makes expo-file-system's two handlers of
background session wakes answer at once for a session not theirs: Expo calls the system's handler
only once every handler answered, and theirs would wait forever on the app's download session.

On iOS 26.1 and later react-native-screens 4.29.0 lost a tab the viewer picked whenever a React
commit landed between UIKit's `shouldSelectTab:` and `didSelectTab:`: the tab showed, but JS kept
the one before, so the tab took no touches and leaving a tab closed nothing. `patches/` carries
upstream's fix to `RNSTabBarController.mm`, unchanged: it marks the controller's own selections
instead of the viewer's. It is the v4 backport of
[#4862](https://github.com/software-mansion/react-native-screens/pull/4862),
97ec4e250282bf4bdf376da9cd293ee9dfb385da, which applies to 4.29.0 byte for byte, then the
follow-up [#4894](https://github.com/software-mansion/react-native-screens/pull/4894) (#4890),
23127222c39b6d44aded6ef11130a7513dbb2735, both in react-native-screens 4.30.0
([issue #4855](https://github.com/software-mansion/react-native-screens/issues/4855)). Drop it
once the SDK's react-native-screens is 4.30.0 or later.

SDK 58 links prebuilt modules, which a patch can't reach, so `package.json` has autolinking build
ExpoFileSystem, ExpoVideo and RNScreens from their patched source.

## How it is built

Each responsibility has one owner, a plain module with a store the screens read:

- `src/account.ts`: the saved subscriptions and their lists. It adds them (the provider checks
  the login before anything is saved; the same account added again updates the one saved),
  edits, retries and removes them, signs each in with core's Xtream adapter (shared with the
  desktop) and loads each one's channels, and its movie and series lists once its login is
  checked. Each has its own login, loads and failures: one that fails, reloads or is removed
  leaves the others as they were. Changes to the registry and the Keychain run one at a time.
  Its requests to the provider ask iOS's URL cache to keep nothing: the cache would store each
  answer on disk under an address carrying the login, and answer a later Connect or reload with a
  failure a panel allowed it to keep. The first private betas didn't ask, so
  `modules/forget-cached-logins` empties that cache once, at the first launch of a build that has
  it, before the app's JavaScript runs.
- `src/catalogue-cache.ts`: each subscription's last channel list and movie and series lists, in
  Caches, which backups leave out. A launch shows lists saved less than 12 hours ago as loaded and
  asks the provider for none, though the login is still checked; older ones show while they load
  again, and stay when that fails. Reload, Try again and an add always ask. `account.ts` decides
  all of that; this module only keeps the files, one operation at a time per list. A copy holds
  the fields the app reads, with artwork addresses that could carry the login as none, and isn't
  written when other text holds the password. Every row is checked on reading. A list may take
  64 MiB and 250,000 rows, every list together 256 MiB, the oldest movie and series lists going
  first. A new password or a removal deletes a subscription's copies first, and no write of the
  earlier login is saved after that.
- `src/startup.ts`: whether the app is still opening. A launch opens once every saved list has
  been read and the channels and the movie and series collections are worked out of those that
  show. A missing, unreadable or doubtful copy only ends that list's read, and a password the
  Keychain lost leaves that subscription with nothing to read; the other subscriptions' reads and
  views still hold the opening. With no subscription saved it opens at once. No login check or
  provider answer is waited for; a list a provider already gave is worked out with the rest.
  Until the app opens, `titles.ts` indexes no saved titles while others are still read, so two
  providers' saved lists are indexed once. If a disk read has not finished after 8 seconds, the
  app opens without it: the lists read by then are indexed and show, and the late one joins them
  when it answers. `src/startup-screen.tsx` covers the screens until then: iOS's launch screen
  (`expo-splash-screen`) and then the app's own copy of it at the same place, both drawing
  `assets/splash.png`, the approved artwork, kept as it is (nothing generates it), with "Opening
  your library" beneath after a second. Nothing on it moves.
- `src/details-cache.ts`: title and season details opened, in Caches/details. Each provider's
  facts of a title sit under its subscription; TMDB's about of a title and of a season are shared,
  as its list metadata is. `titles.ts` decides when one shows; this module keeps the files, one
  operation at a time per subscription. A record holds the fields the app reads, artwork addresses
  that could carry the login as none, and isn't written when other text holds the password. A
  record may take 8 MiB, every record together 64 MiB and 2,048 records, counted in the UTF-8
  bytes written with what writes under way have reserved, and a write left halfway that the disk
  won't delete counts too; the least recently written go first, up to 64 for one write, which
  isn't made when they don't make room. One older than 182 days isn't
  read. A new password or a removal deletes a subscription's records with its lists, and no write
  of the earlier login is saved after that. Launch reads no record: the budget is counted at the
  first write.
- `src/artwork-cache.ts`: channel logos and title pictures as files in Caches, so they show
  again after a relaunch and offline. React Native's Image only gets a file: its own loader would
  fetch through iOS's shared URL cache, which keeps answers on disk under their address. Pictures
  are fetched by expo-file-system's `DownloadTask` on its foreground session, which keeps no URL
  cache (`src/picture-transfer.ts`, which Downloads uses for a copy's pictures too), four at a
  time and one per address, for at most 15 seconds and 5 MiB each; a picture no one shows any more
  before its turn isn't fetched. The cache owns 160 MiB and 6,000 files, counting any it couldn't
  delete yet: a picture is let in once it fits, the least recently shown going first but never one
  showing, else it shows the fallback. One unseen for 60 days goes, and one fetched over 30 days
  ago is fetched again while it shows. A failed fetch, or a file that won't draw, shows the
  monogram or the title's name, and is tried again after five minutes or a relaunch. Only an
  address that gives away none of the logins signed in (`login-safety.ts`), while every login
  this process signed in still is, enters the index, which is checked again against each login
  signed in later. Any other picture is kept only for the session, in a folder the index never
  names and the next launch empties: an address carrying a login goes as soon as that login is
  replaced or removed, and after such a change, lists of the earlier login may still show, so new
  pictures wait for a relaunch to be kept. A download's own pictures stay in its folder.
- `src/subscriptions.ts`: the registry, `subscriptions.json`, and how private beta 2's one
  subscription in `state.json` becomes its first entry under the same id. Accounts removed with
  their history kept are remembered, so adding one again takes its id, and its history, back. Ids
  whose Keychain item an add or a removal was writing when the app stopped are listed, and the
  next launch removes those items; nothing else in the Keychain is touched. Ids removed with
  their history are listed until all of it is deleted: each launch deletes what is left, and no new
  subscription takes one of those ids.
- `src/sources.ts`: each subscription's provider adapter and login, apart from every store, so no
  screen, snapshot or failure holds a password. Requests go to the subscription that lists what
  they name (`OwnedId`), and a failure hides only that subscription's login.
- `src/library.ts`: every subscription's channels together, by core's names, quality grouping and
  country rules, and the desktop's way of combining them: categories of one name in one country
  are one, and a channel is never joined across subscriptions. Two channels of one name say which
  subscription each is from. Channels in no category their provider lists come last, as Other
  channels, or as All channels when none lists categories, so Live shows every channel the
  desktop does. Each subscription's share is kept until its list changes; a new list is worked
  out a few slices per task (core's `steps.ts`), so input is handled between them, while what
  showed before stays.
- `src/titles.ts`: every subscription's movie and series lists, indexed together by core's
  `indexSteps`, both kinds a few slices per task so input is handled between them, and shown only
  once finished: a movie two list under one TMDB id is one title with both versions, never by
  name. The provider reads each list's rows a few slices per task too. Core's collections and
  search, details with TMDB's facts, and the file each version streams from, asked of its own
  subscription. TMDB's metadata comes from core's store (`metadata/store.ts`, shared with the
  desktop) and is kept in Caches. Opened details are saved (`details-cache.ts`) and show again
  after a restart: a provider's facts without asking while younger than a day and its lists
  haven't come again, else while it is asked, replaced by its answer or kept when it fails; TMDB's
  likewise for 150 days, a day when TMDB didn't know the title, and a TMDB failure is asked again
  at the next open. The details screen shows what is saved at once, and the answers as they come
  (`read.ts`). Nothing of a login replaced or removed since shows. Where a title streams from is
  only ever asked of its provider under the current login, never read from a saved record.
- `src/viewing.ts`: how far titles got, episode marks and Continue watching: core's
  `ViewingRecord` service over core's in-memory store, its snapshot in `viewing.json`, one record
  per subscription under its id.
- `src/watchlist.ts`: saved movies and series, each subscription's record in `watchlists.json`,
  shown as one by core's watchlist rules. Beta 2's `watchlist.json` is read until the first change.
- `src/downloads.ts`: movies and episodes downloaded to the phone, as the desktop's downloads:
  `downloads.json`, a folder per download in `Documents/downloads`, and nothing else. One
  transfers at a time through `src/download-task.ts`, the app's own native owner of a background
  URLSession (`modules/background-downloads`), so the bytes never pass through JavaScript and a
  transfer goes on while the app is suspended and after iOS ends its process. The next download
  starts only while the app is open (AppState `active`). Each request is an attempt, written on
  its record before it starts; the native side moves only an authorized attempt's file into place
  and writes how each ended as a receipt, which `downloads.ts` takes in, then acknowledges. At
  launch nothing asks a provider for a file or a stream, and nothing is removed, until the
  subscriptions are read and every native request is accounted for: a queued download's request
  goes on as its transfer, any other is cancelled and has ended, and every receipt is taken in.
  Records hold no address, header, login or resume data; a file's address is made from its
  subscription's login as its transfer starts. A stream of the same subscription takes the
  connection back first (`onReclaim` in `playback.ts`): the transfer pauses before the stream's
  request goes out, and goes on once nothing of that subscription streams. A transfer that doesn't
  end within ten seconds fails the stream instead of opening a second connection. A provider takes
  a moment to free a closed connection, so a subscription's next request, a stream's, the next
  download's or a transfer's fresh start after its resumed request was refused, waits a second
  after the app's last one ended, and every subscription waits a second after launch when requests
  ended unheard. Resume data, which names the address, stays with the native side in the Keychain,
  from a pause or a broken request, and is used only for that same address; otherwise the transfer
  starts again and says so. A request that breaks while the app is open fails, and Retry goes on;
  one that breaks in the background goes on once the app is open. A user's force quit ends a
  transfer, as iOS does. Resume data beta 3 kept under `download:<id>` moves to the native side at
  launch. A copy is complete only once the native side moved it into place at the whole size the
  server announced; a file beside an unfinished download is deleted before it starts again. A
  removed subscription's unfinished downloads end, with their files and resume data; its copies
  stay, play from the phone with no login or network, and keep their own progress, also given to
  the subscription's viewing record while it is saved. A copy playing goes on when the last
  subscription is removed.
  `modules/downloads-folder` makes `Documents/downloads` at launch and keeps it out of backups;
  `modules/background-downloads` keeps its ledger in Application Support and its resume data in
  the Keychain, both readable after the first unlock (native: both take a new build).
- `src/playback.ts`: the one `expo-video` player and what it plays, a channel or a title. Home's
  preview, Watch, Picture in Picture and the accessory all show or control this player; none
  opens a stream of its own. Another channel or title, Stop, removing its subscription and a failure each let go
  of the stream. `src/play-title.ts` plays movies and episodes in it, saving how far they got.
  A title or copy in a file AVPlayer can't open, such as Matroska, plays through a format
  session (`src/title-formats.ts`, `modules/title-formats`): native code reads the file, from the
  provider over one request at a time or from the phone, and serves it to this player as HLS on
  127.0.0.1, its picture and each sound track copied as they are. Nothing of a new play reaches
  the provider until the last session's request has ended.
- `src/storage.ts`: what the app keeps between launches, apart from secrets and the registry, in
  `state.json` in Documents: recent channels by subscription, the country last chosen in Live for Home, the
  version picked in each title's details by subscription and TMDB id, as the desktop keeps them,
  and beta 2's subscription for an older build to show. `src/files.ts` writes every file whole, through a file
  beside it. Removing a subscription keeps its history unless the viewer deletes it too.
- `src/telemetry/`: product statistics, on until the viewer turns them off in Settings. One owner
  keeps the viewer's choice, a random installation id and a bounded outbox in `analytics.json`,
  and builds every event from fixed observations: the app's activity, the player's state and
  the screen on show. Events and properties are in `docs/telemetry.md`.
- `src/secrets.ts`: passwords in the Keychain. Keychain items outlive the app, so the first launch
  after installing removes what an earlier install left there, by an index of the ids it wrote;
  writes, removals and clearing run one at a time so none loses another's change to the index.

Routes are in `src/app` (Expo Router): `(tabs)` are the system's native tabs, Home, Live, Movies
and Series. Every screen of theirs has one top bar (`src/header.tsx`): the brand on the left, after
the back button on a pushed screen, and Search, Downloads and Settings on the right, less the
button of the screen it is on. Downloads, Settings and what Settings opens (`provider`, Add
provider or a provider's Edit; `licences` and a component's `licence`) are Home's screens, pushed
on the tab they were asked from (the other tabs' route files re-export them), and close as the viewer leaves that tab; Movies' and Series'
details under them stay. `search` opens over the tabs, fading in, and closes back onto the screen
it opened over; it keeps its text until the app ends, and says, above the keyboard (or atop the
results when too little room is left there), when the latest text is still being searched and which
providers' lists are still loading or failed. `connect` shows until a subscription is saved. With copies on
the phone, Connect also opens `offline`, the same Downloads outside the tabs, so copies play with
no provider saved, after a relaunch too. Connect and `provider` share `src/provider-form.tsx`. Settings lists each provider as a row with how it
stands; pressing one offers Retry, its reloads, Edit and Remove as a system sheet, and Remove asks
whether to delete its history too.
Watch (`src/watch.tsx`) is a layer over the navigation rather than a route, because the view that
starts Picture in Picture has to stay while it plays. Its Downloads and Settings open on the tab
under it, closing Search first if Watch came back over it (`openOnTabs` in `src/header.tsx`):
Picture in Picture takes what plays where it can, else Watch is set aside paused (`setAside` in
`playback.ts`) and the accessory brings it back, a title from where it paused and a channel live
again. With no provider saved there are no tabs and no accessory, so Watch offers only Downloads,
the offline list, and only while Picture in Picture can take the copy; a copy set aside when the
last provider is removed shows in Watch again as it stood. A movie or an episode turns it to
landscape (`expo-screen-orientation`); closing it unlocks again, and iOS turns the screens under it as the
phone is held. On the simulator the screens follow its device orientation (agent-device's
`orientation`), not where Watch left them. `patches/` makes expo-video report Picture in Picture
brought back to the app, which its own view never forwarded, and hold AVKit's answer until Watch
has shown the player again, so the picture returns into Watch rather than Home.
Watch's Audio and Subtitles list the tracks the player reports. Expo-video named a track by its
label and language alone, so English stereo and English surround were one track to it; `patches/`
gives each its place among what plays now as its `id`, and selects by it.
`src/glass.tsx` draws the app's own controls as Liquid Glass, and solid before iOS 26 or with
Reduce Transparency on. `src/loading.tsx` shows how lists stand, from what `account.ts` and
`titles.ts` hold: still shapes where content hasn't come yet, with a soft highlight crossing them
while the screen is in front, the app active and Reduce Motion off, and a status line in glass at
the bottom of the screen naming what loads for the first time or failed by provider, with Retry
and Settings, over content that stays usable. A list that loads again while its last one shows
says nothing.

Live channels are asked for as HLS, which AVPlayer plays and panels serve beside MPEG-TS. On the
simulator the fixture channels showed what that covers: H.264 with AAC or AC-3 plays; MPEG-2 fails
with "Cannot Decode"; HEVC in MPEG-TS segments plays its sound without a picture. The formats the
desktop converts with ffmpeg don't play yet.

Titles are tried whatever their file type: a version that fails says so in Watch and in its
details, and the version menu marks it and offers the others. Matroska (`.mkv`) goes through a
format session; everything else goes to AVPlayer as it is, as does a `.mkv` that turns out to be
another container. A session plays an H.264 or HEVC picture with AAC-LC, HE-AAC, AC-3, E-AC-3 or
MP3 sound, with its sound tracks to choose from, starting where the title stopped. A track that
ends early, pauses or starts late is silent there. One whose frames this can't make silent, such as
HE-AAC or E-AC-3 over 5.1, stops there with a message when chosen, and Try again goes on with the
main sound. A track AVPlayer doesn't play in HLS, such as AAC Main, or one that starts more than
five seconds after where playing starts, isn't offered. It needs the file's keyframe index
(Matroska's Cues) and doesn't serve subtitles; other Matroska files fail as files Mr. Streamer
can't play. `scripts/build-ffmpeg.sh ios` builds the FFmpeg libraries it links, before
`expo prebuild`; `modules/title-formats/reference` checks its segments on Linux. On the simulator
a Matroska file with H.264 and AAC played, over the network and as a copy, from where it stopped
and after seeks; the test AVI (MPEG-4 Part 2, MP3) ran to its end without a picture.

TMDB's key is built in from `EXPO_PUBLIC_TMDB_KEY` (`EXPO_PUBLIC_TMDB_API` points at a test
server). Without one, collections that need TMDB are left out, details show the provider's
facts, and Settings shows no attribution.

Settings' Privacy opens the privacy policy, `https://mrstreamer.app/privacy`, in the browser, and
About opens Licences: the app under GPL-3.0-only, then every component the build carries, each
with its licence, its exact source and its notices in full, read from `src/licences.json` with no
network. `scripts/licences.ts` generates that file from the release bundle's source map (the
JavaScript packages in it, and licence files of code they vendor), the native modules Expo links
and `licences/manifest.json`, which pins what isn't an npm package (FFmpeg with its configure
flags, Hermes and React Native's third-party pods) and texts packages were published without. A
package with no licence text, or a pin that no longer matches, fails it. Run it after a dependency,
patch or FFmpeg change and commit the result; `testflight.sh archive` runs it with `--check`
against the native project's `Podfile.lock` (`scripts/native-pods.ts`) and refuses a stale file,
a pod Licences doesn't describe, a manifest-pinned pod at another version than Licences shows, or
one inside the native project that React Native doesn't generate there.

## What Hermes lacks

The shared rules use some JavaScript that Hermes on iOS doesn't have or gets wrong.
`src/polyfills.ts` installs what the runtime proof showed missing, before anything else loads:
`Intl.Locale`, `PluralRules`, `ListFormat`, `DisplayNames` and `NumberFormat` (FormatJS, with the
interface languages' data) and `Array.prototype.toSorted` and `toReversed` (core-js). Still
missing and not polyfilled: `Buffer`, so `core/guide/xmltv` can't load, and `crypto.randomUUID`
and `crypto.subtle`, which `core/guide/address`, `service`, `ondemand/files` and
`playlist/import` take from `node:crypto`.

Hermes's array methods ignore `Symbol.species`, so an Array subclass's `map` returns a plain
Array. ArkType's intersection results are such a subclass, and it corrects this in one method but
not in `withPrefixKey`; `patches/` makes that one keep its class too. Without it, a union of object
schemas, as the statistics events are, fails to build on the iPhone with "undefined is not a
function". The root tests run on Node, which honours species, so only the app shows it.

## On the simulator

On the workbench, with the Mac mini's simulator (see the `mac-mini` skill). The fixture panel is
the desktop tests' fake Xtream provider with live HLS in front, its movie and series files and a
fake TMDB under `/tmdb/3`; log in to `http://127.0.0.1:8791` as `fixture` / `fixture-pass`.
`FIXTURE_TITLES` sizes the movie and series lists. Its control port (8792) stays on the workbench
and makes the channel lists, the movie and series lists, a channel or title files fail, or holds
movie and series details back to try what a slow panel does; see `scripts/fixture-server.ts`.
For measurements, `FIXTURE_PROFILE=measure` serves lists with known 4K titles and additions dated
from `FIXTURE_ANCHOR`, and `FIXTURE_LOGOS=png` lists raster channel logos; with it,
`FIXTURE_ART_CACHEABLE=1` lets caches keep them and `FIXTURE_ART_LOGIN=1` puts the login in their
addresses, for checking what the artwork cache keeps. A second panel, for several
providers, runs beside it on other ports with `FIXTURE_SECOND=1` and its own login, such as
`FIXTURE_SECOND=1 FIXTURE_USERNAME=second FIXTURE_PASSWORD=second-pass node scripts/fixture-server.ts 8793 8794`;
add it in Settings > Add provider at `http://127.0.0.1:8793`. Its channels have the first's ids.

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
