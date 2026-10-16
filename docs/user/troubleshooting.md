# Troubleshooting

## Where your data is

Mr. Streamer keeps everything on your computer, in one folder:

| System                  | Folder                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| macOS                   | `~/Library/Application Support/Mr. Streamer`                                                            |
| Windows                 | `%APPDATA%\Mr. Streamer`                                                                                |
| Windows, from the Store | `%LOCALAPPDATA%\Packages\MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr\LocalCache\Roaming\Mr. Streamer Store` |
| Linux                   | `~/.config/Mr. Streamer`                                                                                |

It holds your subscriptions, each with its encrypted password or playlist link, the channels you mapped to a guide, the encrypted addresses of your guides in Settings > Guides with the names you gave them, your preferences, favourites, watchlist, watch history and how far you got in movies and episodes, copies of each subscription's channel list, programme guide and movie and series lists, what TMDB said about your movies and series, your update channel, a diagnostics log, and the analytics preference, random installation identifier and statistics waiting to be sent, described in the privacy policy. Chromium's cache of posters and pictures there stays under 64 MB. Uninstalling leaves the folder in place, so a reinstall picks up where you left off; only the copy from the Microsoft Store takes its folder with it. Delete the folder to remove everything but the password's key in your keychain and a downloaded update; the [privacy policy](../privacy.md#deleting-your-data) says where those are.

Your password, or a playlist's link, is encrypted with a key your system keeps: the macOS Keychain, Windows' user encryption, or the desktop keyring on Linux.

## Mr. Streamer asks for my password or playlist link again

Your system no longer gives Mr. Streamer the key to your saved password. That happens after a keychain reset, when you deny access, or after replacing the app with a differently signed build. Mr. Streamer still opens, and shows the channels, movies and series it loaded before; they play again once the password is back. Settings > Subscriptions says which subscriptions need theirs, each with **Enter password**: type it there, and the rest of the login stays as it was.

For a playlist, the whole link was encrypted, because a link can hold a token. Mr. Streamer can only say which host it came from, so paste the link again with **Enter link**. It stays the same subscription, with its favourites and watch history.

On macOS, if it keeps asking: open Keychain Access, delete the item named **Mr. Streamer Safe Storage**, then quit and reopen Mr. Streamer.

## Windows warns about the installer

The Windows installer isn't code-signed yet, so SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. Your antivirus may ask as well.

## Linux

- **The AppImage doesn't open:** it needs FUSE 2. On Ubuntu, run `sudo apt install libfuse2t64`. Without it, starting it from a terminal with `--appimage-extract-and-run` also works.
- **The login doesn't stay saved:** Mr. Streamer stores the password key in GNOME Keyring or KWallet. Without either, it uses Chromium's fixed-key encryption instead, so the login still saves, but other programs running as you can read it.

## Channels or login stop working

