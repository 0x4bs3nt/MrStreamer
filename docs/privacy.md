# Privacy policy

Last updated 11 October 2026. The current version is at <https://mrstreamer.app/privacy>.

Mr. Streamer is a free, open-source desktop player for the IPTV subscription you already have. This policy explains what it stores on your computer, what it sends and to whom, and what we receive.

Data controller: Wout Stiens, Belgium, publishing as Mr Streamer OSS. Contact: privacy@mrstreamer.app.

## Summary

- From 0.0.11, basic first-seen profile and app-use statistics default on, with **Share basic usage statistics** in **Settings > General > Privacy** to turn them off. Builds without a configured PostHog project send no app statistics. The app has no account or automatic crash reporting.
- Your login, settings, favourites, watchlist and viewing history are stored only on your computer.
- To play anything, the app connects to the provider or playlist you add, and the servers it points to. They can see what you watch, and a provider receives your login. Images and film information come from other services, and update checks go to GitHub.
- If your provider has no encrypted address, your login is sent unencrypted. The app tells you before it does this.
- A programme guide you add from another address is downloaded from that address's server. It receives the address and your IP address, and never your login.
- When you play on a TV, the TV fetches the stream from your computer over your local network. It never receives your login or your provider's address.
- Movies and episodes you download, with their details and pictures, are stored only on your computer. Playing a downloaded copy makes no provider request; basic foreground app-use collection follows the Privacy setting independently of playback.

## Data stored on your computer

Mr. Streamer keeps its data in one folder:

| System                  | Folder                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| macOS                   | `~/Library/Application Support/Mr. Streamer`                                                            |
| Windows                 | `%APPDATA%\Mr. Streamer`                                                                                |
| Windows, from the Store | `%LOCALAPPDATA%\Packages\MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr\LocalCache\Roaming\Mr. Streamer Store` |
| Linux                   | `~/.config/Mr. Streamer`                                                                                |

The folder contains:

- your subscriptions, each with its server address, your username, and your password, or the link of a playlist you added, which has no password. The password and the playlist link are encrypted with a key held by your system: the macOS Keychain, your Windows account, or GNOME Keyring or KWallet on Linux. On Linux without a keyring, a fixed key is used, so other programs running under your account can read them. The server address and username are not encrypted, and neither is the address of the server a playlist comes from. Beside them the app keeps a random id it gives each subscription on this computer, with the server address and username it belongs to and the name you gave it. The id is used only inside the app, where it also names the folder of a subscription you added beside your first, and is never sent anywhere.
- your preferences, including your own TMDB key if you entered one. This key is not encrypted.
- your favourites, the channels you watched, your progress in movies and episodes, and the episodes you marked watched or unwatched, each with its series, its season and episode number and when you marked it, and for a series you marked an episode of, the season and episode numbers it listed when you marked or last opened it
- your watchlist: for each movie or series you saved, and each subscription you saved it from, its name, year and kind, whether the provider marks it for adults, when you saved it, its TMDB id, and the numbers that provider lists its versions under
- copies of each provider's channel list, programme guide, and movie and series lists
- from 0.0.9, opt-in subtitle-service settings and encrypted SubDL API keys or OpenSubtitles API keys, usernames and passwords, plus downloaded subtitle text and timing for exact movie and episode versions. Up to eight recent results are cached per exact file. From 0.0.10 each result also keeps the file's size and the tags its provider gave it when it was saved, with a fingerprint of the file's address, so a download takes it along only for the same bytes. Service addresses and account secrets are not stored with those cues.
- from 0.0.9, the sound and subtitle languages read from exact movie and episode files on this computer, with listing fingerprints and random playback session ids, without playable addresses or request headers
- for a subscription you gave a programme guide from another address: that address, the copy of the guide downloaded from it, and the reason its latest download failed, if it did. The address can hold a key, so it is encrypted like a password. Its server's address is not encrypted.
- the channels you mapped to a guide channel by hand: for each, the number your provider lists the channel under, its name, and the guide channel's id
- information from TMDB about your providers' movies and series
- your update channel
- from 0.0.11, your statistics preference and a separate analytics record: a random per-profile installation identifier, the profile’s initial classification, whether it has already been observed, its latest foreground-use date and at most eight pending observations with their event identifiers and retry counts. The identifier is retained when you turn statistics off.
- a diagnostics log of what the app did and how long it took. It contains no server addresses, logins or channel names, and it leaves your computer only if you attach it to an issue or an email.
- from 0.0.10, the movies and episodes you downloaded, in a `downloads` folder: each file, or the part of it downloaded so far, with the name, year, length, episode name and number, original language, poster and picture kept for it, the provider's numbers for that exact file, how far you watched the copy, and the subtitle text and timing you had saved for that exact version. Each download also keeps the account it came from, as the viewing record does: the server address and username, or a playlist's fingerprint, with the id of the subscription it was added from and a fingerprint of the encrypted password or link. Your password, the playlist link and the file's download address are not stored with it.
- a cache of images, at most 64 MB, and other files the app's browser engine keeps for itself

