# Privacy policy

Last updated 27 October 2026. Earlier versions are in the [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md).

Mr. Streamer is a free, open-source IPTV player for your computer and iPhone. It has no Mr. Streamer account or in-app purchases, shows no ads and doesn't sell data. When you connect your own provider, its streams and requests go directly between your device and the services you connect. We also operate a restricted sample provider for app review, described below.

Wout Stiens in Belgium, publishing as Mr Streamer OSS, is responsible for the data we receive. Contact [privacy@mrstreamer.app](mailto:privacy@mrstreamer.app).

## Information we collect

### On your computer

Most of what the desktop app handles never reaches us. It stays in its data folder ([where it is](user/troubleshooting.md#where-your-data-is)):

- your subscriptions: server address, username, and password or playlist link
- preferences, including your own TMDB key if you entered one
- favourites, watchlist, your channel lists, the channels you watched, your progress and the episodes you marked
- programme reminders in `reminders.json`: the programme's title, channel, start and end times, and whether it was shown or missed
- copies of each provider's channel, guide, movie and series lists, and what TMDB said about them
- downloaded movies and episodes, with their details, pictures, subtitles and progress
- subtitle-service settings and saved subtitles, if you turn subtitle search on
- the statistics setting, its installation identifier and up to 64 statistics items: queued events, the open five-minute counts and one unfinished play
- a diagnostics log with no addresses, logins or channel names

Reminders stay locally until the app checks after the end of the day their programme ends. A system notification can show the programme's title and channel, including on a locked screen according to your system's settings. Reminders for adult channels appear only in the app while **For adults** is on. A reminder due while those channels are hidden becomes missed and does not notify later. Reminder details are excluded from statistics and diagnostics exports.

**Diagnostics…** in Settings > About reconstructs an export from fixed fields, shows you the text before you save it and uploads nothing. Ordinary local console output is separate and can contain file paths or invalid values from damaged local files. Review console output before sharing it.

### Usage statistics

In the desktop app, **Share basic usage statistics** is on by default, in new and existing profiles, without a prompt. While it's on, the app records the activity below. Usage is counted in five-minute groups, playback is reported once at its end, and errors and other reliability events are sent directly:

- you open a part of the app, from a fixed list: Home, Live TV, Movies, Series, Watchlist, Downloads, Search, Settings, the player and title details
- a live channel, or a movie or episode, starts playing, and when it stops, for how many seconds it played. Only time it was actually playing counts: not paused, loading, seeking or the muted preview on Home
- playback fails or stops with an error, with one of six fixed reasons, such as "network" or "unsupported"
- you open a channel's guide, start a search, add a favourite, switch to another channel, or add, remove or refresh a subscription
- you change a preference, naming only which one from a fixed list, such as the audio language or the update channel, never what you chose
- the update panel shows a new version, or you dismiss it
- a download or update check succeeds, fails or is interrupted, with the fixed reason for a failure
- the app's window stops unexpectedly. Closing the window or quitting doesn't count, and a crash of the whole app or a power cut can't be counted

Events say whether live TV or a movie or episode played, not which one, from which subscription or from where. A search event never contains what you searched for.

Playback failure events can also include fixed diagnostic categories: where it failed, the typed reason, the container family, direct or converted delivery, known video and audio codec families, and whether no fallback, audio conversion, video conversion or repair was in use. Unknown facts stay unknown or are omitted. These categories do not add another event. They never include raw errors, decoder messages, tool output, file paths, stream addresses, provider details, content identifiers or credentials. A decode rejection does not tell us that a codec is missing. The exact fixed values are listed in the [telemetry catalogue](https://github.com/Mr-Streamer-OSS/MrStreamer/blob/main/docs/telemetry.md). The iPhone app does not send this additional desktop context.

The app also sends an observation the first time it sees this profile with its main window in the foreground, and at most once per UTC day after that. It also observes the current app version and build channel, then each change to that pair, including changes on the same day. If a previous foreground-observed version is known, it includes that previous version and build channel. An existing profile without that saved baseline has unknown history. Turning statistics off clears the baseline; turning them on records only the current foreground version without claiming what happened while they were off. Reinstalling with the same profile keeps the same identifier. Usage counts are saved locally as they happen and sent in five-minute groups, also when you quit or change update channel. Each group carries its original UTC five-minute window time. A play sends one summary only when it ends, with its start time and counted duration. Errors, download/update outcomes and unexpected window exits send directly. After an unexpected exit, the next launch can report the last saved unfinished play. That duration can miss up to five minutes plus the playing-state lease; time while the app was closed never counts. Without another launch, it cannot report that play.

Queued events and their retry timing, the open five-minute counts and one unfinished play share a total limit of 64 items and a 128 KiB local record budget. When it fills, the app drops older summaries first, then older version observations, then queued individual events. It keeps the latest version observation until no other queued event can be removed. The first installation observation is protected from overflow. Summary work expires after seven days. Possible body transmission spends one of three delivery attempts, including a timeout without an answer; for summary work and first, daily and version observations, a proven connection failure before sending the body keeps the work for later without spending an attempt. The first, daily and version observations also expire after seven days and keep their original event identifier, time and body across offline restarts. Proven failures before body transmission keep them for later without spending an attempt; an interrupted reservation can still spend one if its refund was not saved. Possible transmissions are limited to three. Other direct events have a three-attempt limit, including failed connections. Retry waits for summaries and first, daily and version observations increase up to five minutes. Other individual events wait two seconds between retries in the same app process; after a restart, they can retry immediately. Usage, new plays and direct reliability each admit at most 60 observations a minute; excess observations are dropped. A play already admitted keeps its final report. A failed or slow local write stops collection for that session. Opt-out clears queued and unfinished work at once and stays off after restart. Running an older app version on the same profile can discard queued summaries and version observations it doesn't support, while keeping your choice, identifier and the queued events it supports.

Events before the first foreground observation and unflushed work just before an unexpected exit can be lost. Builds without project configuration send nothing. Daily totals saved in an earlier statistics format, including any waiting to be sent, are deleted without being sent.

Each event carries a random installation identifier, an event identifier, the time it happened, the app version, build and update channel, operating system, processor type, whether the app came from the Microsoft Store or our download, and whether the profile looked new, upgraded or unknown when the app first observed it.

Statistics never include what you watch, title or channel names, your provider or its address, stream addresses, logins, searches, file paths, logs or error messages. There is no autocapture, session replay, crash dump or log upload. The identifier doesn't name you but links your events, including when you used the app and how long things played, so the data is pseudonymous, not anonymous. Person profiles and location lookup are off in PostHog. PostHog receives your IP address with each request, as any server does, and our project is set not to store it.

### Usage statistics on iPhone

The iPhone app asks whether you want to share basic usage statistics. Statistics stay off until you choose to share them, except when an upgrade retains your earlier deliberate choice. Refusing does not stop you connecting a provider. You can change the choice in Settings > Privacy. Builds without a configured PostHog project send nothing.

When an upgrade finds no deliberate choice, it discards the previous installation identity, unsent pre-consent events and unfinished playback statistics. Choosing to share later does not send that backlog. Turning sharing off stops new capture and delivery. When the changed choice is saved successfully, unsent statistics are cleared. If saving fails, the previous choice and queued statistics can remain on the device; a later launch can restore that choice and send those statistics. Turning sharing off cannot recall a request already received or delete statistics already held by PostHog.

While sharing is on, the app sends the same kinds of events as above, for what the iPhone app has: the first and daily observations, opening Home, Live, Movies, Series, title details, Search, Settings, Downloads or the player, starting a search, switching to another channel, adding, removing or refreshing a subscription, a live channel or a movie or episode starting and stopping and for how many seconds it played, and playback failing with one of the fixed reasons. Only time you could see or hear it counts: in the player, Picture in Picture or AirPlay, or a preview on Home you unmuted. Not paused, loading or the silent preview.

Each event body carries a random installation identifier, an event identifier, the time it happened, the app version and build, that it came from iOS and iOS's major version. The event body leaves out the device model, language, location, provider logins and addresses, stream addresses, title and channel names, what you search for, and raw logs or errors. Separately, each connection exposes your IP address to the servers that receive it, and iOS can add network details such as your language and an app and system user agent.

### Local data on iPhone

The iPhone app keeps provider details, preferences, catalogue and guide caches, title details and pictures, favourites, watchlist, history, progress, downloads, and its statistics choice, installation identifier and unsent statistics on the device. Passwords use the iOS Keychain. Local app files can still contain provider addresses and usernames.

Removing a provider clears its own catalogue, guide and title-detail caches. Shared TMDB details and pictures can remain. Keeping its history can retain its server address and username. Remove downloads separately to delete their saved copies. Turning statistics off retains the local installation identifier and clears unsent statistics when the changed choice is saved successfully. These actions do not promise erasure from the Keychain, backups or services that already received data.

### The website

mrstreamer.app is hosted by Vercel, which receives your IP address and browser identification with each request, as any web host does.

To link the newest installers, the download and about pages ask GitHub for the public list of releases. GitHub gets your IP address and browser identification. The home page links the download page and doesn't ask GitHub.

### Website analytics

Website analytics are on unless your browser sends Global Privacy Control or Do Not Track. Turn them off with **Site analytics** at the foot of any page of mrstreamer.app. Your browser keeps that choice in its local storage and, while they're on, the three codes for where your visit came from, below, in that tab's session storage. There is no cookie, and your browser stores no identifier.

While they're on, each page you open sends PostHog a few events: which of our pages it is, roughly how long it was in view, and which of these you used on it: a download link, with its system and file type, a link to a guide or to GitHub and whether it was in the header or footer, a section of a guide, a part of the home page, a question in the FAQ, or a release in the release notes. It also sends how far down the page you scrolled, and three measures of its speed: how long its largest image or text took to show, how quickly it responded to your clicks, taps and keys, and how much its content shifted. These are numbers only, without the parts of the page involved. Each event names the page by its own address on mrstreamer.app, such as https://mrstreamer.app/faq, not the address in your browser.

Page views and download clicks also carry where your visit came from, as three codes from a fixed list: the kind of site, such as a search engine, GitHub or Reddit, never its address; how it linked to us, such as search or a README; and a campaign, only when our own link names one. Any other site counts as "other". A visit with no address to come from, such as a typed address, a bookmark, a link in the app or a site that hides its address, counts as "unknown". The tab keeps these codes until it closes, so a download link used a few pages later is counted with them. A visit from a tagged link or another site replaces them. A download click counts the click, not a finished download or installation.

PostHog counts visitors and visits without a cookie. Each event carries your browser identification, and PostHog's servers combine it with your IP address, our site's name, our project and a random value that changes every day into a one-way code, a hash. PostHog then deletes the IP address and browser identification from the event and keeps the code. The code ties together the pages you open that day and splits them into visits, so it is pseudonymous, not anonymous. It changes the next day and isn't linked to the app. PostHog says it deletes each day's random value once that day's events are processed. People on the same network with the same browser can share a code.

Website analytics never include the address you came from or anything after a ? or # in an address, only the codes picked from them. They never include what you type, your location, or details of your device or browser beyond the browser identification used for that code. There is no autocapture, session replay or person profile. Each request goes to our own address, mrstreamer.app/ingest, which Vercel passes on to PostHog's EU Cloud with your IP address, so PostHog can make the code above. PostHog receives your IP address and browser identification with each request, as any server does, and our project is set not to store the IP address.

If your browser sends Global Privacy Control or Do Not Track, website analytics stay off and can't be turned on. Turning them off sends nothing more and deletes the tab's codes, and nothing is sent about the time they were off. Turning them on sends nothing about the page you're on. Counting starts on the next page you open. Without JavaScript nothing is sent.

### Messages you send

Email to privacy@, hello@ or security@mrstreamer.app, and issues you open on GitHub. Issues are public, so leave out your server address and login.

## How we use it

- **App statistics**, to understand which supported versions, systems and features are used, how much live TV and video plays, and which playback, download or update operations fail, so we know what to fix and support. Each app sends only the events described above for that app.
- **Website analytics**, to understand visits, referral categories, pages and guides read, download choices, reading depth and page speed.
- **Messages**, to answer you and fix what you report.
- **The restricted review provider**, to authenticate authorised reviewers and deliver the sample catalogue, guide, pictures and media needed to review the app.

For **optional iPhone statistics**, our basis is your consent (GDPR Article 6(1)(a)). You can refuse without losing access to provider setup, or withdraw through Settings > Privacy. The iPhone statistics section explains what Off does and the limits when saving fails. Withdrawal does not undo processing that was lawful before it, and does not itself erase records already received.

For **desktop statistics, website analytics and messages**, our basis is legitimate interest (GDPR Article 6(1)(f)): understanding reliability and use, improving the app and website, and answering requests. You can object by email, and stop new statistics or website analytics through the controls below. For operating and securing the restricted review provider, our basis is also legitimate interest: making the app available for review through authentication and sample delivery.

We do not use app statistics or website analytics for advertising. They share a PostHog project but use separate events and identifiers, and we do not link them.

## Who receives what

### Services you use through the app

Third-party requests go directly from your device to the services you use. Their own privacy policies also apply. Our restricted review provider is an exception: we operate that service ourselves.

Downloaded copies can play without requesting their media from your provider. Other enabled network features, such as app statistics or requests for information and pictures, can still run. Desktop update checks remain desktop-only.

Your network operator and DNS provider can see which servers your device contacts.

#### On desktop

- **Your provider** gets its login, your IP address and app version, and sees what you open, watch and download.
- **Servers a playlist or guide address names** get your IP address, the app version and the stream or guide requested. A playlist can supply its own browser identification and referrer for a stream. A guide address can carry its own key. The app refreshes a guide from another address about every six hours.
- **[TMDB](https://www.themoviedb.org/privacy-policy)** gets the titles your providers list, your language and country, an API key (ours or your own) and your IP address. Never your provider's address or login.
- **Image servers** named by your provider or TMDB get your IP address, the image requested, your language, and the app and system version.
- **[OpenSubtitles](https://www.opensubtitles.com/en/privacy)** and **[SubDL](https://subdl.com/privacy)**, only after you turn subtitle search on and search: the title's TMDB id, or its name and year, the episode, languages, the service's API key and your IP address. OpenSubtitles also gets your username and password when you download a subtitle.
- **[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)** gets your IP address and app version with each update check, about 20 seconds after start and every four hours, sooner after a failed check. Microsoft Store copies update through the Store instead.
- **A TV you pick** on your network gets an HTTP stream address on your computer with a token for the active playback session. The app serves the stream without sending the TV your provider's login or stream address. A Google Cast device also gets the title and its TMDB picture address. Casting relies on a trusted local network; see [Security](security.md#playing-on-a-tv).

#### On iPhone

- **Your provider** receives the login and requests needed to fetch its catalogue and guide, play streams and download copies. It receives your connecting IP address and network metadata and can see the provider resources requested.
- **[TMDB's metadata API](https://www.themoviedb.org/privacy-policy)** receives the movie, series or season identifiers requested, language and region where used, our application's API key or read token, and your connecting IP address and network metadata. The iPhone client does not add your provider login or address, typed searches or statistics installation identifier to these calls. Metadata can be fetched while building the library, not only when you play something.
- **Image servers** named by your provider and TMDB's separate image service receive the requested picture address, your connecting IP address and network metadata that iOS supplies. The app builds TMDB image addresses separately, without adding its TMDB API key or statistics installation identifier.
- **An AirPlay receiver you choose** is used through iOS's system playback controls. This is separate from the desktop Google Cast and local-stream route described above.

The iPhone app uses the TMDB key supplied with the app. It does not offer the desktop custom-key, subtitle-service, Google Cast or desktop update-check controls.

#### Restricted review provider and earlier private-beta samples

For app review we operate a restricted sample provider on **[Cloudflare](https://www.cloudflare.com/privacypolicy/)**. When that provider is connected, it receives the review login, connecting IP address and requested catalogue, guide, picture and media resources needed for authentication and delivery. These requests reach a service we operate; they are not requests to an unrelated provider. Cloudflare also processes hosting and network information under its applicable service terms and privacy policy. We do not promise that requests leave no hosting or security records.

An earlier private-beta installation can still retain a demo subscription or downloaded samples. Fetching those sample pictures or media contacts **GitHub's raw-content hosting**, which receives the requested paths, connecting IP address and network metadata. The current new-user flow does not offer Try demo.

### Services that work for us

- **[PostHog](https://posthog.com/privacy)** processes app statistics and website analytics in our configured EU Cloud project, hosted in Frankfurt. This regional setting is not a promise that all related processing or access stays in the EU.
- **[Vercel](https://vercel.com/legal/privacy-notice)** hosts the website and its analytics forwarding route. It receives website connection information, including IP addresses and browser identification.
- **[Cloudflare](https://www.cloudflare.com/privacypolicy/)** hosts our restricted review provider and handles delivery of messages sent to hello@, privacy@ and security@mrstreamer.app through [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/), to the mailbox provider where we read them.

## Your choices

- **Statistics on desktop.** Turn off **Share basic usage statistics** in Settings > Privacy. Sending stops at once, events waiting to be sent are cleared, and it stays off after a restart. Turning it back on keeps the same identifier and sends nothing about the time it was off, including playback that continued meanwhile.
- **Statistics on iPhone.** Statistics stay off until you choose to share them, except when an upgrade retains an earlier deliberate choice. Change **Share basic usage statistics** in Settings > Privacy. Turning it off stops sending at once. When the changed choice is saved successfully, waiting events are cleared and it stays off after the app restarts. If saving fails, a later launch can restore the earlier choice and queued statistics.
- **Website analytics.** Turn off **Site analytics** at the foot of any page of mrstreamer.app. The choice applies to that browser only, and clearing the site's data from your browser turns them back on.
- **Subtitle search on desktop** is off until you turn it on.
- **Casting on desktop** happens only after you open the receiver list and pick a device. On iPhone, AirPlay uses the system controls for the receiver you choose.
- **TMDB** requests have no separate off switch in either app. Only desktop Settings lets you choose whose TMDB key the app uses. **Update checks** described here are desktop-only; iPhone app updates use Apple's distribution services.

### Deleting your data

In the desktop app:

- **Remove** on a subscription in Settings > Subscriptions deletes its login, provider lists, guide, mapped channels and reminders, and cancels its unfinished downloads. Favourites, watchlist, history, progress and membership of your custom lists stay for when you add the same account again. Tick **Also delete…** to delete those and its saved subtitles too. Your custom lists themselves and finished downloads stay until you delete them.
- **Delete list** in a list's menu in Live TV deletes the list with its name and the channels it held. Your other lists, and lists a subscription's removal emptied, stay until you delete them.
- **Also delete** in an older app without custom lists leaves that account's list channels on disk while you use that app. The next start of an app with custom lists deletes them before showing lists, even if you added the same account again in the older app.
- **The cross** on a guide in Settings > Guides deletes its address, its name and what it downloaded. Every subscription reads those guides, so removing a subscription keeps them.
- **Delete** on a download deletes the copy with its details, pictures, progress and subtitles.
- **The cross** on a reminder in Live TV's reminders list deletes it.
- **Deleting the data folder** deletes everything else, including the statistics setting, so a new folder starts with statistics on. To also remove the password key, delete "Mr. Streamer Safe Storage" in Keychain Access on macOS or the matching entry in your Linux keyring. A downloaded update stays in `~/Library/Caches/mrstreamer-updater` on macOS, `%LOCALAPPDATA%\mrstreamer-updater` on Windows or `~/.cache/mrstreamer-updater` on Linux until you delete that folder.
- **Statistics already sent** are not erased by local removal or turning the setting off. If you still have the desktop `installationId` in `analytics.json`, you can supply it privately with a request through the contact below. It may help identify the records; it does not itself perform deletion.

Removing a subscription or turning statistics off keeps an installation identifier already stored in `analytics.json`. A fresh profile can have no identifier until its first foreground observation. Deleting the data folder removes the local identifier; a new profile gets a new one when observed. This does not delete statistics already sent.

## Retention

- **On your computer:** until you delete it. Uninstalling keeps it, except for the Microsoft Store copy, which Windows deletes with the app.
- **On iPhone:** local data remains until the app, you or iOS removes it, depending on the kind of data. Provider removal, shared caches and separate download removal are described above. The iPhone statistics queue has no fixed age-based expiry; waiting work can remain until delivered, discarded under its queue or attempt limits, or cleared after Off is saved successfully. If saving Off fails, earlier work and the previous choice can return after relaunch. Removing the app is not a guarantee of erasure from Keychain, backups or services that already received data.
- **App statistics:** our PostHog project is on the Free plan. PostHog describes a one-year event query window: older events are excluded from queries. That is not a guaranteed physical deletion date. We have no additional automatic statistics-deletion schedule configured and cannot promise a fixed erasure date for records or backups. Turning sharing off does not delete records already received; the request route is below.
- **Website analytics:** the same PostHog project and query-window limits as app statistics. Turning website analytics off stops new counting; it is not a request to erase records already received.
- **Review-provider requests and hosting records:** authentication and resource requests are used to deliver the restricted review service. Hosting and security records may be kept under the host's applicable terms and service settings. We do not claim zero logging or a fixed deletion period for those records. Disconnecting a provider or closing the app does not erase a host's records.
- **Messages:** as long as needed to answer and deal with the request, including any necessary legal record. GitHub issues stay public until deleted.

## Security

In the desktop app, passwords, playlist links, guide addresses and subtitle-service logins use Electron's system storage encryption: macOS Keychain, your Windows account, or GNOME Keyring or KWallet when selected on Linux. Linux can instead use `basic_text`, a fixed-key fallback that does not protect secrets from other programs running as you. Server addresses, subscription usernames and your own TMDB key aren't encrypted.

The desktop app refuses HTTP redirects that it recognizes as carrying the known login of an HTTPS source. It also checks playlist addresses and removes recognized login-bearing headers when a request leaves that source's origin. HTTP addresses without a recognized login can still be used. This cannot identify every unknown token or encoding. An explicit `http://` address sends its login unencrypted. If HTTPS fails for an address entered without a scheme, the app asks before trying HTTP. Settings marks those logins "not encrypted". Statistics and website analytics go to PostHog over HTTPS.

## International transfers

Our PostHog project stores statistics in its EU Cloud region in Frankfurt. EU hosting does not mean all associated processing or access remains in the EU. PostHog's [published data-processing terms](https://posthog.com/dpa) describe international processing, including in the United States, and transfer safeguards such as the EU-US Data Privacy Framework and European Commission Standard Contractual Clauses.

[Vercel](https://vercel.com/legal/privacy-notice), [Cloudflare](https://www.cloudflare.com/privacypolicy/) and [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) also describe processing in the United States and other countries, and safeguards in their privacy and applicable service terms. The terms depend on the service and agreement; a hosting location is not a guarantee against international access. You can contact privacy@mrstreamer.app for information about the safeguards applicable to our processing.

Your device also contacts your provider, TMDB and image hosts directly. Their locations and terms govern those requests; our EU analytics setting does not apply to them.

## Your rights

For personal data we hold, you can request access, correction, restriction or deletion, object where the basis is legitimate interest, and withdraw consent for iPhone statistics. Other rights, including portability, apply where the law provides them. Email [privacy@mrstreamer.app](mailto:privacy@mrstreamer.app). We will respond within one month; if a lawful extension is needed, we will explain it within that first month.

Statistics use a random installation identifier, not your name or email address. An email alone may not identify your installation's records. Desktop users who still have it can provide the `installationId` from `analytics.json` privately. The iPhone app does not display that identifier. Do not send your provider password, stream addresses or other people's data.

If we cannot identify the records concerned, we will explain that limitation and consider additional information you choose to provide. We do not promise that a request automatically identifies or erases records, and the app does not collect your name or email to identify statistics. If the records can be identified, we will handle the request under the applicable rights and explain any limit on the action available. Turning sharing off and deleting local files are separate from this request process.

For data held by your provider or another service acting under its own policy, contact that service. You can complain to the Belgian [Data Protection Authority](https://www.dataprotectionauthority.be/citizen/actions/lodge-a-complaint) or the authority where you live.

## Changes

We update this page when what Mr. Streamer stores or sends changes. We may change it at any time without prior notice, except where the law requires notice or consent. This doesn't limit your rights under data protection law. The [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md) keeps every version.
