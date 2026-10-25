# Subscriptions

Mr. Streamer plays the subscriptions you add: Xtream Codes access, with a server address, username and password, or an M3U playlist link. Playlists start with live TV; from 0.0.9, explicit group mapping also imports movies and series. You can add several, and everything from all of them shows together. There is no subscription to switch to: Home, Live TV, Movies, Series and search always show every one.

## Adding one

The first one is added on the Connect screen. Every next one in Settings (⌘, or Ctrl ,) > **Subscriptions** > **Add subscription**:

- **Name** is what Mr. Streamer calls it, such as "Holiday house". Leave it empty to go by the server's host.
- Enter the server address, username and password, or choose **Use an M3U link**.
- **Add** checks the login with the provider first. Nothing is saved when the provider rejects it.

Its channels join the lists first, then its guide, movies and series. What you're watching plays on meanwhile. The same account can't be added twice: adding it again updates the one you have.

## Mapping mixed playlists

From version 0.0.9, open a playlist subscription in Settings and choose **Map** beside **Groups**. Choose each group's use: **Live TV**, **Movies**, **Series** or **Skip**. Picks apply immediately. A playlist without mapping keeps its original live-only behaviour.

Groups come from `group-title` or `#EXTGRP`, with semicolons for several memberships. An `#EXTGRP` group applies to following entries until an empty directive or explicit `group-title` resets it. See the [category compatibility matrix](category-compatibility.md) for supported conventions and fixture sources.

Explicit mapping accepts up to 100,000 entries, 64 MiB of unpacked text and 10,000 groups. A larger playlist still loads and plays as unmapped Live TV. Expanding its Settings row, opening its mapping or making its first pick explains the mapping limit and saves no choice. Once a playlist is mapped, a refresh over a limit fails and keeps its previous lists.

Movies and series need supported finite files. HLS movie and episode addresses with a path ending in `.m3u` or `.m3u8`, or `m3u8` in the query, are left out with a reason; HLS remains supported for Live TV.

Once you map a group, new groups wait for your choice. An entry in groups with different choices stays out. **Left out** shows every omitted entry's name, groups and reason, in pages. Stream addresses are never shown there.

Series entries need one clear episode token, such as `S01E02` or `1x02`, with a series name before it. Season zero is supported. Ranges, multiple episode numbers and uncertain names stay out with an explanation. Episodes follow the playlist's order, even across seasons. When it lists several files for one episode, the episode menu lets you pick the exact file.

Movie and episode progress belongs to the exact source file, including its entry's attributes and stream headers. Reordering keeps that progress; replacing a file, rotating its source address or changing an attribute such as its logo address creates a new version which starts from the beginning. After a restart, the app needs to read the playlist to recover playable addresses. A failed refresh keeps the previous lists; a successful empty import clears them.

## Everything together

