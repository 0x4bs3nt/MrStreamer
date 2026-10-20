# About Mr. Streamer

Mr. Streamer is a free, open source IPTV player for Mac, Windows and Linux. Bring your own Xtream Codes subscription or M3U playlist. It includes no channels and sells none.

## What it plays

- Live TV from Xtream Codes or an M3U playlist, with a programme guide when your provider or playlist supplies one, as a list or a grid by time. You can add XMLTV guides of your own, which fill in the channels it doesn't cover. Programmes that aired play from their start when your provider keeps catch-up.
- Movies and series from Xtream Codes or a playlist whose groups you mapped in Settings, with a watchlist and saved progress. Playlist movies and episodes need finished files; HLS entries stay out.
- The sound and subtitle tracks your provider sends. See [What plays](user/playback.md) for formats, playback on a TV and limits.

You can [download movies and episodes](user/downloads.md) to watch offline. Mr. Streamer does not record live TV, bypass DRM or provide an IPTV subscription. It has no ads or account. Your provider decides what you can watch.

It reads MPEG-TS and HLS live streams, MP3 and AAC radio, and MKV, MP4 and AVI movies and episodes. Playback depends on the file's tracks and your system's decoders; [What plays](user/playback.md) describes conversion and the known limits. DASH streams are not supported.

## Systems

| System  | Requirements                                                                |
| ------- | --------------------------------------------------------------------------- |
| macOS   | macOS 13 or later, Apple silicon                                            |
| Windows | Windows 11, 64-bit                                                          |
| Linux   | 64-bit Linux. The AppImage needs FUSE 2; the .deb is for Ubuntu and Debian. |

[Downloads](https://mrstreamer.app/download) lists the stable installers, checksums and release sources. [Updates and channels](user/updates.md) explains Stable, Nightly and Microsoft Store updates.

## Your data

Logins, preferences, favourites, watchlist, history and progress stay on your computer. Provider logins go to the provider in each request. From 0.0.11, usage statistics default on and can be turned off in **Settings > Privacy**: first-seen profiles and daily app use, and from 0.0.12 the parts of the app opened, playback, download and update-check results, and unexpected window stops. Viewing history and provider details are excluded; builds without a configured PostHog project send no app statistics. The [privacy policy](privacy.md) describes its connections and the website's analytics; [Security](security.md) explains login storage and installer signing.

## Licence and source

Mr. Streamer is made by Mr Streamer OSS, based in Belgium, and licensed under [GPL-3.0](../LICENSE). The [source repository](https://github.com/Mr-Streamer-OSS/MrStreamer) is public. Each release carries source archives for the dependencies whose licences require them.

This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.
