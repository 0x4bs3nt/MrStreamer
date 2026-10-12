# Downloads

From 0.0.10 you can download a movie or a single episode, and from 0.0.12 a whole series, and watch it later on this computer, without a network connection and without a subscription.

## Downloading

- **Movies:** open the movie and press **Download**, beside **Play** and **Save**. It downloads the version **Play** would play, so pick another with the arrow beside **Play** first if you want that one.
- **Series**, from 0.0.12: open **Download**, beside **Play** and **Save**. Its menu names every available season, including Specials, and the selected provider version. Pick another version with Play’s arrow first. Confirm **Download … episodes** to add the remaining episodes to the end of the queue. Each episode uses the file its row would play, including its resumed file when still listed. Already downloaded or queued files are skipped; failed files are retried. A partial result names files that could not be added and offers **Retry**, while successful additions stay in the queue. The menu also offers **Retry failed**, **Cancel the rest** and **Open Downloads**. New episodes need another confirmation.
- **Episodes:** each row keeps a download icon in the same place. Queued, progress, waiting and failure messages appear beside its date and duration; a thin progress bar runs along the still. The icon cancels an unfinished download, retries a failed one, or watches a completed copy offline.

A movie’s button then shows how the download stands: **Queued**, its progress, **Waiting for playback**, or what went wrong with **Retry**. Pressing it while it is queued or downloading cancels it. Once it is on this computer it reads **Watch offline**, and on a movie the arrow beside it has **Delete download**.

Supported are movies and episodes of Xtream subscriptions and of playlists whose groups you mapped to movies or series. Live TV can't be recorded.

## The Downloads page

**Downloads**, the last page in the top bar, has the queue at the top and what is on this computer below. In a narrow window it is the download icon beside Search.

While a download runs, waits or is queued, the top bar shows it beside Search, on every page but Downloads: the arrow with its progress, **Waiting** or **Queued**. **Download stopped** shows when one failed and nothing else is left, until you retry or delete it. Pressing it opens Downloads, also from a title that plays, which stops as **Back** would stop it.

- One download runs at a time, in the order you added them.
- **Waiting while … plays**: something from the same subscription is playing, a channel, Home's preview or a title, here or on a TV. Many subscriptions allow one connection, and playback always gets it. The download stops and goes on by itself once that subscription plays nothing. A download from another subscription goes on meanwhile.
- **Cancel** stops a download and deletes what it had downloaded.
- A failed download says why: the disk is full and how much to free, the downloads folder can't be written, or what the provider answered. **Retry** queues it again; **Delete** removes it.
- **Watch offline** plays a copy. **Delete** removes it from this computer, after you press it a second time.

The page also shows how much space downloads take and how much is free on that disk.

## Watching offline

A copy plays in the same player as everything else: the timeline, the 10-second skips, speed, sound tracks, the file's own subtitles and their timing and look all work. The line under the title says **Offline**. Subtitles you downloaded online for that exact version before it finished downloading come with the copy, with your timing; searching for new ones needs the version from your subscription. A copy plays on this computer only, not on a TV, and has no next-episode countdown.

How far you got is kept with the copy. It is separate from your progress in the same title online.

Playing a copy makes no network request. Its details and pictures were saved when you downloaded it.

## Without a subscription

Copies don't depend on a subscription. When a subscription expires or you remove it, its copies stay and still play; the page says "Subscription removed, copy kept". Removing a subscription cancels its unfinished downloads.

With no subscription saved, the Connect screen shows **Downloads** at the top when there is something to watch. **Add subscription** goes back to the form.

## When a download is interrupted

Quitting the app, or playback taking the connection, keeps the downloaded part. The download goes on from there only when your provider confirms it is still the same file. Otherwise it starts again from the beginning, and says so. A file is only offered for watching once all of it has arrived.

## Where they are kept

Downloads are kept in the `downloads` folder inside Mr. Streamer's data folder, listed in the [privacy policy](../privacy.md#data-stored-on-your-computer). Mr. Streamer manages that folder: use **Delete** rather than removing files by hand. A copy whose file is gone shows as missing and can only be deleted.
