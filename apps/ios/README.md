# Mr. Streamer for iOS

React Native on Hermes (Expo SDK 58), building toward the desktop app's features. It shares
`@mrstreamer/contracts` and the parts of `@mrstreamer/core` that run without Node, and brings its
own native adapters: the Keychain, app storage and one native player so far. Nothing of it is in
the desktop's install, build or packages.

Try demo on the empty-roster Connect screen opens a labelled Demo provider. Personal providers can
be added alongside it afterwards. Demo needs no login or Keychain item. Its original generated movie
and two episodes use the ordinary catalogue,
player and download owners, with measured durations and no invented metadata. Files and artwork
come from the commit pinned in `src/demo.ts`; network failures are shown normally. The asset commit
must remain an ancestor of main at delivery. Live stays off pending broadcaster permission, and
the Guide demonstration remains unmet.

Settings' Demo row offers Reset demo data and Exit demo. Both remove only demo downloads, saved
lists, favourites, watchlist, history and progress. Reset starts a fresh Demo only after that erase
is established. A durable erasing marker retries unfinished work at launch; unreadable download
records or refused cache deletion keep removal incomplete. Files still read by a player or native
task stay until positive closure, even after reset. Personal providers, copies and history, media
preferences and analytics choices remain separate. Native playback, background/offline downloads,
the exact reviewer journey and public-review approval retain their own acceptance gates.

