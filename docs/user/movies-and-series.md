# Movies and series

**Movies** and **Series** in the top bar list what your providers offer on demand, from [every subscription you added](subscriptions.md) together. Mr. Streamer loads both lists after connecting and keeps them on your computer, refreshing them twice a day; the first load can take a few seconds on a large subscription.

Each film shows once, even when your provider lists it once per language or quality. Mr. Streamer picks the version in your language, then one with several languages, then one without a language mark. The arrow beside **Play** lets you pick another, as below.

## Finding something

Tabs under the top bar:

- **For you** leads with a featured title, then what you're watching, titles like the one you watched last, what's popular, new this week, top rated, and what's on the streaming services with the most of your catalogue.
- **New** has what your provider added this week and this month, and recent releases.
- **Genres** and **Services** show a tile for each genre and streaming service. Open one for its titles.
- **4K** lists titles with a 4K version, when your provider has any, and plays that version.
- **Adults** lists the titles your provider marks for adults, once you turn on **For adults** in Settings > Movies and series.
- **All movies** and **All series** list everything, sorted by date added, popularity, rating or name.

A row's **All**, a genre or a service opens the whole list; **Back**, or Escape, returns to the tab. In a list, the arrow keys move through the posters and Enter opens one. Page Up and Page Down move by a screen; Home and End go to the ends. Tab stops once in the list, on the selected poster, and closing its details returns keyboard focus there while the poster is still listed. The pointer only hovers; clicking a poster selects and opens it.

Every tab but **All movies** and **All series** shows titles in your language, or in several, and titles with their own sound, such as films with Dutch subtitles, unless they were made in another language. **All movies**, **All series** and search show everything else. Titles for adults show only in their own tab, never on Home, in another tab or in search.

The field at the end of the tabs searches movies on Movies and series on Series. It finds a title by the name it shows, by its translations and original name, and by the names your provider gives each version, and shows what it finds as posters in place of the tab. Down or Enter moves to the posters. Escape, or a tab, clears it.

⌘K (Ctrl K on Windows and Linux) searches movies and series along with channels and programmes. Opened from Movies or Series, it starts with what the field searched for; so does **Search everything** under the results.

## Filtering the current list

**Quality** and **Language** filter an open movie or series grid and its search results. They are compact menus on one line with **Verified**, after **Sort** where a list has one. Each menu lists every choice, with the current one checked, and **Any** clears that filter. Long menus scroll, and Escape closes an open menu before it leaves the list.

Quality and Language are hints from the provider's names. **Unknown** means no hint, and **MULTI** means a mark for several languages. The count shows matches out of the current list, beside a collection's name; **Reset** clears every filter. Switching between Movies and Series clears them too. ⌘K's search stays unfiltered.

**Sort** orders **All movies**, **All series** and a collection opened from a row, a genre or a service. A collection's order lasts until you leave it.

**Verified** filters by sound or subtitle languages found in files read on this computer, without opening or probing any files to filter. Its menu says how many current files were read, and offers only **Any** until one is. Its **Unknown** means a track was found but its language is unknown. Unread files and absent tracks do not match. Quality, language and verified choices must match one file together. A series matches when one of its known episodes has such a file; this does not promise the same tracks on every episode. After a restart or a list refresh, reopen a series' details before its saved episode observations count again. Only recently opened details stay available for filtering; reopen older series if their observations no longer count.

Opening a filtered poster picks the matching version. The arrow beside **Play** still lets you choose another.

## Language

Settings separates the three languages for movies and series by task:

- **Movies and series > Titles in**, English unless you change it, decides the names titles show, which version of a film shows and plays, and what the tabs show.
- **Playback > Audio in** is the sound a title starts with: a language, or **Original language**, the one it was made in. Until you set it, it follows Titles in.
- **Subtitles > Subtitles** are **Off**, **Only when forced**, which shows only subtitles a file marks as forced for its sound, such as translations of signs, or a language.

Picking a sound track or subtitles in the player sets Audio in or Subtitles to its language, so the next title starts the same way. Captions have no language, so picking them leaves Subtitles as it was.

**Interface language**, at the top of General, is the language of Mr. Streamer's own words: menus, buttons, messages and dates. It changes none of the three above. **System default** follows your computer's language when it is English, Dutch, French, German or Spanish, and is English otherwise. The change shows at once, with nothing restarted.

## Genres and streaming services

