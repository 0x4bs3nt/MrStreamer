# What plays

## Live channels

Mr. Streamer plays live channels your provider delivers as MPEG-TS, the format most Xtream Codes providers use, and radio channels that send plain MP3 or AAC audio.

An M3U playlist lists most channels as HLS, addresses ending in `.m3u8`. Those play as they arrive, without converting: H.264 video with AAC or MP3 sound everywhere, and HEVC on macOS. Where a stream offers several sound tracks, subtitles or closed captions, **Sound** and **CC** list them as on any channel, and another sound track plays without the channel starting again. Mr. Streamer leaves out playlist entries it can't play at all: DASH (`.mpd`) and addresses that don't start with `http` or `https`, such as `rtmp`.

Most channels play directly. For the rest, Mr. Streamer converts only what the player can't handle, on your computer, while you watch:

| The channel sends                                                  | What happens                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| H.264 video with AAC or MP3 sound                                  | Plays directly                                                                |
| Sound in MP2, AC-3 (Dolby Digital) or E-AC-3                       | The sound is converted to stereo AAC; the picture stays as it is              |
| HEVC (H.265) video on macOS                                        | Plays directly, including 10-bit and 4K                                       |
| HEVC video on Windows or Linux without a hardware decoder          | The picture is converted to H.264; 4K is reduced to 1080p                     |
| MPEG-2 video                                                       | The picture is converted to H.264 and deinterlaced                            |
| A picture the player can't decode because the broadcast is damaged | Mr. Streamer retries once with the picture re-encoded, which hides the damage |
| Several sound tracks                                               | The one in the language you picked last plays, else the channel's first       |
| DVB subtitles                                                      | Drawn over the picture                                                        |
| Teletext subtitles and closed captions                             | Shown under the picture                                                       |

Converted channels take a moment longer to start, about a second, and use more of your computer's processor, especially when the picture is converted.

## Movies and episodes

Providers keep movies and episodes as files, mostly MKV and MP4 and a few AVI. Mr. Streamer reads which picture, sound and subtitle tracks a file holds when you open it, then plays it from where you ask with the tracks you pick. As with channels, only what the player can't handle is converted:

| The file carries                                         | What happens                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| H.264 video with AAC, Opus or FLAC sound                 | Plays as it is                                                            |
| Dolby Digital (AC-3 or E-AC-3), DTS, TrueHD or MP3 sound | Converted to stereo AAC, unless your system plays it as it is             |
| HEVC (H.265) video                                       | Plays as it is on macOS; converted to H.264 where there's no HEVC decoder |
| VP8, VP9 or AV1 video, from 0.0.16                       | Converted to H.264, including 10-bit VP9 and AV1                          |
| MPEG-4 Part 2 (Xvid) or MPEG-2 video                     | Converted to H.264                                                        |
| SubRip, ASS or MP4 text subtitles                        | Shown under the picture                                                   |
| Subtitles stored as pictures (Blu-ray, DVD, DVB)         | Drawn over the picture                                                    |
| Teletext subtitles and closed captions                   | Shown under the picture, like text subtitles                              |

From 0.0.16, VP8 conversion supports WebM and MKV files; VP9 and AV1 also support MP4. Converted video uses 8-bit SDR output; HDR preservation is not supported.

A movie starts about a second after you choose it. Skipping into what's already loaded is instant; skipping further away starts it again from there, which takes about a second too. With subtitles on, the picture starts as soon as without them, and the subtitles already on screen at that moment follow as soon as Mr. Streamer has read them. While Mr. Streamer is still reading and no line shows, "Subtitles loading" shows at the top right and **CC** says "Loading" beside the track. Text that shows is never called loading, also while an earlier line is still being looked for or right after you move the timing.

## Online subtitles, from 0.0.9

Online search starts off. In Settings > Subtitles > Online search, set up SubDL with your own API key, or OpenSubtitles with your API key, username and password, or both. Choose saved languages and enable search. Saving these settings makes no service request.

For a movie or episode playing on this computer, open **CC** and choose **Search subtitles**. Opening CC alone does not search. You can pick another search language in the panel, and **Settings** there opens the online subtitle settings. File tracks stay above the results, which show the release, service, language, hearing-impaired flag and download count when provided. If one service fails, the other service's results remain usable. Choose a result to download it and show it while the picture continues. The panel stays open to try another result. **Escape** or CC closes it; closing while a request runs cancels that request.

