# Downloads

This guide covers the latest desktop release. See [Updates and channels](updates.md) to update an older installation.

Download a movie, an episode or a whole series and watch it later on this computer, without a network connection and without a subscription. Pause downloads, reorder the queue, and watch a downloaded series episode after episode.

## Downloading

- **Movies:** open the movie and press **Download**, beside **Play** and **Save**. It downloads the version **Play** would play, so pick another with the arrow beside **Play** first if you want that one.
- **Series:** open **Download**, beside **Play** and **Save**. Its menu names every available season, including Specials, and the selected provider version. Pick another version with Play’s arrow first. Confirm **Download … episodes** to add the remaining episodes to the end of the queue. Each episode uses the file its row would play, including its resumed file when still listed. Already downloaded or queued files are skipped; failed files are retried. A partial result names files that could not be added and offers **Retry**, while successful additions stay in the queue. The menu also offers **Retry failed**, **Cancel the rest** and **Open Downloads**. New episodes need another confirmation.
- **Episodes:** each row keeps a download icon in the same place. Queued, progress, waiting and failure messages appear beside its date and duration; a thin progress bar runs along the still. The icon cancels an unfinished download, resumes a paused one, retries a failed one, or watches a completed copy offline.

A movie’s button then shows how the download stands: **Queued**, its progress, **Waiting for playback**, **Paused** with **Resume**, or what went wrong with **Retry**. Pressing it while it is queued or downloading cancels it, and while it is paused resumes it. Once it is on this computer it reads **Watch offline**, and on a movie the arrow beside it has **Delete download**.

Supported are movies and episodes of Xtream subscriptions and of playlists whose groups you mapped to movies or series. Live TV can't be recorded.

## The Downloads page

**Downloads**, the last page in the top bar, has the queue at the top and what is on this computer below. The entry appears while any download is kept, including queued, paused, failed, completed or missing copies. In a narrow window it is the download icon beside Search, with the same rule. Removing the last download hides the entry and leaves an already open Downloads page in place.

While a download runs, waits or is queued, the top bar shows it beside Search, on every page but Downloads: the arrow with its progress, **Waiting** or **Queued**, or **Paused** once only paused downloads are left. **Download stopped** shows when one failed and nothing else is left, until you retry or delete it. Pressing it opens Downloads, also from a title that plays, which stops as **Back** would stop it.

- One download runs at a time, in the queue's order: the order you added them, until you change it. The arrows on a waiting download move it one place up or down. The one running stays first.
- **Pause** stops a download and keeps what it has downloaded. It keeps its place and stays paused, also after a restart and while something plays, until you press **Resume**. **Pause all**, at the top of the page, pauses everything that can be; once everything is paused it reads **Resume all**.
- **Waiting while … plays**: something from the same subscription is playing, a channel, Home's preview or a title, here or on a TV. Many subscriptions allow one connection, and playback always gets it. The download stops and goes on by itself once that subscription plays nothing. A download from another subscription goes on meanwhile.
- **Cancel** stops a download and deletes what it had downloaded.
- A failed download says why: the disk is full and how much to free, the downloads folder can't be written, or what the provider answered. **Retry** queues it again; **Delete** removes it.
- **Watch offline** plays a copy. **Delete** removes it from this computer, after you press it a second time.

The page also shows how much space downloads take and how much is free on that disk.

## Episodes of a series

Two or more downloaded episodes of the same series version sit together on the Downloads page, under the series' name. Each season lists its episodes in the series' order. An episode the series has between two of yours that isn't on this computer gets a line of its own, such as "S2 E3 isn't on this computer". The arrow beside the name folds the episodes away. Episodes downloaded with an earlier version of the app keep their own rows.

When an episode ends, the next one plays after the countdown if its complete copy is on this computer. **Play now** starts it at once and **Cancel** stays where you are. **Next episode** and its delay in **Settings > Playback** work here too. The next one is always the episode right after it in the series. When that one isn't on this computer, or is still downloading, the end of the episode says so and nothing plays. No missing episode is skipped or streamed instead. Episodes downloaded with an earlier version of the app have no next episode.

Before continuing, Mr. Streamer saves the current episode's progress and checks the download list again for the next episode's complete, present copy. If saving fails, it stays on the current episode and stops the countdown; **Next episode** tries again. An externally removed current file does not prevent continuation once progress saves and the next copy is available. Deleting the current download through the app removes its record and stops its playback.

## Watching offline

A copy plays in the same player as everything else: the timeline, the 10-second skips, speed, sound tracks, the file's own subtitles and their timing and look all work. The line under the title says **Offline**. Subtitles you downloaded online for that exact version before it finished downloading come with the copy, with your timing; searching for new ones needs the version from your subscription. A copy plays on this computer only, not on a TV.

How far you got is kept with the copy. It is separate from your progress in the same title online.

Playing a copy makes no request to your provider. Its details and pictures were saved when you downloaded it. Statistics and update checks still run as set.

## Without a subscription

Copies don't depend on a subscription. When a subscription expires or you remove it, its copies stay and still play; the page says "Subscription removed, copy kept". Removing a subscription cancels its unfinished downloads.

With no subscription saved, the Connect screen shows **Downloads** at the top when there is something to watch. **Add subscription** goes back to the form.

## When a download is interrupted

Quitting the app, pausing, or playback taking the connection, keeps the downloaded part. The download goes on from there only when your provider confirms it is still the same file. Otherwise it starts again from the beginning, and says so. A file is only offered for watching once all of it has arrived.

## Going back to an earlier version

Mr. Streamer 0.0.19 and earlier ignore pauses and your queue order. Unfinished downloads, including paused ones, can run in the order you added them. The saved pause and order fields survive ordinary use there. Back on 0.0.20 or later, unfinished downloads you paused are paused again, and the queue returns to your order.

## Where they are kept

Downloads are kept in the `downloads` folder inside Mr. Streamer's data folder, listed in the [privacy policy](../privacy.md#on-your-computer). Mr. Streamer manages that folder: use **Delete** rather than removing files by hand. A copy whose file is gone shows as missing and can only be deleted.