Two items are stored outside this folder: the key that encrypts your password or playlist link, in your system's keychain, and a downloaded update, in a `mrstreamer-updater` folder in your system's cache folder.

Settings > About offers a diagnostics export when you ask for it. You can inspect the exact text before saving it to a file of your choice. It includes the app build, platform, installation kind, subscription counts, a decoder flag, the last update check and at most 500 recent diagnostic entries. Addresses, credentials, channel and title names, filesystem paths and the analytics installation identifier are omitted. Nothing is uploaded. A file you save outside the app's data folder remains there until you delete it.

## Data sent from your computer

### Basic app-use statistics, from 0.0.11

**Share basic usage statistics** in **Settings > General > Privacy** defaults on for new and existing profiles. There is no first-use or upgrade notice. Privacy information is available there and in Settings > About, and the release notes announce the change. A build without a configured project sends no app statistics.

When collection is configured and enabled, the app sends two kinds of observation to PostHog: the first analytics observation of this profile, and at most one foreground app-use observation per UTC day. Foreground means the primary window is visible, focused and not minimized. A session that remains in the foreground over midnight can count on the next day. Playback is not required. Background update checks and a hidden window kept for a TV receiver do not count.

Each observation includes a random installation identifier stored in this profile, an event identifier, the observation time, app version, running build channel, selected update channel, operating system, processor architecture and direct or Microsoft Store distribution. Build and update channels are separate: choosing Nightly updates does not turn a running Stable build into Nightly. Development or unrecognized builds retain an unknown build classification. The first observation’s profile classification is fresh, upgrading or unknown, based on evidence present before the app writes its files. A missing analytics file alone never means a fresh installation.

The installation identifier is a persistent pseudonymous identifier, not a name, account or device fingerprint. The payload excludes viewing history, titles, channels, searches, provider details, addresses, credentials, filesystem paths and diagnostics. There is no autocapture, session replay, feature-flag collection or automatic crash reporting. Person-profile creation and GeoIP enrichment are explicitly disabled. PostHog and its network infrastructure still receive the source IP address as part of the network connection; disabling GeoIP does not hide that address from them. Your network operator and DNS provider can see the destination. Configured production collection uses HTTPS.

First-seen statistics count profiles first observed by analytics, not installer downloads or unique people. Known fresh, upgrading and unknown profiles are reported separately. Weekly active use means unique installation identifiers with a foreground-use observation in the trailing seven days. Multiple profiles or devices, deletion of a profile, disabled collection, offline loss and clock changes limit these counts. A profile that switches channels may appear in both channel breakdowns, so those totals are not additive.

Turning the setting off stops new capture, cancels owned pending requests where possible and clears queued observations. It survives restart. A request already received by the server cannot be recalled. Turning collection on again keeps the same identifier and first-seen record, so it does not count another installation or backfill disabled days. Offline retries keep the same event identifier and timestamp, use a bounded queue and attempt budget, and may lose observations. Analytics failures do not prevent startup, playback or quitting.

