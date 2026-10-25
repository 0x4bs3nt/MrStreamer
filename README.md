<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-mark-dark.svg">
    <img src="docs/assets/readme-mark-light.svg" alt="" width="72" height="72">
  </picture>
</p>

<h1 align="center">Mr. Streamer</h1>

<p align="center">Live TV, movies and series.<br>An open source IPTV player for Mac, Windows and Linux.</p>

<p align="center"><strong><a href="https://mrstreamer.app/download">Download</a></strong> · <a href="https://apps.microsoft.com/detail/9N45GG76ZP4T?referrer=appbadge">Microsoft Store</a></p>

<img src="docs/assets/readme-poster.webp" alt="Home with a live preview, favourites and Continue watching, with Live TV and the TV Guide in front of it" width="100%">

- Live TV with favourites and a [programme guide](docs/user/live-tv.md#the-guide). Aired programmes play from their start when your provider keeps catch-up.
- Movies and series with resume, a [watchlist](docs/user/movies-and-series.md#watchlist) and [offline downloads](docs/user/downloads.md).
- Every sound and subtitle track your provider sends, and [online subtitle search](docs/user/playback.md#online-subtitles-from-009) with your own API key.

Stable 0.0.20 is the current release. New in 0.0.20, including its Nightly previews: [custom channel lists and programme reminders](docs/user/live-tv.md#your-lists), [download pause, queue ordering and offline series continuation](docs/user/downloads.md), and [poster-grid keyboard navigation and Back through related titles](docs/user/movies-and-series.md).

The pictures come from a test provider with made-up titles and public-domain footage.

## Your subscription

Connect Xtream Codes or an M3U playlist. Mr. Streamer includes no channels and sells none. [Set up a subscription](docs/user/subscriptions.md).

## Install

macOS 13 or later on Apple silicon, Windows 11 on x64, or x86_64 Linux. [Installers, requirements and checksums](https://mrstreamer.app/download) are on the website, and the files on [GitHub Releases](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/latest). [Updates and channels](docs/user/updates.md) also covers Homebrew and the AUR.

## Help

[Subscriptions](docs/user/subscriptions.md) · [Live TV](docs/user/live-tv.md) · [Movies and series](docs/user/movies-and-series.md) · [Downloads](docs/user/downloads.md) · [Updates and channels](docs/user/updates.md) · [What plays](docs/user/playback.md) · [Troubleshooting](docs/user/troubleshooting.md) · [Privacy](docs/privacy.md) · [Security](docs/security.md)

Found a bug? [Report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with your system, the Mr. Streamer version from Settings > About, and what happened.

## Contributing

Mr. Streamer is open source and under active development. For now it accepts small bug fixes: [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report a bug, run the app and send a fix.

## License

GPL-3.0. See [LICENSE](LICENSE). Installers include FFmpeg and x264, also under the GPL; their exact sources are attached to every release. Settings > About > Open-source licences lists every component the app ships, with its licence.

Movie and series details come from [TMDB](https://www.themoviedb.org). This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB. Where titles stream comes from [JustWatch](https://www.justwatch.com).

<sub>Store screenshots and the trailer include Big Buck Bunny (c) copyright 2008, Blender Foundation, [www.bigbuckbunny.org](https://www.bigbuckbunny.org), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/): excerpts, renamed and subtitled in the demo. Earth views: NASA. Grand Canyon footage: U.S. National Park Service.</sub>

## How it compares

VLC is a general media player. Kodi is compared with its official [IPTV Simple](https://github.com/kodi-pvr/pvr.iptvsimple) add-on.

### Getting set up

|                   | Platforms                                                                             | Xtream / M3U                                     | Guide (XMLTV)                                                                         | Movies and series                                            |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Mr. Streamer**  | macOS (Apple silicon), Windows, Linux                                                 | Xtream login, M3U link                           | Provider or playlist guide, then your own XMLTV guides; grid and catch-up from 0.0.13 | Library with TMDB details; M3U after mapping groups          |
| **TiviMate**      | Android TV                                                                            | Xtream Codes, M3U, Stalker Portal                | TV guide (EPG) grid; XMLTV source not stated                                          | Movies and shows                                             |
| **IPTV Smarters** | Android, Android TV, iPhone, iPad, Apple TV, macOS, Windows, LG and Samsung TVs       | M3U, provider API login (Xtream not named)       | EPG from your source; XMLTV address not stated                                        | Movies and series                                            |
| **IPTVX**         | iPhone, iPad, Apple TV, Apple Vision, Apple silicon Mac, Android, Android TV, Fire OS | Xtream, M3U, also Plex and SMB                   | Server EPG, or your own EPG URL                                                       | Movies and TV shows                                          |
| **VLC**           | Windows, macOS, Linux, Android, iOS, Apple TV                                         | Opens M3U playlists; Xtream login not documented | Not stated                                                                            | Plays playlist entries                                       |
| **Kodi**          | Windows, macOS, Linux, Android, iOS, tvOS, webOS, Raspberry Pi                        | M3U file or URL; Xtream login not documented     | XMLTV file or URL                                                                     | VOD from M3U media entries, listed as recordings or channels |

### Watching later and elsewhere

|                   | Downloads                                  | Live TV recording                              | Casting                                             | Price, source                                                           |
| ----------------- | ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| **Mr. Streamer**  | Movies, episodes; whole series from 0.0.12 | No                                             | AirPlay on macOS, Google Cast on Windows; not Linux | Free, open source (GPL-3.0)                                             |
| **TiviMate**      | Not stated                                 | Yes                                            | Not stated                                          | Free, premium upgrade                                                   |
| **IPTV Smarters** | Not stated                                 | Not stated                                     | Not stated                                          | Apple app: free, ads and a premium purchase; other platforms not stated |
| **IPTVX**         | On iPhone and iPad                         | With IPTVX Media Server on a NAS, Linux or Mac | AirPlay 2, casting to supported targets             | Free download, subscriptions                                            |
| **VLC**           | Convert/Save to a file                     | Record button saves what plays                 | Chromecast                                          | Free, open source                                                       |
| **Kodi**          | Not stated                                 | Not with IPTV Simple                           | Not stated                                          | Free, open source (GPL-2.0)                                             |

<sub>Checked 12 October 2026 against each project's own site, docs or store listing. Not stated means those sources don't say. TiviMate: [tivimate.com](https://tivimate.com), [Google Play](https://play.google.com/store/apps/details?id=ar.tvplayer.tv). IPTV Smarters: [getiptvsmarters.com](https://getiptvsmarters.com/download), [features](https://getiptvsmarters.com/features), [App Store](https://apps.apple.com/us/app/smarters-player-lite/id1628995509). IPTVX: [features](https://iptvx.app/features/index.html), [App Store](https://apps.apple.com/us/app/iptvx/id1451470024), [Google Play](https://play.google.com/store/apps/details?id=com.bendingx.iptvx.android). VLC: [videolan.org](https://www.videolan.org/vlc/), [M3U](https://wiki.videolan.org/M3U), [recording](https://docs.videolan.me/vlc-user/desktop/3.0/en/basic/recording/playing.html), [Convert/Save](https://docs.videolan.me/vlc-user/desktop/3.0/en/advanced/transcode/transcode_and_save.html), [Chromecast](https://www.videolan.org/vlc/releases/3.0.0.html). Kodi: [kodi.tv](https://kodi.tv/download/), [IPTV Simple](https://github.com/kodi-pvr/pvr.iptvsimple), [capabilities](https://github.com/kodi-pvr/pvr.iptvsimple/blob/Piers/src/IptvSimple.cpp), [licence](https://github.com/xbmc/xbmc/blob/master/LICENSE.md).</sub>
