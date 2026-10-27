# Updates and channels

Mr. Streamer looks for updates on its own, a little after it starts and then every four hours, unless you installed it through [the AUR](#installed-through-the-aur) or [the Microsoft Store](#installed-from-the-microsoft-store). It never downloads or restarts without you: you download an update, and then choose when to restart into it. Your login, preferences, favourites and history stay through every update.

## When an update is available

**Update** appears at the top right, with a dot. It stays quiet while you watch: it fades with the other controls, and nothing covers the picture.

1. Click **Update** to see the new version and what changed.
2. Choose **Download**. It downloads while you keep watching; the top bar shows how far it got, and **Cancel** stops it.
3. When it's ready, the top bar says **Restart to update**. Choose **Restart** when it suits you: playback stops for a moment while Mr. Streamer restarts on the new version. **Later** keeps it ready until you restart.

**Not now** hides the notice for that version. A newer version shows it again, and Settings keeps offering the one you skipped.

On Linux, installing the deb package asks for your password, because installing a package needs administrator rights. The AppImage replaces itself without asking.

## A reminder when Stable is behind

Starting with the 0.0.21 client, direct and Homebrew Stable copies show a centered reminder when at least two published Stable releases are newer than yours. It uses the known previous Stable release, including skipped version numbers; an older feed without that history keeps the quiet update notice. Current, ahead and one-release-behind copies get no prominent reminder. This cannot add reminders to older clients.

The reminder appears at most once per app process launch, while you browse. Full Watch and movie or episode playback defer it until you return; the muted Home preview does not. **Not now** or Escape closes it and returns keyboard focus, leaving the quiet **Update** entry available. Rechecking, reopening the window or finding a newer offer during that launch does not repeat a reminder already shown. The next app launch can remind you again. **Download** starts only when you choose it, and restart still needs your confirmation.

Nightly, Microsoft Store and AUR copies keep their existing update behavior.

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

## Installed through the AUR

On Arch Linux, x86_64, [mrstreamer-bin](https://aur.archlinux.org/packages/mrstreamer-bin) packages the stable release with its bundled player and media tools. With yay installed, run `yay -S mrstreamer-bin`; with paru, run `paru -S mrstreamer-bin`.

Without an AUR helper, install the build tools and fetch the recipe:

```sh
sudo pacman -Syu --needed base-devel git
git clone https://aur.archlinux.org/mrstreamer-bin.git
cd mrstreamer-bin
```

Review `PKGBUILD`, then run `makepkg -si` as your regular user. It packages the prebuilt app and asks for your password to install it. Open **Mr. Streamer** from the application menu, or run `mrstreamer`.

Quit Mr. Streamer before an upgrade, reinstall or uninstall. To update, run `yay -Syu` or `paru -Syu`; these update your other packages too. For a manual update, run `sudo pacman -Syu`, then `git pull --ff-only` in the recipe directory, review the changes and run `makepkg -si` again. See Arch's [AUR guide](https://wiki.archlinux.org/title/Arch_User_Repository#Installing_and_upgrading_packages) for the build steps.

The AUR copy leaves updates to your package manager. It never downloads an app update or replaces its own files. Settings > **Updates** points you to an AUR helper or makepkg, with no Stable or Nightly channel to choose. `pacman -Syu` alone does not fetch AUR updates.

Your login, preferences, favourites, watchlist, playback progress, downloaded copies and saved subtitles stay through an upgrade. A direct AppImage and the AUR copy use the same Linux profile and desktop keyring: quit the AppImage before switching, and leave the profile and downloads in place.

To uninstall, run `sudo pacman -R mrstreamer-bin`. This removes the app and keeps your profile, downloaded copies and keyring credentials. Installing it again reuses them.

## Installed from the Microsoft Store

The Microsoft Store updates a copy you installed from it, so Mr. Streamer never looks for updates or downloads them, and shows no update notice. Settings > **Updates** shows your version, updated by the Microsoft Store, and **Open Store** opens Mr. Streamer's page there. The Store only carries stable releases, so there's no channel to choose.

Windows lists the Store copy with 1 added to the first number of the version, such as 1.0.4.0 for Mr. Streamer 0.0.4, because the Store doesn't take a 0 there.

From 0.0.8, the Store and the Start menu call it "Mr. Streamer: IPTV Player". It's the same app.

The Store copy and a copy installed from the setup file are separate. Each keeps its own login, preferences, favourites and history, and neither reads or changes the other's. Moving from the setup file to the Store copy starts fresh: you sign in again, and your favourites, history and progress stay with the other copy. Store updates keep its data. Uninstalling it removes its data, as Windows does for every Store app.

## Stable and Nightly

These channels apply to direct downloads and Homebrew. The AUR and Microsoft Store carry stable releases and manage updates separately.

- **Stable** gets tested releases only.
- **Nightly** gets new builds first, up to four a day when there are changes. It never offers a stable release: each stable release is a tested nightly, so the nightlies carry its changes. Nightly builds can have rough edges.

The version you download sets your channel on first launch. After that, only **Channel** under **Updates** in Settings changes it. Installing a stable release while on Nightly keeps you on Nightly, and Mr. Streamer offers the next nightly once one is out. Nightly never offers a version older than yours. The same goes when you switch a stable release to Nightly.

## Going back to Stable

Choose **Stable** as the **Channel** under **Updates** in Settings. Mr. Streamer offers the newest stable release right away, even when it is older than your nightly, and installs it like any other update: your login, preferences, favourites and history stay.

A stable release older than your nightly may not have everything the nightly has. Stable 0.0.2 has no movies and series; how far you got in them stays saved and is back when you return to Nightly or a stable release that has them.