A search sends the known TMDB identity, or the title and year when no identity is known, with episode coordinates and languages. Text searches can return another release or cut, so check it against the picture. Provider logins, playable addresses and file request headers are never sent. OpenSubtitles logs in when you download, and that download may consume its allowance. The panel shows only an allowance reported by the service, without assuming a daily limit.

Downloaded SRT and WebVTT text is kept on this computer for the exact movie or episode version. The last selected result shows again when you reopen that file, whatever your subtitle language setting is. If you last chose **Off** or one of the file's own tracks there, it stays listed under **Saved for this version** with its timing and does not show until you choose it again. While a file has a saved result, choosing **Off** or one of its own tracks turns the downloaded result off for that file only and leaves your subtitle language for other titles as it was. Which of the file's own tracks you picked is not kept. The next time the file opens, its own tracks follow your subtitle language as on any title. Up to eight recent downloaded results per exact file keep their own timing, so switching back to one makes no new download. **Forget downloaded subtitles** removes all saved results and timing for that file. When removing its subscription, tick **Also delete favourites, watchlist, history and progress** to remove them too. Otherwise they remain on this computer. Replacing the listed file or a replacement observed during playback prevents an old correction from carrying over. When the provider puts another file behind a title while it plays, its downloaded subtitle leaves the picture and the panel at once, the file's own tracks stay, and online search for it returns when you open the title again.

Under **Timing** in the same panel, downloaded text has 0.1-second and 1-second steps and a typed offset up to ten minutes either way. **Drift and frame rate** opens a drift ratio and all six frame-rate conversions between 23.976, 24 and 25 fps. The labels run from subtitle FPS to video FPS. A conversion keeps its exact ratio; the field shows it to five decimals. **Reset** restores zero offset and normal drift for the selected result. **Try the next result**, beside the results, switches to the next one already fetched. **G** and **H** shift 0.1 seconds; **Shift+G** and **Shift+H** shift one second. Each selected result remembers its own correction. File-track timing retains its 30-second limit; picture subtitles have no timing control.

Downloaded subtitles and their timing play on this computer only. A receiver keeps the file's supported subtitle tracks. Returning to this computer restores its saved download, unless you had turned it off for that file on this computer.

## Playing on a TV

Mr. Streamer sends what you watch to a TV on your network: with AirPlay on macOS, and with Google Cast on Windows. The Linux builds play on the computer only. The TV fetches the stream from your computer, so the computer has to stay on and on the same network for as long as the TV plays. Mr. Streamer keeps it awake meanwhile.

For Live TV in 0.0.8, use the TV button beside the volume. From 0.0.9, open **More > Play on** instead. Movies and episodes keep the TV button beside the volume. **O** opens the chooser from either player. On Windows, pick a Cast device from the list. On macOS, **AirPlay** in Play on opens Apple's list; a title's TV button and **O** open it directly. A TV may ask for a code the first time. What you watch plays on here until the TV answers, and **This computer** cancels.

While the TV plays:

- The controls in Mr. Streamer work the TV: pause, skipping, the scrubber, the next episode, channel up and down, and the volume where the TV lets an app set it. They show what the TV last confirmed, so a pause from the TV's own remote shows too, for a channel as for a movie. After a skip the scrubber stays where you put it, with a ring where the TV still is, until the TV catches up.
- **Back** and **Escape** leave the player and the TV plays on. A bar at the foot of every page says what plays where, with Stop and **Play here**; clicking what plays opens its controls again.
- **Stop** ends the stream and keeps the TV, so the next thing you play goes there too. **Disconnect** in the bar then lets the TV go.
- **Play here** ends playback on the TV and carries on in Mr. Streamer from where the TV was, with the same sound and subtitles.
- Home and Live TV show no preview, since one thing plays at a time and the TV has it.
- Closing the window on macOS leaves the TV playing. The next episode still starts by itself and the media keys still work the TV, and the Dock icon brings the window back. Quitting Mr. Streamer ends it. On Windows, closing the window quits.
- How far you got in a movie or episode is saved as it is on your computer.

| What you play                                              | What the TV gets                                    |
| ---------------------------------------------------------- | --------------------------------------------------- |
| H.264 video with AAC sound                                 | Sent as it is                                       |
| Other video or sound, such as HEVC or Dolby Digital        | Converted to H.264 and stereo AAC on your computer  |
| Text subtitles of a movie or episode                       | Shown by the TV                                     |
| Subtitles stored as pictures, teletext and closed captions | Play on this computer only; the menu says Here only |
| A channel's subtitles                                      | Play on this computer only                          |