- **Live TV** lists the channels of every subscription, in the order you added the subscriptions. Categories that are named the same, in the same country, are one category.
- **Movies** and **Series** show a film or series that two subscriptions offer once, when both give the same [TMDB](https://www.themoviedb.org) id for it. Mr. Streamer never joins two titles because their names match.
- **Favourites**, recently watched channels and Continue watching are one list each. [Reorder](live-tv.md#the-guide) arranges favourites from different subscriptions among each other.
- **Watchlist** is one list too. A film or series two subscriptions offer is one entry, saved for both when you press **Save**; see [Watchlist](movies-and-series.md#watchlist).
- **Search** finds channels, programmes, movies and series in all of them.

Where two things read the same but come from different subscriptions, each says which one it is from: a channel both list, or two different films with the same name and year. Everything else shows without a name beside it.

A channel is never joined across subscriptions. The same channel from two providers is two rows, each named for its subscription, because each plays on its own connection and may differ in quality.

Channel numbers stay each provider's own. When two channels share a number, typing it goes to the first one in the list.

## One stream at a time

Mr. Streamer plays one thing at a time, across all subscriptions. Starting a channel, movie or episode from another subscription stops what was playing first, so no provider ever sees a second connection from this app.

Nothing switches to another subscription by itself. When a channel or a film doesn't play, Mr. Streamer says so and leaves the choice to you.

## Picking which subscription plays a title

When several subscriptions offer a film or series, the arrow beside **Play** lists every version with the subscription it comes from. **Automatic** plays the one that suits your language. Pick another and that title plays it from then on.

- A series lists the seasons and episodes of the subscription that plays it. Another subscription may have more, or fewer.
- How far you got belongs to the subscription you watched in. The same film from another subscription is another file, so it starts from the beginning and keeps a position of its own.
- Continue watching carries on in the subscription you were watching.

## Looking after them

Settings > **Subscriptions** lists each one with its kind and how it stands: when it ends, or the days left in its last month, and what plays from it. Click a row to see its account, its login and what was loaded from it. Opening a row only shows it. It never changes what the rest of the app shows.

- **Edit** changes the name, and the password or the playlist link when you type a new one. The server and username can't be changed: another server, username or playlist is another subscription, which you add.
- The refresh buttons beside **Channels**, **Guide** and **Movies and series** fetch that list again, for that subscription alone.
- **Guide** says where that subscription's channels' programmes come from: how many from its own guide, from each of yours in Settings > Guides, and how many have none. **Guides** there opens Settings > Guides, and **Map** gives a channel the guide channel you pick; see [Guides from other addresses](#guides-from-other-addresses).
- **Retry** shows on a subscription whose provider didn't answer, with the time it stopped answering. Its lists stay as they were then, and the other subscriptions carry on. Live TV says the same in one line above the channels.
- **Enter password**, or **Enter link**, shows on a subscription whose saved password or link your system no longer gives back. What was loaded from it still shows; it plays again once you've entered it. See [troubleshooting](troubleshooting.md#mr-streamer-asks-for-my-password-or-playlist-link-again).

## Guides from other addresses

A subscription's programme guide comes from its provider, or from the guide its playlist names. Settings > **Guides** adds XMLTV guides of your own, such as a paid guide service's. Every subscription reads them after its own guide, in the order listed.

- Type an address in the field and choose **Add**, with a name beside it if you like, such as "United Kingdom". Plain XML and gzip both work. It is saved at once and downloads in the background, and its row says how far it got: downloading, reading, then ready, with how many of your channels it supplies, how many programmes it has, how far ahead they run and when it was last updated.
- **A guide goes by its name**, or by its host without one, in its row, its buttons, a subscription's **Guide** and **Map**. The pencil renames it in place: Enter or clicking elsewhere keeps the new name, Escape keeps the old one, and an empty name goes back to the host. Two guides that would read the same, as two from one host without names, or two given one name, each add the first characters of a random code the app gave the guide, such as "epg.example.net 3f9a", which stay with it when it moves. A name can't hold an address: it is kept as you typed it, not encrypted.
- **For each channel, the first guide with programmes for it supplies all of them.** A subscription's own guide comes first, then yours from the top. The arrows move a guide up or down, and the cross removes it with what it downloaded.
- **The address is kept like a password.** It often holds a key, so it is encrypted on your computer and never shown again: Settings shows only its host, and the fields start empty once it is added. An address starting with `http://` travels unencrypted, key included, and the field says so before anything is sent.
- **Nothing falls back.** When a guide's server stops answering, or answers with something else, its row says why in red and since when, with **Retry**, and the programmes it last downloaded stay in use. Guides are downloaded again about every six hours.
- **Times** follow the offset each programme carries, such as `+0200`, and count as UTC without one. They show in your computer's time zone. There is no setting to shift them.

A guide that isn't XMLTV, stops before its end, lists no programmes still to come or is larger than Mr. Streamer reads fails the same way, and the programmes it had stay in use.

From 0.0.13, a guide address you gave a subscription before is in Settings > Guides, with the channels you mapped to it. The same address given to several subscriptions is one guide there. It downloads again straight after the update. Until then it uses the newest of what your subscriptions had downloaded, and a channel you mapped to what only an older download listed shows programmes again once that download is in.

### Channels without programmes

A channel shows programmes when the guide id your provider gives it is one the guide lists, exactly. Mr. Streamer never matches by name: two channels called the same are often not the same channel. **Map**, beside **Mapped channels**, is for the rest:

- The left list has your channels: those without programmes, those you mapped, or all. The field searches them by name or number.
- Pick a channel and the right list has the guides' channels, its own guide's first, each with its name, the name of the guide it is from and its id. Its field starts with the channel's name; change it to search by another name or by id.
- **Map** gives the channel that guide channel's programmes, at once, in Live TV, on Home and in search. A mapped channel uses its mapping alone, and moves from the channels without programmes to those you mapped. **Restore**, on the **Automatic** row, takes it away again.

The arrow keys move through either list. Enter goes from a channel to its guide channels, and maps there.

Mappings stay through restarts, new channel lists and a new order in Settings > Guides. If the guide stops listing a channel you mapped to, or your provider stops listing the channel, the mapping is counted as unresolved and shows no programmes, rather than another channel's. Removing the guide you mapped a channel to counts its mapping as unresolved too, and the channel reads the guides in order again until you map it again or restore it.

## Removing one

Open its row and choose **Remove**. Mr. Streamer asks first, and says what happens:

- What plays from it stops. What plays from another subscription carries on.
- Its login, its lists and its own guide are deleted from this computer, with the channels you mapped. The other subscriptions keep theirs, and the guides of Settings > Guides stay.
- Its favourites, watchlist, history and progress stay, and come back when you add the same account again. From 0.0.20, including its Nightly previews, this also includes channels in your custom lists. Tick **Also delete…** to delete them too, along with saved subtitles. Your custom lists themselves stay. A title on the watchlist that another subscription saved as well stays there either way.
- From 0.0.20, removing a subscription also removes its programme reminders. Finished downloads stay; unfinished downloads are cancelled.
- Removing your only subscription returns to the Connect screen.

## Going back to an older version

Versions before several subscriptions know one: the first you added. Going back to one of them shows that subscription alone and leaves the others on your computer untouched, so they are there again after updating. A version from before 0.0.13 shows each subscription's own guide and not those of Settings > Guides, which stay on your computer for when you update again. If you removed that first one since, the older version asks you to connect. An account you connect there that you had added here shows once after updating, with its favourites, watchlist, history and progress.

Versions 0.0.19 and earlier do not show custom lists or programme reminders. **Also delete** there leaves custom-list membership rows on disk. When you return to 0.0.20 or later, the app purges those rows before displaying lists, even if you added the account again in the older version. That is cleanup on returning, not immediate erasure by the older app.