- **"… has no encrypted connection":** the address you typed doesn't work over https, so Mr. Streamer stopped before sending your login. **Connect without encryption** connects over http instead: your username and password then travel as plain text, so anyone on your network or between you and your provider can read them. If your provider offers an https address, use that. An address you type with `http://` connects over http straight away; the line under the field says so, and Settings > Subscriptions marks the login "not encrypted".
- **"The server doesn't offer an encrypted connection at this address":** you typed `https://`, and the server answers only over http. Mr. Streamer never falls back to http on its own. Type the address without `https://` to be asked, or with `http://`.
- **"The provider rejected this username or password":** check the login with your provider, then choose **Edit** on that subscription in Settings > Subscriptions and enter the password again.
- **"Refused by the provider" on a channel:** the provider turned that stream down, and the line under the message has its HTTP status. Mr. Streamer can't tell the reason from the status. If another device or app is watching on the same subscription, stop it there and choose **Retry**. If every channel is refused, check with your provider whether the subscription is still active. On a public playlist, a refused channel is often one that only plays in certain countries.
- **A channel keeps reconnecting, then says "Lost the stream" or "Keeps dropping":** the stream stopped arriving. Mr. Streamer reconnects four times and then stops, so it never loops. **Retry** starts again with four more, and **Quality** offers the channel's other streams, which sometimes hold better. Several channels dropping at once points to your connection or the provider.
- **No programme information for a channel:** your provider's guide doesn't cover it. Many providers cover only some channels. A playlist's guide is the one its first line names, and many name none: that subscription's details in Settings > Subscriptions then say "none in this playlist" beside Guide. That is no error. The refresh button there reads the playlist's first line again, so a guide its publisher adds later is found, and one it drops goes. When a guide download fails, the last guide stays in use and Mr. Streamer tries again later; the Guide row says why, and **Retry** there tries now. A channel the guide does list under another id can be given it by hand: see [Channels without programmes](subscriptions.md#channels-without-programmes).
- **A guide in Settings > Guides says "Failed since …":** its server didn't answer, or answered with something else. The programmes it last downloaded stay in use, and your provider's guide doesn't take their place. **Retry** tries again; the arrows move another guide above it.
- **A guide address fails:** its row in Settings > Guides says why, or the line under the field when the address itself isn't one. "Not with an XMLTV guide" means the address answered with something else, usually a sign-in or error page, so check the address and its key. "Stopped before its end, or is damaged" is a download cut short or a broken file. "Every programme in this guide has ended" is a guide its publisher no longer updates. A guide over 2 GB unpacked or 50,000 channels is larger than Mr. Streamer reads: ask its publisher for a smaller one, such as one country's.
- **A guide says "needs its address again":** your system no longer gives Mr. Streamer the key that encrypts the saved address, as after the app's signature or your keychain changed. The listings it downloaded still show. Add the same address once more in Settings > Guides: it keeps its place and your mapped channels.
- **"Channels unavailable":** the provider didn't send the channel list. **Try again**, or check your internet connection. When a refresh fails, Mr. Streamer keeps showing the last channel list it received, and Settings > Subscriptions says why the list may be out of date, under the subscription it is about; the refresh button beside Channels tries again.
- **No Movies, Series or Watchlist in the top bar:** an unmapped playlist brings live TV only. From 0.0.9, they also show once you [map a playlist's groups](subscriptions.md#mapping-mixed-playlists), or when one of your subscriptions has an Xtream login.
- **One subscription's channels or titles are missing:** its provider didn't answer, or its password is needed again. The others show as usual. Settings > Subscriptions says which under its row, with **Retry** or **Enter password**; see [Subscriptions](subscriptions.md#looking-after-them).
- **Movies or Series stay empty:** the first load of a large list takes a few seconds. If the provider offers no movies or series, the pages say so. A failed refresh keeps the last lists; Settings > Subscriptions says why under that subscription and refreshes them on their own.
- **No genres or streaming services:** they come from TMDB, which takes about a quarter of an hour the first time on a large subscription. Settings > General shows how far it got beside TMDB, or that TMDB refused the key; **Own key…** takes your own. Titles your provider lists without a TMDB id never get them.

## Playing on a TV

- **No TV in the list on Windows:** the list shows Google Cast devices that answer on your network. The TV and your computer have to be on the same network, and guest and "isolated" Wi-Fi networks keep devices from seeing each other. A VPN on your computer hides the network from Mr. Streamer too.
- **No TV in Apple's list on macOS:** the list is macOS's own, and Mr. Streamer can't see what is in it. Turn AirPlay on in the TV's settings and check that both are on the same network. If macOS asked whether Mr. Streamer may find devices on your local network and you declined, allow it in System Settings > Privacy & Security > Local Network.
- **"… didn't answer":** the TV was found and didn't take the connection. Check that it's on, then **Try again**.
- **"… got no stream":** the TV connected and never fetched the stream from your computer. On Windows the firewall is the usual cause: in Windows Security, open **Allow an app through firewall** and tick **Private** for Mr. Streamer. On any system, a VPN or a TV on another network does the same.
- **"… can't play this":** the TV took the stream and couldn't play it. **Play here** carries on in Mr. Streamer. Please report it with the TV's make and model.
- **"… connection lost":** the TV stopped answering, as when it is switched off or leaves the network. **Try again** connects again and carries on from where it stopped.
- **"No local network":** your computer is offline or on a VPN only, so a TV can't reach it.
- **The TV stops when the computer sleeps:** the stream comes from your computer. Mr. Streamer keeps it awake while a TV plays, and closing a laptop's lid still puts it to sleep.

## Updates

- **"GitHub is limiting requests":** Mr. Streamer asked GitHub directly, because the update list it normally reads wasn't there, and GitHub allows only so many requests an hour from one network, shared by everyone on it. Mr. Streamer waits until GitHub allows requests again and tries by itself; nothing needs doing.
- **"You seem to be offline":** check your connection; Mr. Streamer tries again later on its own.
- **An update didn't install:** Settings shows why. **Try again** downloads it again, or install it by hand from the [Releases page](https://github.com/Mr-Streamer-OSS/MrStreamer/releases).

## Still stuck

[Open an issue](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with your system, the Mr. Streamer version from Settings > About, and what happened. Leave out your server address, username and password.

`diagnostics.log` in the same folder helps too: what Mr. Streamer did, how long it took and what failed. It holds no addresses, logins or channel names, and never leaves your computer unless you attach it.