Your provider's lists don't say a film's genre or where else it streams, and name films their own way, so Mr. Streamer asks [TMDB](https://www.themoviedb.org), using the TMDB ids providers list. It asks about each title once, newest first, and fills in names, genres, popularity and services as answers come in: on a large subscription that takes about a quarter of an hour the first time, and again once after you choose another language. Titles take their usual name in your language from Settings, or the English one where TMDB has no translation, and their details show the original name. Search finds a title by any of these names and by your provider's. Meanwhile a ring beside search in the top bar fills up, and goes when the asking stops; hover it for how far it got, or click it for Settings. Which titles each service streams comes from [JustWatch](https://www.justwatch.com), for the country your computer is set to.

Mr. Streamer has its own TMDB key. If TMDB stops accepting it, Settings > Movies and series says so beside TMDB, and **Own key…** takes a key of your own; a free TMDB account gets one.

## Details

A poster opens its details over the list, which stays where it was: the artwork, the original title when it differs, the year, length, genres and rating, the story, the cast with their photos and parts, and who directed or created it. An episode you stopped in shows how much is left. They load when you open the title, never before: TMDB's story, artwork and cast in your language where it has them, your provider's otherwise. A title opened before opens at once. A film's details are those of the version that plays.

- **Resume** plays a movie or episode from where you stopped. **From the beginning** starts it again, without asking.
- **Play** starts something new. For a series it plays the episode you're on: the one you stopped in, the next one you haven't watched after one you finished, or the first. Once every numbered episode is watched it reads **Replay** and starts the first one again.
- The arrow beside **Play** shows when there are several versions, each named for what you hear and read, such as "English sound, Nederlands subtitles" or "Deutsch sound · 4K", from the marks in your provider's list and the language the title was made in; the line under the buttons says which one plays, and **Automatic** shows which it picks. **Automatic** plays the 4K version of a title opened from the 4K tab, carries on in the version you were watching, or else plays the one that suits your language. Pick another and that title plays it from then on, from Home and the lists too, and a series lists its episodes. Opening from the 4K tab or a filtered grid first picks that grid's matching version instead; the menu still lets you change it. How far you got carries over within one subscription. When several subscriptions offer the title, each version also says which subscription it is from, and one from another subscription starts from the beginning: see [picking which subscription plays a title](subscriptions.md#picking-which-subscription-plays-a-title). A pick goes when you remove its subscription.
- A series opens on the season you're watching. Each episode shows its name, air date, length and story, and once TMDB answers for that season, its rating, director and guest stars where TMDB has them. Other seasons ask TMDB nothing until you open their tab. Watched episodes have a check mark, and one you stopped in shows how far you got. Click an episode to play it. The three dots at the end of its row [mark it watched or unwatched](#marking-episodes).
- **Save** puts the movie, or the whole series, on your [watchlist](#watchlist). The button then reads **Saved**, and pressing it again takes the title off.
- **Remove from Continue watching** takes the title off Home's row, every version of it, and the button goes. How far you got stays, so **Resume** carries on. The title comes back to the row when you play it again.

**Also in your subscriptions** lists related titles from your subscriptions' catalogues, excluding adult titles. Its posters open their details in place of these. **Back** in the top bar returns through up to eight previous details, restoring the season and scroll position, with keyboard focus on the related poster when it is still listed. From the first it returns to the page. **Close** or Escape returns to the page at once. Playing a title or opening Settings from the details keeps the way back. Opening a title from a page or search starts a new one. The top bar remains usable in details, including Back, Search and Settings.

**Versions** lists quality first, then language and subscription. These are hints from the provider's name until you open a file. Equal hints within one subscription show a version count: expand it to choose each exact file by its original label, file type and added date where listed. Files in an expanded group get a version number in the provider’s list order. Matching names never make different files interchangeable.

A tick names tracks actually read on this computer. A file with no subtitles says **No subtitles** only after it was read; another file with the same hints makes no such claim. A series observation says how many exact files it has read, including alternate files of one episode, rather than promising the tracks of every episode. Opening the menu reads no files. Changing or replacing a source clears obsolete observations, and series observations require its current episode details to have been opened here.

## Marking episodes

The three dots at the end of an episode's row open **Mark watched** and **Mark unwatched**. They are for an episode you saw somewhere else, or one that played to its end after you fell asleep. Tab reaches the dots after the row, and Enter or Space opens them. Marking plays nothing, and whatever is playing carries on as it was.

- **Mark watched** gives the episode its check mark, also when Mr. Streamer never learned how long it is. It no longer offers **Resume**, and the series moves on to the next episode you haven't watched.
- **Mark unwatched** takes away the check mark and the place you stopped at. The series goes back to that episode, from its beginning. An episode you stopped in offers both, so you can reset it without marking it watched first.

The row changes once the mark is saved; until then it says **Saving…**. A line under the season tabs then names the episode and offers **Undo**, which puts back exactly what was there: the check mark or the place you stopped at, and whether the series was in Continue watching. Undo stays until you mark another episode of the series, start playing one, take the series off Continue watching or close the details. If a mark couldn't be saved, the line says so with **Retry**, and nothing has changed.

A mark is kept with the subscription whose version the details show, like your progress. It holds for every language and quality that subscription lists of the series, and it goes by the episode's season and number, so it stays when your provider replaces the file. Mr. Streamer knows the series by its TMDB id, or by your provider's own number when it has none, never by its name. A series your provider gives a TMDB id later keeps the marks you made before. If your provider takes that id away or changes it, the marks made under it wait, shown for no series, until the id is back: providers reuse their numbers for other series. With [several subscriptions](subscriptions.md), another subscription's episodes keep their own check marks, and the menu and the line under the tabs name the subscription you're marking in.

Playing an episode after you marked it replaces the mark with what you watch. An episode that was already playing when you marked it does not: that play no longer saves how far it gets in the episode, so your mark stays as it is, and **Undo** brings back the place you were at when you marked it. Moving what plays to a TV, to another TV or back to this computer doesn't make it a new play. Starting the episode again does.

If Mr. Streamer can't read what you watched, the details say so with **Try again**. Until it can, they name no episode to go on with, show no check marks and offer no marks, so nothing is guessed. The episodes still play, from their beginning.

Marks are for one episode at a time. There is none for a whole season or series.

## Watchlist

**Save** in a title's details keeps a movie or a whole series for later. It works as soon as the details open, before the story and the cast arrive. Episodes can't be saved on their own.

**Watchlist** in the top navigation bar shows everything you saved, movies and series together, the title saved last first. **A to Z** sorts them by name. Home also has a **Watchlist** row whose **All** opens the page. The navigation entry appears while there is a saved title visible under your adult-content setting, including unavailable titles. It works when Home’s row is hidden. Removing the last visible save hides the entry and leaves an already open Watchlist page in place. A poster opens the title's details, and it plays from there as from anywhere else. On the page the arrow keys move through the posters and Enter opens one; Tab reaches the poster they are on, then its ×.

Only you take a title off: with the × on its poster, or with **Saved** in its details. Starting a title, finishing it or removing it from Continue watching leaves it saved, and saving changes nothing about how far you got. The same title can be in both rows.

A title is saved once, whichever language or quality you opened it in, and it stays the same entry when your provider renames it or lists other versions of it. Mr. Streamer follows it by its TMDB id. A title your provider lists without one is followed by your provider's own number for it, never by its name, so it can't turn into another title that happens to be called the same.

With [several subscriptions](subscriptions.md), a film or series that two of them offer under the same TMDB id is one poster on the watchlist, as it is in Movies and Series. **Save** saves it for every subscription that offers it at that moment and asks nothing. The arrow beside **Play** picks which one plays, and the × takes the title off for all of them. Two titles that only share a name, or a provider's number, stay two entries. A subscription you add later plays a saved title it offers too. The title stays saved for the subscriptions you saved it from, and for no other.

When no provider lists a saved title any more, it stays on the watchlist, dimmed and marked **Unavailable**. Open it to remove it, or leave it: it plays again once a provider lists it again. With several subscriptions, it says which ones it was saved from. If a subscription's movie and series lists couldn't be refreshed, the page says so and shows what you saved from the lists it has.

Saved titles for adults show, and count, only while **For adults** is on in Settings > Movies and series. They stay saved while it is off.

The watchlist is kept on your computer, with the subscription each title was saved from, like favourites. **Remove**, on a subscription in Settings > Subscriptions, keeps what it saved for when you add the same account again, unless you tick the box that deletes it. A title you saved from another subscription as well stays on the list.

## Watching

The picture fills the window below the top bar, with the title, a timeline and the controls along the bottom; they fade while you watch and come back when you move the pointer.

- Drag the timeline, or skip back and forward 10 seconds. A skip into what's already loaded is instant; further away, the picture takes a second to catch up.
- **Sound** lists the sound tracks the file carries, and **CC** its subtitles. CC opens a panel with everything about subtitles: the tracks, their timing and look, and [online search](playback.md#online-subtitles). C turns the last ones you picked on and off, and a paused title stays paused while it changes. Your choice of language is remembered, and the next title or channel that has it starts with it, as **Audio in** and **Subtitles** under Settings > Playback and Settings > Subtitles describe. When the file has no sound in that language, its own default plays.
- **Speed**, beside them, plays from 0.5× to 2×. Voices keep their pitch. The speed lasts for the title, and carries on when **Next episode** plays the one after.
- **Timing**, in CC, moves subtitles earlier or later in tenths of a second, for this title only. **Look** sets their size, a box or a shadow behind the text, low or higher up, and stays for every title and channel. Subtitles drawn as pictures, as on Blu-rays and DVDs, take only size and position.
- Menus follow the arrow keys. Escape or a click outside closes them without pausing or skipping.
- **Mini player**, beside full screen, or P, shrinks the window into a small picture in a corner of the screen, on top of other windows. The title plays on where it was, with its subtitles, and the keys work as before. Drag the top of the picture to move it, and its corner to resize it. Escape, a double click or the arrows button puts the window back where it was, full screen included; the cross leaves the title. The countdown to the next episode carries on in it, and the next episode plays there. On a Mac the window and its Dock icon disappear for a moment each time it shrinks or grows back. Linux under Wayland can't keep a window on top, so there the mini player isn't offered.
- **Next episode**, or N, plays the next one at once.
- The keyboard's media keys and the system's own controls, Now Playing on a Mac and the media overlay on Windows, show the episode's name, its series and "S1 E3", or the film's name, with TMDB's picture. They play, pause, skip 10 seconds, move along the timeline, and play the next episode when there is one.
- **Back**, or Escape, returns to the details or the page you came from.

How far you got is saved as you go: every minute, and whenever you pause, skip, change tracks, finish or leave. It's kept with the subscription you watched in, like favourites.

## The next episode

When an episode ends, the next one plays after the delay in **Settings > Playback > Next episode delay**. Choose any whole number from 0 to 60 seconds. The default is ten seconds; 0 is **Instant**. Autoplay stays a separate **Next episode** switch.

The end screen names the next episode, and says when a new season starts, as in "Finished S1 E3 · Season 2 is next". **Play now**, or N, starts it straight away. **Cancel** keeps the end on screen, with **Next episode** and **Episodes**, which opens the series. Leaving, starting something else or removing its subscription stops the countdown too. Settings holds the remaining seconds, even Instant. Closing Settings resumes that remainder if autoplay is on, including after an off/on edit while Settings was open. Final Off cancels it. Enabling autoplay later does not restart a cancelled countdown, and changing the delay applies to the next countdown. A failed settings read leaves manual **Next episode** available.

The next episode is the next one you haven't watched, in your provider's order and across seasons, in the version of the series you're watching and with your sound and subtitle languages. Episodes you watched or [marked watched](#marking-episodes) are passed over, also when you marked them while this one played. It never goes back to an earlier episode, and specials only lead to other specials. Mr. Streamer checks what you watched once more before the next episode opens. If it can't, nothing starts on its own: **Next episode** checks again. If the episode doesn't start, the screen says why: **Try again** asks your provider once more, and **Episodes** opens the series.

With none left to watch after it, the screen says that this was the last episode, or that the rest is watched. Watching such an episode into the credits takes the series off Continue watching, every version of it, once you've watched every numbered episode, until you play or mark one of its episodes again. If you skipped an earlier episode, the series stays on the row and offers that one.

## Continue watching

Home's **Continue watching** row shows what you were watching: movies you started, and for each series the episode you're on. A title counts as started after two minutes, and as finished in its last few minutes, where the credits run. A finished movie leaves the row, and so does a series once you watched every numbered episode of it. A finished episode stays as **Next episode**, which plays the next episode you haven't watched, the first earlier one you skipped when none is left after it, or opens the series' details once you watched them all. A series you [marked an episode of](#marking-episodes) shows the episode it goes on with: the one you marked unwatched, or the next one you haven't watched after the one you marked watched. When none is left after that one, it is the first earlier episode you haven't watched, and once every numbered episode is watched the series leaves the row. Specials don't count towards that. The tile follows what you watch: when an episode that was playing as you marked another reaches its end, the series moves on past it. It goes by the episodes the series listed when you last marked one or opened it, so episodes your provider added or took away since show once you open the series. The row shows what you saved, so it asks your provider nothing until you press play. The × on a tile takes it off the row, as **Remove from Continue watching** does.

## Keys

| Key         | While watching                        |
| ----------- | ------------------------------------- |
| Space, K    | Pause and play                        |
| Left, Right | Back or forward 10 seconds            |
| Up, Down    | Volume                                |
| N           | Next episode, also during a countdown |
| C           | Subtitles on and off                  |
| G, H        | Subtitles 0.1 s earlier or later      |
| <, >        | Slower or faster                      |
| F, M        | Full screen, mute                     |
| P           | Mini player, and back                 |
| Escape      | Close a menu, leave full screen, back |

## One connection

Many subscriptions allow one connection at a time, and Mr. Streamer plays one thing at a time across all of them. Opening a movie or episode stops the live channel first, whichever subscription each is from, and Movies and Series don't play the muted live preview Home shows; it starts again when you go back to Home. A pause of more than five minutes lets go of the connection, and playing again picks up where you were. A [download](downloads.md) from the same subscription waits while anything of it plays.

[What plays](playback.md) lists the formats and what gets converted.
