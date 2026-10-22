# Updates and channels

Mr. Streamer looks for updates on its own, a little after it starts and then every four hours, unless [the Microsoft Store installed it](#installed-from-the-microsoft-store). It never downloads or restarts without you: you download an update, and then choose when to restart into it. Your login, preferences, favourites and history stay through every update.

## When an update is available

**Update** appears at the top right, with a dot. It stays quiet while you watch: it fades with the other controls, and nothing covers the picture.

1. Click **Update** to see the new version and what changed.
2. Choose **Download**. It downloads while you keep watching; the top bar shows how far it got, and **Cancel** stops it.
3. When it's ready, the top bar says **Restart to update**. Choose **Restart** when it suits you: playback stops for a moment while Mr. Streamer restarts on the new version. **Later** keeps it ready until you restart.

**Not now** hides the notice for that version. A newer version shows it again, and Settings keeps offering the one you skipped.

On Linux, installing the deb package asks for your password, because installing a package needs administrator rights. The AppImage replaces itself without asking.

## Updates in Settings

Settings (⌘, on macOS, Ctrl , on Windows and Linux) > **Updates** shows your version, where the update stands: when Mr. Streamer checks next, that it's up to date, or the step the update is at, with the same actions as the top bar, and your channel. **Check now** looks straight away. **What's new** lists the changes in the offered version, each linked to its details.

When a check doesn't work, Settings says why in a few words: you're offline, the update server answered with an error, or GitHub is limiting requests from your network and until when. A check Mr. Streamer made on its own fails quietly and tries again later, sooner at first. Either way, an update found earlier stays available to download.

## Install a newer version by hand

**GitHub ›** beside an offered update in Settings opens its release. You can also take an installer from the [download page](https://mrstreamer.app/download) and install it over the old one. Mr. Streamer keeps its data in a folder of its own (see [Troubleshooting](troubleshooting.md#where-your-data-is)), so everything carries over.

## Installed through Homebrew

The maintained Homebrew tap uses the same signed stable DMG for macOS 13 or later on Apple silicon. The [download page](https://mrstreamer.app/download) has the current install command.

You can keep updating in the app. For a Homebrew update, quit Mr. Streamer first, then run `brew upgrade`. This can update other Homebrew packages too. Quit before a reinstall or uninstall as well.

With Homebrew's default upgrade settings, plain `brew upgrade` compares the installed app with the tap and can skip an app that updated itself to a newer version. Stable and Nightly use different version formats, which Homebrew cannot reliably compare, so it normally skips that comparison. Use the app's updater to switch channels.

An explicitly named upgrade, `--greedy` or `brew reinstall` can replace a newer app with the tap's version. Before an intentional replacement, compare Settings > **About** with `brew info --cask mr-streamer-oss/tap/mr-streamer`.

Homebrew replaces the app bundle. Your profile and downloaded copies live outside it, and Homebrew uninstall leaves them in place. If a direct install already occupies the destination, quit it and move only its app bundle aside before installing through Homebrew. Leave the profile and downloads alone.

## Installed from the Microsoft Store

The Microsoft Store updates a copy you installed from it, so Mr. Streamer never looks for updates or downloads them, and shows no update notice. Settings > **Updates** shows your version, updated by the Microsoft Store, and **Open Store** opens Mr. Streamer's page there. The Store only carries stable releases, so there's no channel to choose.

Windows lists the Store copy with 1 added to the first number of the version, such as 1.0.4.0 for Mr. Streamer 0.0.4, because the Store doesn't take a 0 there.

From 0.0.8, the Store and the Start menu call it "Mr. Streamer: IPTV Player". It's the same app.

The Store copy and a copy installed from the setup file are separate. Each keeps its own login, preferences, favourites and history, and neither reads or changes the other's. Moving from the setup file to the Store copy starts fresh: you sign in again, and your favourites, history and progress stay with the other copy. Store updates keep its data. Uninstalling it removes its data, as Windows does for every Store app.

## Stable and Nightly

- **Stable** gets tested releases only.
- **Nightly** gets new builds first, up to four a day when there are changes. It never offers a stable release: each stable release is a tested nightly, so the nightlies carry its changes. Nightly builds can have rough edges.

The version you download sets your channel on first launch. After that, only **Channel** under **Updates** in Settings changes it. Installing a stable release while on Nightly keeps you on Nightly, and Mr. Streamer offers the next nightly once one is out. Nightly never offers a version older than yours. The same goes when you switch a stable release to Nightly.

## Going back to Stable

Choose **Stable** as the **Channel** under **Updates** in Settings. Mr. Streamer offers the newest stable release right away, even when it is older than your nightly, and installs it like any other update: your login, preferences, favourites and history stay.

A stable release older than your nightly may not have everything the nightly has. Stable 0.0.2 has no movies and series; how far you got in them stays saved and is back when you return to Nightly or a stable release that has them.
