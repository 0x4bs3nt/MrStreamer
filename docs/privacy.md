# Privacy policy

Last updated 13 October 2026. Earlier versions are in the [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md).

Mr. Streamer is a free, open-source IPTV player for your computer. It has no account, shows no ads and doesn't sell data. Nothing you watch passes through us.

Wout Stiens in Belgium, publishing as Mr Streamer OSS, is responsible for the data we receive. Contact [privacy@mrstreamer.app](mailto:privacy@mrstreamer.app).

## Information we collect

### On your computer

Most of what the app handles never reaches us. It stays in its data folder ([where it is](user/troubleshooting.md#where-your-data-is)):

- your subscriptions: server address, username, and password or playlist link
- preferences, including your own TMDB key if you entered one
- favourites, watchlist, the channels you watched, your progress and the episodes you marked
- copies of each provider's channel, guide, movie and series lists, and what TMDB said about them
- downloaded movies and episodes, with their details, pictures, subtitles and progress
- subtitle-service settings and saved subtitles, if you turn subtitle search on
- the statistics setting, its installation identifier, up to eight statistics waiting to be sent, and, from 0.0.12, the counts for the current day and at most one earlier day
- a diagnostics log with no addresses, logins or channel names

We can't see, copy or delete any of it. **Diagnostics…** in Settings > About shows you the text before you save it and uploads nothing.

### Usage statistics

**Share basic usage statistics** is on by default, in new and existing profiles, without a prompt. From 0.0.12, while it's on, the app counts on your computer how often you open each part of the app, from a fixed list: Home, Live TV, Movies, Series, Watchlist, Downloads, Search, Settings, the player and title details. It counts how many playback requests, download runs and update checks started, succeeded, failed or were interrupted, with one of six fixed reasons for each failure, such as "network" or "disk". A playback request succeeds when the app gets the stream ready to play. It doesn't show whether picture or sound played. An update check succeeds when it gets an answer, even with no new version, and installing an update isn't counted. The app also counts how often its window started and how often it stopped unexpectedly. Closing the window or quitting doesn't count, and a crash of the whole app or a power cut can't be counted.

From 0.0.12 the app also adds up, for each day, how many live channels and how many movies and episodes started playing, how many of those failed or stopped with an error, with one of the fixed reasons, and how many minutes of each played, rounded to whole minutes. These are totals for the day. They don't say what played, from which subscription, or at what time.

Counting also runs with the window in the background, for example during downloads and update checks. The app queues statistics only while its main window is in the foreground: an observation the first time it observes this profile, at most one per UTC day after that, and, from 0.0.12, with it one summary of the most recent earlier day's counts. It sends each to PostHog straight away and tries up to three times in all, so a retry can happen with the window in the background, as you quit or after the next start. Up to eight wait on your computer. Beyond that the oldest are dropped, keeping the first observation. Only the most recent earlier day is kept, so counts for older days that were never queued are dropped. If the app version or update channel changes during a day, that day's counts start again from zero. Builds without our project configuration count and send nothing.

Each observation and summary carries a random installation identifier, an event identifier, the time it was queued, the app version, build and update channel, operating system, processor type, whether the app came from the Microsoft Store or our download, and whether the profile looked new, upgraded or unknown when the app first observed it. A summary also has the UTC day it counts, with the version, channels and system it was counted under.

Statistics never include what you watch, title or channel names, your provider or its address, stream addresses, logins, searches, file paths, logs or error messages. There is no autocapture, session replay, crash dump or log upload. The identifier doesn't name you but links your observations and summaries, so the data is pseudonymous, not anonymous. Person profiles and location lookup are off in PostHog. PostHog receives your IP address with each request, as any server does, and our project is set not to store it.

### The website

mrstreamer.app is hosted by Vercel, which receives your IP address and browser identification with each request, as any web host does.

To link the newest installers, the home, download and about pages ask GitHub for the public list of releases. GitHub gets your IP address and browser identification.

### Website analytics

Website analytics are on unless your browser sends Global Privacy Control or Do Not Track. Turn them off with **Site analytics** at the foot of any page of mrstreamer.app. Your browser keeps only that choice, in its local storage. There is no cookie, and your browser stores no identifier.

While they're on, each page you open sends PostHog a few events: which of our pages it is, roughly how long it was in view, and which of these you used on it: a download link, with its system and file type, a link to a guide or to GitHub and whether it was in the header or footer, a section of a guide, a part of the home page, a question in the FAQ, or a release in the release notes. It also sends how far down the page you scrolled, and three measures of its speed: how long its largest image or text took to show, how quickly it responded to your clicks, taps and keys, and how much its content shifted. These are numbers only, without the parts of the page involved. Each event names the page by its own address on mrstreamer.app, such as https://mrstreamer.app/faq, not the address in your browser.

PostHog counts visitors and visits without a cookie. Each event carries your browser identification, and PostHog's servers combine it with your IP address, our site's name, our project and a random value that changes every day into a one-way code, a hash. PostHog then deletes the IP address and browser identification from the event and keeps the code. The code ties together the pages you open that day and splits them into visits, so it is pseudonymous, not anonymous. It changes the next day and isn't linked to the app. PostHog says it deletes each day's random value once that day's events are processed. People on the same network with the same browser can share a code.

Website analytics never include the address you came from, anything after a ? or # in an address, what you type, your location, or details of your device or browser beyond the browser identification used for that code. There is no autocapture, session replay or person profile. PostHog receives your IP address and browser identification with each request, as any server does, and our project is set not to store the IP address.

If your browser sends Global Privacy Control or Do Not Track, website analytics stay off and can't be turned on. Turning them off sends nothing more, and nothing is sent about the time they were off. Turning them on sends nothing about the page you're on. Counting starts on the next page you open. Without JavaScript nothing is sent.

### Messages you send

Email to privacy@, hello@ or security@mrstreamer.app, and issues you open on GitHub. Issues are public, so leave out your server address and login.

## How we use it

- **Usage statistics**, to count which versions, builds, systems and features are in use, how much live TV and how many movies and series play, and how often playback, downloads, update checks and the app's window fail, so we know what to fix and support.
- **Website analytics**, to count visits, see which pages, guides and questions people read and which downloads they pick, and see how far pages are read and how quickly they load and respond.
- **Messages**, to answer you and fix what you report.

Our legal basis for all three is legitimate interest (GDPR Article 6(1)(f)). You can object at any time by email, or for statistics and website analytics by turning them off. We don't use any of it for advertising. App statistics and website analytics share a PostHog project but use separate events and identifiers, and we don't link them.

## Who receives what

### Services you use through the app

The app contacts these straight from your computer, not through us. Their own policies apply.

- **Your provider** gets your login, IP address and app version, and sees what you open, watch and download. Each provider gets only its own login and requests, and learns nothing about your other subscriptions.
- **Servers a playlist or guide address names** get your IP address, the app version and the stream or guide requested. A playlist can supply its own browser identification and referrer for a stream. A guide address can carry its own key. The app refreshes a guide from another address about every six hours.
- **[TMDB](https://www.themoviedb.org/privacy-policy)** gets the titles your providers list, your language and country, an API key (ours or your own) and your IP address. Never your provider's address or login.
- **Image servers** named by your provider or TMDB get your IP address, the image requested, your language, and the app and system version.
- **[OpenSubtitles](https://www.opensubtitles.com/en/privacy)** and **[SubDL](https://subdl.com/privacy)**, only after you turn subtitle search on and search: the title's TMDB id, or its name and year, the episode, languages, the service's API key and your IP address. OpenSubtitles also gets your username and password when you download a subtitle.
- **[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)** gets your IP address and app version with each update check, about 20 seconds after start and every four hours, sooner after a failed check. Microsoft Store copies update through the Store instead.
- **A TV you pick** on your network gets a stream address on your computer that only works while it plays. Never your login or your provider's address. A Google Cast device also gets the title and its TMDB picture address.

Downloaded copies play without a request to your provider. Statistics and update checks still run as set.

Your network operator and DNS provider can see which servers the app contacts.

### Services that work for us

- **[PostHog](https://posthog.com/privacy)** stores app statistics and website analytics in its EU Cloud.
- **[Vercel](https://vercel.com/legal/privacy-notice)** hosts the website.
- **[Cloudflare](https://www.cloudflare.com/privacypolicy/)** handles delivery of messages sent to hello@, privacy@ and security@mrstreamer.app through [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/), to the mailbox provider where we read them.

## Your choices

- **Statistics.** Turn off **Share basic usage statistics** in Settings > General > Privacy. Counting stops, statistics waiting to be sent and unsent counts are cleared, and it stays off after a restart. Turning it back on keeps the same identifier, starts counting from zero and sends nothing about the time it was off.
- **Website analytics.** Turn off **Site analytics** at the foot of any page of mrstreamer.app. The choice applies to that browser only, and clearing the site's data from your browser turns them back on.
- **Subtitle search** is off until you turn it on.
- **Casting** happens only after you open the receiver list and pick a device.
- **TMDB and update checks** have no off switch. Settings only lets you choose whose TMDB key the app uses.

### Deleting your data

- **Remove** on a subscription in Settings > Subscriptions deletes its login, lists, guide and mapped channels, and cancels its unfinished downloads. Tick **Also delete favourites, watchlist, history and progress** to delete those and its saved subtitles too. Finished downloads stay until you delete them.
- **The cross** on a guide in Settings > Guides deletes its address, its name and what it downloaded. Every subscription reads those guides, so removing a subscription keeps them.
- **Delete** on a download deletes the copy with its details, pictures, progress and subtitles.
- **Deleting the data folder** deletes everything else, including the statistics setting, so a new folder starts with statistics on. To also remove the password key, delete "Mr. Streamer Safe Storage" in Keychain Access on macOS or the matching entry in your Linux keyring. A downloaded update stays in `~/Library/Caches/mrstreamer-updater` on macOS, `%LOCALAPPDATA%\mrstreamer-updater` on Windows or `~/.cache/mrstreamer-updater` on Linux until you delete that folder.
- **Statistics already sent** stay with PostHog when you turn the setting off. Email privacy@mrstreamer.app with the `installationId` from `analytics.json` in your data folder, so we can find them.

## Retention

- **On your computer:** until you delete it. Uninstalling keeps it, except for the Microsoft Store copy, which Windows deletes with the app.
- **App statistics:** our PostHog project is on the free plan, which PostHog lists with one year of data retention, and says older data may be deleted. We haven't set up any deletion of our own, and we can't promise the exact day PostHog deletes.
- **Website analytics:** the same PostHog project, plan and terms as app statistics.
- **Messages:** as long as we need to answer and fix what you reported. GitHub issues stay public until deleted.

## Security

Passwords, playlist links, guide addresses and subtitle-service logins are encrypted with a key your system keeps: the macOS Keychain, your Windows account, or GNOME Keyring or KWallet on Linux. On Linux without a keyring the key is fixed, so other programs running as you can read them. Server addresses, usernames and your own TMDB key aren't encrypted.

An `https://` address never falls back to http, including through redirects. If https fails for an address you typed without one, the app asks before sending your login over http, where anyone between you and your provider can read it. Settings marks those logins "not encrypted". Statistics and website analytics go to PostHog over https.

## International transfers

PostHog stores our statistics and website analytics in Frankfurt. Its published data processing agreement says PostHog Inc. may also process them outside the EU, including in the US, under the EU-US Data Privacy Framework and Standard Contractual Clauses. Vercel and GitHub are US companies and rely on the same two mechanisms. Cloudflare is also a US company. Its privacy policy describes transfers under the EU-US Data Privacy Framework, with Standard Contractual Clauses for other transfers or if that certification lapses. Services you use through the app, such as TMDB, get data straight from your computer wherever they are.

## Your rights

For data we hold, mainly statistics and messages, you can ask for a copy, correction or deletion, ask us to restrict its use, and object to it (GDPR Articles 15 to 21). Email privacy@mrstreamer.app and we'll answer within one month. For data held by your provider or another service above, contact them.

You can complain to the Belgian [Data Protection Authority](https://www.dataprotectionauthority.be/citizen/actions/lodge-a-complaint) or the authority where you live.

## Changes

We update this page when what Mr. Streamer stores or sends changes. We may change it at any time without prior notice, except where the law requires notice or consent. This doesn't limit your rights under data protection law. The [history on GitHub](https://github.com/Mr-Streamer-OSS/MrStreamer/commits/main/docs/privacy.md) keeps every version.