Configured releases send these observations to our desktop project on **PostHog EU Cloud**. The project uses the free plan. PostHog's [published pricing](https://posthog.com/pricing) currently lists one year of retention for analytics events and metadata on that plan. We review usage and retention monthly; no additional automatic deletion is configured. This describes the provider's published retention terms rather than a separately verified deletion deadline. [PostHog's privacy information](https://posthog.com/privacy) describes the service.

Builds without the project configuration send no app statistics. Local development, tests and isolated verification sessions cannot enter production statistics; verification uses a loopback endpoint only.

### Your provider

Mr. Streamer connects to the server address you enter, for each subscription you add. It does so to check your login (when you add it, each time the app starts, and when you open Settings > Subscriptions), to load the channel, movie and series lists and the programme guide, to show a title's details, and to play. Every request includes your username and password for that provider, because these providers require it. Your provider can see your IP address, the app version, and what you open and watch from it, and when. Your provider's privacy policy applies to that data.

With several subscriptions, each provider receives only its own login and the requests for its own channels and titles. Mr. Streamer puts their lists together on your computer, and tells no provider about another, or what you watch from it.

### Online subtitle services, from 0.0.9

Online subtitle search is off until you enable it in Settings. Saving settings or opening the subtitle panel makes no request to either service. When you explicitly search, the services you selected and set up receive the movie or series TMDB identity, or its title and year when no identity is known, with the season and episode for an episode, and your requested languages. They also receive your IP address, app identification and their own API key. No provider login, playable stream address or file request headers are sent.

Choosing a result downloads its subtitle from that service. OpenSubtitles receives your username and password over HTTPS for that download login. Its returned token stays in memory for the request and is not stored. A download can consume the service's allowance. SubDL uses your API key for search; its subtitle download receives no OpenSubtitles login. Their own privacy policies apply.

Downloaded cues and corrections stay on this computer. You can forget them for a file in its subtitle panel. When removing a subscription, tick **Also delete favourites, watchlist, history and progress** to remove its saved subtitle data too. Otherwise that data remains on this computer. Removing a service account from Settings removes its saved credentials. Turning search off cancels online requests and prevents new searches or downloads, while locally saved subtitles remain playable.

### Unencrypted connections

An address starting with `https://` is encrypted, and Mr. Streamer never falls back from it to unencrypted http, including through redirects. An address entered without `https://` or `http://` is tried with https first. If that fails, the app stops before sending your login and asks you. Your login is sent over http only if you choose **Connect without encryption**. An address entered with `http://` connects over http, and the login form says so.

Over http, your username and password are sent as plain text, and anyone on your network or between you and your provider can read them. Settings > Subscriptions marks such a login "not encrypted". If your provider offers an https address, we recommend using it.

### A playlist

When you add a playlist link, Mr. Streamer downloads the playlist from that address when you add it, each time the app starts, when you open Settings > Subscriptions, and when it refreshes the channel list or the guide. To play a channel, it connects to the address the playlist lists for that channel, often on another server, and follows that server's redirects, often to further servers. If the playlist names a programme guide, the app downloads it from the server named. Each of these servers receives your IP address and the app version, or the browser identification and referring address the playlist names for that channel. The servers that play a channel can see what you watch, and when. A playlist link without a login sends no username or password. A channel listed with an `http://` address plays unencrypted.

### A guide from another address

If you give a subscription a programme guide from an address of your own, Mr. Streamer downloads the guide from that address: when you choose **Check**, when you refresh it, and about every six hours while it is that subscription's guide. The address's server, and any server it redirects to, receives your IP address, the app version and the address itself, with any key in it. It never receives your provider's address or login, and the app sends it nothing about your channels or what you watch. An address starting with `http://` is sent unencrypted, key included, and the form says so before the first request. Mr. Streamer never follows a redirect from an `https://` address to an `http://` one.

### Downloads, from 0.0.10

A download asks your provider for the file, with your login, as playing it does: your provider sees that you downloaded it, and when. When you download, Mr. Streamer also fetches the title's poster and picture once, from the servers below under Images, to keep with the copy. Playing a downloaded copy needs no provider, TMDB, image-server or TV connection. Basic foreground app-use statistics, when configured and enabled, are independent of playback.

### Images

Channel logos, posters and backdrops load from the servers your provider or playlist specifies. Film images, episode stills and cast photos load from TMDB. These servers receive your IP address, the image requested, your system language, and a browser identification that includes Mr. Streamer, its version and your operating system. They do not receive your login.

### The Movie Database (TMDB)

When TMDB is enabled, Mr. Streamer asks TMDB about the movies and series your providers list, in the language you chose, and which streaming services offer them in your country. When you open a title or a season, it requests that title's or season's details. TMDB receives your IP address, those titles, your language and country, and an API key: Mr. Streamer's, or your own if you entered one. TMDB never receives your provider's address or your login. [TMDB's privacy policy](https://www.themoviedb.org/privacy-policy) applies.

### Update checks

About 20 seconds after it starts, and every four hours after that, Mr. Streamer checks GitHub for new versions. GitHub hosts our releases and the update list, and receives your IP address and app version with each check. Updates download only when you choose **Download**. Update checks cannot be turned off in Settings. Copies installed from the Microsoft Store receive updates through the Store. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) applies.

### A TV on your network

Mr. Streamer can play on a TV or other receiver on your local network: with Google Cast on Windows, and with AirPlay on macOS. Nothing here happens until you open the list of receivers.

- **Finding receivers.** On Windows, while the list is open, Mr. Streamer asks your local network which Google Cast devices are there (mDNS). The devices that answer send their name and address, which stay in memory. On macOS, the system finds AirPlay receivers and shows its own list; Mr. Streamer learns only whether one exists, not which.
- **What the receiver gets.** The receiver gets an address on your computer that holds a random token, and fetches the stream from it over your local network, unencrypted. The address works only while that stream plays, and only for devices on your local network. A Cast device also gets the name of what plays and, for movies and series, the address of its picture at TMDB, which the device loads itself. The receiver never gets your login, your provider's address or your playlist link: your computer fetches from the provider and passes the stream on.
- **Google and Apple.** A Cast device runs Google's media receiver, which it loads from Google, and Google's terms apply to what the device reports. Mr. Streamer connects to a Cast device without verifying that Google certified it. AirPlay is handled by macOS and the receiver, under Apple's terms.
- **Other devices on your network.** While a receiver plays, a device on your local network that learns the stream's address, which is random and changes with every stream, could fetch that stream too.

Your provider still sees one connection, from your computer.

### Links

Links in Settings, for example to the website, GitHub or TMDB, open in your web browser, where that browser's and that website's terms apply.

### Your network

As with any app, your network operator and DNS provider can see which servers Mr. Streamer contacts.

Mr. Streamer shows no advertising and does not sell data. Basic app-use statistics are described above and can be turned off in Settings.

## The website

The website at mrstreamer.app is hosted by Vercel and uses Vercel Web Analytics to count visits and page views. Vercel processes the page URL, referrer, approximate location, device and browser information. We see aggregate traffic statistics. It uses no analytics cookies; its visitor identifier is discarded after 24 hours. See [Vercel's Web Analytics privacy information](https://vercel.com/docs/analytics/privacy-policy).

To link the newest installers, the home, download and about pages ask GitHub for the public list of releases, the one the app reads for its update checks. GitHub receives your IP address, your browser's identification and that the request came from mrstreamer.app. The request carries no cookie and nothing that identifies you to us. The download buttons and the Microsoft Store badge are links. Nothing goes to GitHub or Microsoft for them until you follow one. [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) applies.

Website analytics do not receive your IPTV login or viewing history from the desktop app. Desktop app-use statistics use the separate PostHog integration described above.

## Data we receive

When desktop collection is configured and enabled, PostHog processes the app-use observations above on our behalf. Website statistics are separate. We also receive what you choose to send us:

- email to privacy@mrstreamer.app, hello@mrstreamer.app or security@mrstreamer.app
- issues and comments on [GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/issues). These are public, so please leave out your server address, username and password.

Our email and hosting providers process these messages and visits to our website on our behalf. We use your messages only to reply to you and to fix the problems you report, based on our legitimate interest in supporting and improving Mr. Streamer (GDPR Article 6(1)(f)). We keep them only as long as that requires, and we do not share them. Anything you post on GitHub is public.

## Deleting your data

Turning **Share basic usage statistics** off clears pending local observations and prevents further capture; it does not delete observations already received by PostHog. Deleting the profile folder also deletes its installation identifier and opt-out, so a new profile defaults on and can be counted as a new installation when collection is configured. Contact privacy@mrstreamer.app about data already received. Our PostHog project uses the retention terms described above, with no additional automatic deletion configured.

- **Remove**, on a subscription in Settings > Subscriptions, deletes that subscription's login or playlist link, the id and the name the app kept for it, the copies of its provider's lists and guide, and a guide address you gave it with the copy of that guide and the channels you mapped. Your other subscriptions keep theirs. Tick **Also delete favourites, watchlist, history and progress** to delete that account's favourites, watchlist, watched channels, progress in movies and episodes, the episodes you marked, and saved subtitle cues and timing as well. Otherwise they remain on this computer. Your favourites, watchlist and viewing record reappear if you add the same account again.
- **Remove** also cancels that subscription's unfinished downloads and deletes what they had downloaded. Downloaded copies stay, with their details and progress, until you delete them.
- **Delete**, on a download in Downloads, deletes its file, its details and pictures, its progress and its saved subtitles.
- **Use provider guide**, or **Use playlist guide**, in a subscription's Guide form deletes the guide address you gave it, the copy of that guide and the channels you mapped.
- **Deleting the folder** listed above removes everything Mr. Streamer stores there. To also remove the password key, delete "Mr. Streamer Safe Storage" in Keychain Access on macOS, or the matching entry in your Linux keyring. The update folder can be deleted as well: `~/Library/Caches/mrstreamer-updater` on macOS, `%LOCALAPPDATA%\mrstreamer-updater` on Windows, or `~/.cache/mrstreamer-updater` on Linux.
- **Uninstalling the app does not delete your data**, so a reinstall continues where you left off. The copy from the Microsoft Store is the exception: uninstalling it deletes its folder.
- To ask us to delete messages or other data we hold about you, email privacy@mrstreamer.app.

## Your rights

The data on your computer stays under your control. We cannot access or delete it, and you can view or delete it at any time as described above.

For personal data we hold, mainly messages you sent us, the GDPR gives you the right to access, correct and erase it, to restrict or object to its use, and to receive a copy. Email privacy@mrstreamer.app and we will respond within one month. For data held by your provider, the servers a playlist names, the server of a guide address you gave, TMDB or GitHub, contact them directly.

Mr Streamer OSS is based in Belgium. You can lodge a complaint with the Belgian [Data Protection Authority](https://www.dataprotectionauthority.be/citizen/actions/lodge-a-complaint) or with the data protection authority in your country.

## Changes

We update this policy when what Mr. Streamer stores or sends changes. Previous versions are in its [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md).