It connects Xtream subscriptions, one or several, and shows everything from all of them
together, as the desktop does: there is no subscription to switch to. Live opens on All, every
provider's channels of every country once, with their providers' logos; For you leads with the
channel watched last behind Play, then recent channels and category shelves, and Categories has
every category as a tile that opens its channels; a country is an optional filter before those
tabs (`src/live-screen.tsx`). Above them, Favourites opens every favourite channel of every
provider in one order (`src/favourites-screen.tsx`): a row plays in Watch, its star takes it out,
and Edit moves rows with Move up and Move down until Save or Cancel. Save sends the order only
while the favourites still show the rows it was made of; a list or a password that changed them
meanwhile moves nothing and says so. A Live row's star, and Watch's for the channel playing, star
or unstar the channel its provider lists now for the streams pressed, without playing anything, and
change nothing when that is no single channel any more. Both rows lead Live whatever its channels'
state: loading, failed or none. Under Favourites, Find
countries or categories (`src/live-discover.tsx`) finds them by name in every provider's
channels, whatever country Live shows: a country goes back to Live showing it, on the same tab; a
category opens all its channels, and Back finds the text and results again. Cancel leaves Live as
it was, and nothing found or opened plays. While a provider's channels are still to come, or
didn't load with none of them showing, finding nothing says whose are missing rather than that no
provider has the name. Movies and Series browse the
desktop's collections (For you, New, Genres, Services, 4K and All) and open details pushed on
their tab, with seasons and episodes, the version menu, the watchlist and episodes marked by hand.
All, 4K and pushed collections have one Sort & filter sheet with title counts, the shared
collection sorts, declared quality and file-language hints, and Reset. Combined filters must
match one listed version; opening a filtered tile asks for that version over a remembered pick.
A later manual version choice in details still wins. Choices stay per kind and collection for
the app session, including Back, and Reset restores that collection's default sort. Refreshes
update counts and options without clearing the choices. An empty filtered result keeps Reset;
an initial collection load failure keeps the controls and Try again. Known audio/subtitle choices
appear when current exact-file facts are available. Counts require one eligible file to match the
other filters too. Any known track clears only its own choice; Reset clears the collection choices.
Unknown track language stays Unknown, and an unnamed canonical language code stays distinct from it.
Unread files establish no absence. Filtering reads local facts without asking the provider or probing
media. Direct original AVPlayer reads of provider titles forward changed settled track facts;
format-session renditions, copies and channels establish none. Native acceptance remains pending.
A version chosen from the menu plays again whenever the title opens, until Automatic is chosen; a
4K tile or Continue watching asks for its own version over it. While a provider needs its
password, the version remembered from it and how far its versions got are left out of the
version details pick on their own, under Automatic too, and count again once the password is
back; a version asked for, or chosen in the menu while the details show, keeps its precedence.
A movie or an episode plays in Watch from where it stopped. Home leads with the preview, then
channels to preview (On now: recent ones, else the country last chosen in Live), Favourites (its
heading always there, opening the list on Home's stack: `favourites`), Continue watching, the watchlist
(its heading always there, opening all of it on Home's stack: `watchlist`)
and Movies for you, which falls back to the provider's own list without TMDB. Home's On now and
Stage and Live's channel rows use the same guide owner for actual now/next, local times and static
programme progress, retaining category fallback in gaps. Live adds Guide alongside For you,
Categories and All, with the country filter preserved. Channel taps still play in Watch; the
separate Schedule action opens a pushed day without playing. Home tiles still preview. Schedule
and programme routes stay on their originating Home or Live stack, retaining Back and browse
context. Day controls use each local date's first valid instant, including a skipped midnight,
page at most 128 programme rows with Show more, and inspect one opaque programme detail. Only
Watch live starts playback; there is no catch-up. Search finds
movies, series and channels: 20 movies and 20 series at first, each kind with its own Show more
for the next 20 until every match shows. A movie's details and each episode row have a download button whose
symbol is the download's state; Downloads lists the queue, then the copies on the phone, with
Cancel, Retry, Remove, Play offline and Delete as each state allows (`src/downloads-screen.tsx`,
`src/download-controls.tsx`). A series' details also offer Download remaining for the season shown
and Review series download for every season: after a system sheet with the exact counts, they queue
that version's episodes one at a time in the series' own order, specials included, retry failed ones
and replace a missing copy only when asked, never one Watch is playing. It goes on while Downloads
is opened over the details. Cancel remaining stops it before the next episode, as do closing the
details, another version, any version accepted in the menu, the same one included, and a new login
or the provider's removal; what was queued stays. An addition already asked settles, but a retry or
a missing copy's new addition is only written while the run still stands
(`src/series-download.ts`, `src/series-download-row.tsx`). Play and Resume always stream; a
copy plays offline from Downloads,
its menu and an episode's check. The native owner schedules the queue and hands the next background
task to iOS before answering a background wake. iOS can defer starts, and force quit ends transfers.
Actual background and physical-device acceptance remain separate from source and compilation checks.
What the desktop does and iOS doesn't yet is tracked in the parity report on the iOS card.

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

## Public catalogue policy

The public iOS app excludes recognised adult channels, movies and series. Provider adult flags
and the shared category-name recognition are authoritative for this classification. Movies and
series are filtered before indexing, so browse, Search, Continue watching and details share the
same permitted catalogue. Saved watchlist records are checked against current provider lists and
remember a recognised exclusion across later removals and relaunch. Ordinary versions remain
available when a provider marks another version of the same title.

Playback rechecks that authority through format preparation and native admission. Raw catalogue
changes revoke pending or attached recognised sources. Queued download authorization waits for
the current title lists, so it can fail when no saved or provider catalogue is available.
Playback and new/retried download requests check the latest raw catalogue too, including while a
replacement index is being built. Newly recognised unfinished downloads are fenced without
removing their records. Recognised copies are hidden and cannot play; their files remain intact.
Ordinary personal copies remain playable offline. There is no adult opt-in in this release and
desktop policy is unchanged. Provider data with no recognisable classification is not proven
adult-free.

`test/downloads.test.ts` exercises refresh, restore, saved entries, stale action requests, a
restricted transfer and retained offline playback against the fixture provider. Native iPhone
acceptance remains separate from these service checks.

## Managed native playback contract

The pinned expo-video patch adds iOS contract version 1 on its existing player. After checking
`mrStreamerPlaybackContract`, an imperative owner can use `replaceObservedAsync`,
`detachObservedAsync`, `getObservedTracksAsync` and `selectObservedTrackAsync`, and subscribe to
`playbackObservation`. Attempt IDs are increasing positive safe integers. Native item IDs name
actual item objects. The first admission latches managed mode; legacy replacement and track
setters then refuse writes with `ERR_OBSERVED_LEGACY_WRITE`. Expo's native property setters
cannot throw, so the package's existing binding installs instance setters that call a synchronous
native assertion. Native setters also refuse the write. The existing player remains the owner.
Managed v1 accepts clear sources only. Any nonnil `source.drm` is rejected with
`ERR_OBSERVED_DRM_UNSUPPORTED` before admission, without consuming its attempt ID or starting
asset/key work. The legacy DRM path is unchanged.

Detach retires immediately and awaits owned asset/track loads before returning its local receipt.
`providerDisconnect: "unobservable"` cannot confirm a server connection has closed. A failed or
pending detach keeps admission blocked. Failure events expose only allowlisted domains and numeric
codes. Direct HLS HTTP causes may remain unknown; error-log numbers never become HTTP statuses.
Managed items do not run independent HLS playlist discovery or hidden foreground/reset reloads.

`src/playback.ts` is the sole app consumer. It installs one observation listener before any
attempt, allocates increasing attempt IDs before lookup, and filters sequence, attempt, exact
item and source revision. Legacy status/load/playing/time/end events no longer update playback.
A fresh nil-source player's fixed not-drained refusal permits one bootstrap retry on the same
player and attempt. Track policy uses the accepted pure decisions and native readback described below.
An attended Live channel uses core's quality order and bounded recovery. Before the first playing,
Automatic can try three candidates; an explicit channel pick plays alone. After playing, transient
failures reconnect the candidate that played after 1, 2, 4 and 8 seconds. Thirty seconds of actual
playing on one attempt earns those four reconnects back. This permits at most seven opens in the
first unstable stretch and four after a stable reset, with no cross-provider fallback.

Only Watch, Picture in Picture or AirPlay, without viewer Pause, arms Live's deadlines: twenty
seconds from native attach to first playing, suspended while the channel shows Paused, then
fifteen seconds without media-time progress while native playback is not paused. Disarming preserves
spent time; progress resets the stall.
Lookup, download reclaim and reader drain have no startup deadline. Home preview, titles and
copies gain no watchdog or automatic recovery. Native unknown failures stay unknown; a measured
app deadline reports the network policy category without claiming an HTTP cause.

Each automatic attempt keeps the same viewer Choice, frozen track policies, holds, options,
pending Request and signed-in Source binding. It changes no Watch, PiP, mute or navigation intent.
Backoff shows Connecting and counts no telemetry playing time. Pause, Close, setting aside or lost
attention cancels recovery; a login replacement cannot reopen under either login. Explicit Try
again takes a fresh source binding and budget while keeping the Choice and confirmed holds.
There is one outcome per Epoch, true at first playing or false only when none played, and one
terminal failure. Every attach still waits for actual native and format closure and lease return;
a three-second drain wait failure stops recovery. These source rules still need native proof.

Stop, failure and replacement retain actual native detach and format close/closed promises before
publishing idle or failed. Replacement waits for positive matching native acknowledgement and all
format readers, including a late opening. A three-second wait can fail the new selection, while
real closing continues. Rejection, obsolete receipts and unknown closure keep admission blocked.
Direct streams appear in `Playback.closing`, which the Downloads screen shows as waiting. Stop
still returns `Saved`; progress-save completion does not prove reader closure or provider
disconnect. Close, Pause, Picture in Picture and AirPlay retain readers. A provider stream's
download lease is acquired before lookup and given back at once when nothing was submitted,
otherwise only after that positive closure; uncertain closure keeps it for the process.
`playbackReaders(key)` captures every reader of an item not yet known closed, the playing one and
retired, failed or uncertain ones, for copy deletion. Capture it before Stop.

Watch queries fresh track snapshots on menu opening. Ready and track observations also refresh
facts. Choices retain the exact native record, item, attempt and revision, refuse unplayable
options, and offer Off only when native allows it. Checkmarks use actual selected IDs after
readback, never a request acknowledgement. Display names are labels, not language, default or
forced facts. Missing language stays optional. A late menu or choice cannot act after Close,
navigation, replacement or a new revision. Automatic track choices use the frozen policy and
confirmed sound; native acknowledgements alone never establish a held or remembered selection.

Producer R54 compiled the player and passed five actual-player XCTest cases. R59 established HLS
playback, exact-record audio/subtitle selection and readback, stable consecutive revisions, Off,
item/revision fences, local MP4 and allowlisted failure payloads. R145's corrected six-row HLS probe
passed against a direct native oracle. Its instrumented loader boundary, held real group result and
both actual stale callback orders passed, with one sensitive stale-error control. These disposable
seams do not prove unmodified production timing equivalence. Same-item late/reordered groups and an
actual unplayable option remain capability-blocked. These are producer results, not consumer
Release/UI acceptance. Scoped producer fixtures remain in
`test/native-player-r24`; `managed-playback.test.ts` and the existing caller suites exercise the
app through native-port stand-ins. Actual consumer Release/UI verification remains required.

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
  Until the app opens, `titles.ts` batches saved titles while another launch password or list
  read is pending, so providers' saved lists are indexed together once. After 8 seconds, once
  the saved registry is known, pending disk or Keychain reads stop holding the splash: known
  lists are indexed and show, and late answers join them after opening. The timer cannot
  interrupt synchronous JavaScript work. `src/startup-screen.tsx` covers the screens until then: iOS's launch screen
  (`expo-splash-screen`) and then the app's own copy of it at the same place, both drawing
  `assets/splash.png`, the approved artwork, kept as it is (nothing generates it), with "Opening
  your library" beneath after a second. Nothing on it moves.
- `src/media-preferences.ts`: separate saved title language, audio and subtitle policies, global
  Live quality and each channel's chosen stream in Documents/media-preferences.json. The same
  owner keeps the previous accepted raw contents in media-preferences.accepted.json before
  replacing the primary, so a refused native delete-then-move recovers that choice ahead of a
  pending proposal. Existing unreadable preference files make the owner read-only. Settings > Media uses system sheets;
  accepted choices are written before rows update, and failed writes keep the previous choice.
  Titles keep the device language until changed, then rebuild the index and collections in tasks
  and read TMDB names/details/episodes in that language. Saved manual version picks still win.
  Audio defaults to Follow title language, with original/preferred-language options. Playback
  targets the effective title language and falls back to the native playable default
  when unavailable. Subtitles default to forced-only, with Off/preferred-language options. A
  channel's pick, written through the same accepted path, names one of the streams the channel
  lists, by opaque subscription, channel and stream ids only; it replaces a pick kept under the
  channel's other stream ids, Automatic removes it, and picks in a shape this build doesn't know
  stay read-only. `src/media-policy.ts` holds the pure decisions the player applies: tracks from
  observed native snapshots, holds and readback confirmation, remembered manual picks, file track
  facts and the Live recovery table. Each viewer choice freezes audio/subtitle policy and actual
  title/original language; Try again keeps these and confirmed descriptor holds. Automatic choices
  use playable native options, and forced subtitles follow confirmed sound. Manual requests become
  holds only after actual readback, then remember a changing pick through this same preference
  writer. Settings changes affect the next choice. Live uses core's global quality and accepted
  channel pick to build its candidate plan. Watch's Quality sheet remains available while loading,
  playing, paused or failed. A pick writes before a new Choice starts; Automatic clears an override,
  including one that failed. A refused write keeps the accepted choice and current playback.
  Erase-history removal forgets the provider's picks or retains its erasing marker for launch retry;
  keeping history keeps the picks. Quality persistence, recovery timing and PiP/AirPlay through
  reconnect still require exact native and physical acceptance.
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
- `src/viewing.ts`: favourite channels, how far titles got, episode marks and Continue watching:
  core's `ViewingRecord` service over core's in-memory store, its snapshot in `viewing.json`, one
  record per subscription under its id. A favourite keeps its provider's stream ids of the channel
  and shows by the channel Live lists now (`account.ts` hands it the library as it shows), so a
  channel's qualities are one favourite and the same ids of two providers are two. `src/favourites.ts`
  reads them for the screens: a favourite opens only as a channel its own provider lists while
  that provider signs in. The others, of a provider that needs its password, whose channels
  haven't come or no longer list them, are counted under the list by provider, open nothing and
  keep their places, as a new order moves only the rows shown. An order made from favourites that
  changed since is refused, and a write `viewing.json` won't take leaves the record as it was.
  A provider removed with its history kept keeps its favourites for its return; removed with its
  history deleted, they go too. Beside the record, `viewing.json` keeps which of a provider's
  stream ids were seen together in one channel (`favouriteMembership`, `src/viewing-membership.ts`),
  given to core's record through its optional `favourite` port. So a favourite stays one
  favourite while its provider lists only some of its qualities, across relaunches too: one star
  takes out every stream of it, and a new order moves them all, so a quality listed again brings
  back neither a removed favourite nor an old order, as long as some stream still shows them
  together. A panel listing qualities' rows again in other categories can leave nothing that
  does, which looks like a real split: a stream no list shows then stays a favourite of its own,
  an unstar can leave it saved, and the favourite comes back once it is listed again. The
  channels listed now always win: streams
  a list splits between channels follow theirs, and those no channel lists stay saved on their
  own until one channel lists them together again; no name or other provider joins them. Every
  write of the record writes this memory with it, and a regrouping the catalogue shows is written
  as it shows; one the file refuses waits for the next write, so a relaunch before then doesn't
  know it. Starring, unstarring and reordering are decided and written before their promise is
  answered. A file without the memory, as earlier builds wrote, gains it from the channels shown
  from then on; what they no longer show of an older favourite can't be known. A memory of
  another version, or one this build can't trust, is written back as it is, and favourites then
  go by the channels listed now alone, until a provider's history is deleted: as it can't tell
  what of it was that provider's, that deletion drops all of it. An older build that writes the
  file drops the memory.
- `src/watchlist.ts`: saved movies and series, each subscription's record in `watchlists.json`,
  shown as one by core's watchlist rules. Beta 2's `watchlist.json` is read until the first change.
  It also gives the Watchlist screen its rows (`src/watchlist-screen.tsx`), newest saved or by
  name. A row is the title the lists have now, or what was saved of it, with why it isn't listed:
  lists still loading, lists that didn't load or a password needed. "No longer listed" shows only
  once every provider that may list it answered and its lists are indexed. Nothing playable is
  made of what was saved. Remove takes out the entry as it stands then, for every provider
  showing it, and nothing when a sheet left open names records gone since. A provider removed
  with its history kept keeps its saves for its return; removed with its history deleted, its
  saves go too. A refused write leaves the entry and says so.
- `src/downloads.ts`: movies and episodes downloaded to the phone, as the desktop's downloads:
  `downloads.json`, a folder per download in `Documents/downloads`, and nothing else. Transfers go
  through `src/download-task.ts` to the app's own native scheduler of one background URLSession
  (`modules/background-downloads`), so the bytes never pass through JavaScript. It runs one task at
  a time and goes on to the next authorized download by itself while the app is in the background
  or suspended, and after iOS ends its process: the next task is persisted and handed to iOS with an
  earliest begin date a second after its provider's last request ended, before the system's wake
  handler is answered, or the wake is refused after five seconds. iOS may defer it further; a
  user's force quit ends the transfers. In the foreground, `downloads.ts` keeps a window of up to
  32 exact file authorizations: each is reserved, written on its record, then armed with the
  file's request, made from the login only then; the native side keeps the request, headers and
  resume data in the Keychain, per subscription, never in a record. Each subscription's download
  authority is a generation bound to its exact login by `account.ts`, outside the login itself, so
  lists, Live and artwork never wait on it and a failed binding holds back downloads alone. A new
  password or a removal first fences the subscription's downloads durably, in the native ledger or
  by deleting its Keychain items, without waiting for a transfer to end; when neither can be made
  the change is refused. After a ledger fence the subscription's whole Keychain service goes too,
  requests and resume data of reservations never armed included, or at the next reconcile. Only an
  authorization's own receipt changes its record, once, by its
  sequence, and is acknowledged once written down. A pause for playback keeps the same
  authorization; a request that breaks in front of the viewer fails, and Retry goes on from its
  resume data; one that breaks while nobody watched waits for the app to be open. When the server
  refuses resume data, the native side deletes it and starts once more from nothing, and says so;
  when the phone can't delete it, the download fails, and only Retry asks again. A Keychain that
  doesn't answer, as before the first unlock, never counts as a missing login: a finished file
  waits with every byte, and nothing starts in place of resume data it couldn't read, until a later
  reconcile. The first time the app is open in a process, every receipt is taken in, unfinished
  removals finish and logins are bound before anything new starts, a launch the viewer sees
  holding the native queue from its first moment; a receipt that can't be written down keeps its
  file and holds its download back from the queue until it is, a completion from its
  subscription's removal too; a native queue whose authority is damaged
  is started over once then, keeping copies, records and logins, and a locked or full one never is.
  A stream of the same subscription takes the connection first with a lease of this process
  (`onAdmission` in `playback.ts`): the transfer pauses, then is cancelled, and the stream waits for
  its request's actual end and a second of grace, or fails rather than ask for a second
  connection; damaged download storage alone never holds it back. A paused stream keeps its lease
  until Stop. Removing a download writes its intent on its record, fences its authorization, then
  drops the record; its folder goes once its task and every player reader of the copy actually
  closed (`playbackReaders`), and otherwise stays until they do or the next launch. A copy is
  complete only once the native side moved it into place at the whole size the server announced,
  under authority read again just before; a file beside an unfinished download is deleted before
  it is authorized again. A removed subscription's unfinished downloads end, with their files and
  resume data; a copy completed first stays, plays from the phone with no login or network, and
  keeps its own progress, also given to the subscription's viewing record while it is saved. A copy
  playing goes on when the last subscription is removed. Build 14's queue is copied into
  `queue-v2.json` before its `ledger.json` is emptied, and its resume data, and beta 3's under
  `download:<id>`, is taken over by a later request of the very same address; going back to build
  14 is not supported.
  Each newly downloaded episode also keeps the exact immediate successor from its provider's
  series order. Watch offers manual Next only when that successor is a complete local copy of
  the same provider and series version. Next saves first, then rechecks the copies and uses the
  target copy's own resume point. A missing copy stops continuation without skipping or
  streaming; no episode autoplays. Older copies with no saved order still play normally.
  `modules/downloads-folder` makes `Documents/downloads` at launch and keeps it out of backups;
  `modules/background-downloads` keeps its queue and the one file it is finishing in Application
  Support, out of backups, and its request authority in the Keychain, both readable after the first
  unlock (native: both take a new build). Swift compilation, iOS scheduling, wakes, termination,
  first unlock and the Keychain are verified only on a Mac and a phone.
- `src/playback.ts`: the one `expo-video` player and what it plays, a channel or a title. Home's
  preview, Watch, Picture in Picture and the accessory all show or control this player; none
  opens a stream of its own. Another channel or title, Stop, removing its subscription and a failure each let go
  of the stream. `src/play-title.ts` plays movies and episodes in it, saving how far they got;
  saves go one at a time, in order, so a late one never overwrites a newer position, and Resume,
  Continue watching, Next and a copy's Play read where a title got to only once they ended. Closing
  Watch pauses what plays and saves where it got to, unless Picture in Picture or AirPlay already
  shows it; Stop ends it. A refused save shows a system alert, once until a save is kept again;
  one refused because its provider was removed meanwhile doesn't.
  A title or copy in a file AVPlayer can't open, such as Matroska, plays through a format
  session (`src/title-formats.ts`, `modules/title-formats`): native code reads the file, from the
  provider over one request at a time or from the phone, and serves it to this player as HLS on
  127.0.0.1, its picture and each sound track copied as they are. Nothing of a new play reaches
  the provider until earlier native and format readers positively close. A local closure receipt
  cannot acknowledge server connection accounting.
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
the back button on a pushed screen, and Search, Settings and Downloads on the right, less the
button of the screen it is on. The reactive Downloads item trails the system's Search and Settings
buttons. Downloads, Settings and what Settings opens (`provider`, Add
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

Downloads' header entry and Watch's existing button show the queue's actual percentage, received
bytes when its size is unknown, provider wait, queue count or failure. Search offers the same
entry while that status exists, closing Search onto Downloads on its original tab and keeping
the query. All three read the existing downloads store (`src/download-status.tsx`); completed
copies alone leave no extra status. There is no new timer, transfer or animated indicator.
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
Watch's Live Quality sheet reads accepted channel picks at opening and fences its native callback
by item, source, request and menu generation, including when the same item failed. Its playing row
is marked only while playing or paused. Watch's Audio and Subtitles query observed native tracks and select the exact record with its
item, attempt and revision. Duplicate display labels stay distinct by native ID and optional name;
checkmarks follow actual readback. Requests share one queue with automatic policy; an acknowledgement
does not confirm a hold or remember a preference. Later selection-only snapshots can confirm it.
See the managed contract above for the remaining native gates.
`src/glass.tsx` draws the app's own controls as Liquid Glass, and solid before iOS 26 or with
Reduce Transparency on. `src/loading.tsx` shows how lists stand, from what `account.ts` and
`titles.ts` hold: still shapes where content hasn't come yet, with a soft highlight crossing them
while the screen is in front, the app active and Reduce Motion off, and a status line in glass at
the bottom of the screen naming what loads for the first time. Over usable lists, provider failures
get a compact notice with Details opening Settings and a labelled close button. `provider-notice.ts`
observes the public roster and keeps session acknowledgements by provider id, through tabs, resume
and unchanged retries. A failed source must answer successfully before its incident resets; removal
clears it too. Password-needed incidents are distinct. Empty/first-load failures keep their explanation
and recovery inline. Dismissal never changes account errors or lists. A list that loads again while
its last one shows says nothing. `libraryStatus` requires `usableContent` from the existing owners: derived Live channels and
published title collections of the screen's kind, before query or collection filters. Saved raw
provider rows do not establish that content can show. Home counts channels and movies; Search
counts channels, movies and series through the pure `useHasTitles` snapshot. This reads the
collections already made without starting collection work. Hosts such as Search must compose
progress with `libraryStatus` and resolve
`useProviderStatus` before announcements and placement, so dismissing a provider failure keeps other
status text, actions and progress.

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
Array. ArkType's intersection results are such a subclass. From arktype 2.2.9, its
`@ark/schema` 0.56.8 keeps the class in both `invert` and `withPrefixKey`, replacing our local
patch. Without that workaround, a union of object schemas, as the statistics events are, fails
to build on the iPhone with "undefined is not a function". The root tests run on Node, which
honours species, so only the app shows it.

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
addresses, for checking what the artwork cache keeps. For Search and the watchlist, run both
panels with `FIXTURE_PROFILE=browse`: the first adds 125 movies and 125 series Search finds for
"Ocean" and two titles of one name, the second lists one of those too, so the two share it. Its
controls unlist the shared one and hold the lists; `/profile` declares the lists each panel
started with, which an unlisted title doesn't change. See `scripts/browse-profile.ts`. A second
panel, for several providers, runs beside it on other ports with `FIXTURE_SECOND=1` and its own
login, such as
`FIXTURE_SECOND=1 FIXTURE_USERNAME=second FIXTURE_PASSWORD=second-pass node scripts/fixture-server.ts 8793 8794`;
add it in Settings > Add provider at `http://127.0.0.1:8793`. Its channels have the first's ids. For favourites, the control port's `/live-lists` leaves streams
the panel listed out of its later channel lists, as a provider dropping a quality or a channel
does, and lists them again (`scripts/live-lists.ts`); Reload in Settings then reads it. Leaving
out 100000, 100001 and 100002, the one channel in three qualities, takes Belgium's Kwaliteit, the
only category it is in, away from Find countries or categories as well.

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

The provider guide foundation is `src/guide.ts`, fed by account restore, sign-in, catalogue and
erasure lifecycle calls. It resolves only the current catalogue's trusted IDs, including stream
aliases. The private Expo Guide module downloads on a utility callback queue, refuses automatic
redirects, validates gzip and XML before indexing, and publishes complete immutable SQLite
generations through one atomic manifest. Cached queries and account controls run independently of unrelated ingestion; cancellation waits for the relevant job to close its resources. Failed refreshes retain last-good data, quiet background cancellation permits a foreground retry, and committed publication receipts reconcile the cache across lifecycle changes. Missing native
bindings report unavailable. Removal and password replacement revoke work before awaited erasure,
including when viewing history is kept.

`src/guide-ui.tsx` reads the owner's immutable snapshot only while the screen is focused. Live
queries at most 40 visible channels, Home at most 12 including Stage, with the existing two native
read workers. Channel/day/catalogue changes, source revision changes from the existing sign-in
owner, removal and authoritative cache loss retire presentation and late answers. Routine owner
notifications reload the current request while settled rows stay mounted, including across blur,
refocus and Programme/Back. Pending work aborts and subscriptions stop when the screen blurs.
Schedule refreshes replace the represented page span atomically; Show more never appends with a
prior generation's cursor. Failed/refused replacements retain known rows, mark stale generation
presentation, and keep outdated cursors disabled until a valid replacement. Ambiguous channels
retain their provider's visible/spoken label beside populated programmes and on Schedule actions.
There is no UI polling clock, guide cache, provider request or XML parser. The owner's
foreground minute notifications update progress and Today after midnight. Stale last-good data
stays marked; cold, missing, discarded and failed reads finish with honest empty/unavailable
copy. Provider settings is the recovery entry. There is no pull-to-refresh or promised queued
retry: a pending attach suppresses refresh, and failed attach needs the existing account sign-in
path. The Expo bridge and native UI geometry, VoiceOver, Dynamic Type, rotation and physical
phone performance still need the exact-app verification below; source tests do not establish them.

Focused source verification is `pnpm exec vitest run apps/ios/test/guide-screen.test.ts`.
For native acceptance, open Home, preview a tile, open its Schedule and a programme, then Back;
open Live > Guide, choose/clear a country, star a channel, open Schedule, change local days and
Show more, inspect details and press Watch live. Return through native Back to the same day and
country. Repeat with cold/missing/stale/failed guide, account recovery, a held read during
provider replacement/removal, foreground and local calendar boundaries on short, long and
skipped-midnight DST days. Check large
text, VoiceOver's separate Play/Schedule actions, rotation and scrolling during ingestion on the
exact Expo/Hermes native candidate. These native checks remain UNRUN by this source unit.

Initial native refusals are 32 MiB delivered callback bytes, 64 MiB inflated XML, 64 KiB raw
tokens/channel/programme elements, depth 32, 250,000 input programme rows, 10,000 kept programme
channel IDs, 32 MiB per database, 256 MiB total guide disk and a 256 MiB free-space floor.
These are conservative budgets to measure on devices, not phone-safety or exact compressed-wire
limits. Every guide connection uses a private non-default SQLite VFS. Sorting, journals and VACUUM
scratch files stay under the guide root and share before-growth disk/free-space checks with
spools and manifest staging. Per-connection mmap, preallocation hints and WAL shared-memory
writes are disabled. The free-space check reserves allocation rounding and 64 KiB metadata
headroom for growth; zero-byte revocation metadata, overwrites, renames and deletion do not require that reserve. It cannot reserve space against unrelated filesystem writers. UTF-8 XML only; one bounded external XMLTV DOCTYPE is blanked before parsing, with no DTD resolution. Internal subsets and entity declarations are refused. Programme prose follows the
existing catalogue password-substring policy: it refuses a raw password anywhere in saved text,
including ordinary-word collisions, while usernames within prose are allowed. No guide artwork,
provider URLs or request metadata is saved. `modules/guide/test/run.py` compiles the production
core against Mac, simulator and device SDKs and runs fake-only host fixtures. It excludes the Expo
wrapper, does not install an app, and cannot establish Release/Hermes registration or iOS runtime
acceptance. Full native application and hardware verification remain required before release.