A movie or episode starts later on a TV than on your computer, and so does a skip to a part the TV hasn't loaded: your computer cuts the stream into pieces of a few seconds for it. For the same reason a channel plays some seconds behind what your computer would show.

## Known limits

- Live subtitles show from their next line after you turn them on, and another sound track starts the channel again, except on HLS channels.
- An HLS channel shows the subtitles its stream lists and the closed captions in its picture. DVB subtitles and teletext inside an HLS stream don't show.
- Surround sound that needs converting plays as stereo.
- After you skip in a movie or episode, the subtitle already on screen at that moment can't always be had: Mr. Streamer reads only a little of the file for it, and only while the picture can spare the connection. That works for MKV files when the subtitle began shortly before, and for MP4 files with text subtitles; a line that began long before, a slow connection, and other kinds of files leave it out. While no line shows, "Subtitles unavailable" shows at the top right, the movie plays on, and the subtitles are back from the next line. The same happens when the subtitles stop arriving altogether.
- Closed captions come from the CEA-608 data most broadcasts carry. A channel or file that sends captions only in the newer CEA-708 form shows none.
- Converting an HEVC or Xvid picture uses much more of your computer's processor than playing it as it is.
- A damaged broadcast can take more than ten seconds to start, while Mr. Streamer retries it with the picture re-encoded.
- Interlaced channels that play directly, common in European HD broadcasts, aren't deinterlaced; fast motion can show fine horizontal lines.
- On a TV, a movie or episode plays at normal speed, subtitle timing can't be shifted, and the mini player is off, since it has no picture to show. Video the TV could play itself, such as HEVC, is still converted on your computer.
- Playing on a TV is new. If yours doesn't show up or doesn't play, please [report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with its make and model.

## When something won't play

Mr. Streamer tells you why. The cross at the top right of the message closes it, also with Tab and then Enter or Space; the channel or title stays stopped, and **Watch** or **Play** beside the picture tries it again. A new failure shows its own message.

For a channel, a small line under the message adds what Mr. Streamer observed: the provider's HTTP status, the qualities it tried, how often it reconnected and the time. Your provider's address and login never show.

- **No stream right now**: the provider lists the channel and answered 404 or 410 for its stream. Try again later or pick another channel. With a quality picked for the channel it reads **No Full HD stream**, and your pick stays.
- **Refused by the provider**: the provider turned the stream down, with a status such as 401 or 403. The status doesn't say why. On a subscription, check whether another device is watching, since many allow one connection. On a public playlist, some channels only play in certain countries. Mr. Streamer stops at a refusal instead of trying more streams against it, and offers no other quality.
- **Provider is limiting requests**: the provider answered 429. Wait a moment before trying again.
- **Provider error**: the provider answered with another error, such as 502 or 503, instead of the stream.
- **No answer from the provider**: the provider didn't answer, or sent nothing, also after four reconnects.
- **No picture arrived**: the provider answered and nothing with a picture or sound came, also after four reconnects.
- **Lost the stream**: the channel played, stopped arriving, and four reconnects didn't bring it back. Often a network problem.
- **Keeps dropping**: the channel came back and broke off again within 30 seconds each time, until its four reconnects were used. Another quality may hold better.
- **Can't play this stream**: the stream arrived and Mr. Streamer couldn't play or convert it, also after one try with the picture re-encoded. Please [report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with the channel's name.
- **Login not accepted**: the provider rejected your username or password when the channel opened. **Update login** opens that subscription in Settings > Subscriptions, where you enter the password again.
- **… needs its password again**, or its link for a playlist: your system no longer gives Mr. Streamer the saved password or link of the subscription this plays from. **Enter password**, or **Enter link**, opens it in Settings > Subscriptions. The lists still show what it loaded before.
- **Can't play this title**: the file uses a format Mr. Streamer can't play or convert. Please [report it](https://github.com/Mr-Streamer-OSS/MrStreamer/issues/new/choose) with its name and the details shown.
- **Not available**: the provider has no file for that movie or episode right now; some providers list titles whose files are gone.
- **… didn't answer**, **… connection lost**, **… got no stream** or **… can't play this**, with your TV's name: see [Playing on a TV](troubleshooting.md#playing-on-a-tv).
