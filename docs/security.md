# Security

## Your login

Your subscriptions are stored on your computer. Passwords, playlist links and guide addresses you provide are encrypted with a key held by macOS Keychain, your Windows account, or GNOME Keyring or KWallet on Linux. On Linux without a keyring, Chromium uses a fixed key, so other programs running under your account can read them. Server addresses and usernames are not encrypted. Your own TMDB key is not encrypted either.

Your provider receives its login in every request the app makes to it. Mr. Streamer never falls back from HTTPS to unencrypted HTTP. An address entered with `http://` sends the login unencrypted; an address without a scheme asks before using HTTP when HTTPS fails. The [privacy policy](privacy.md) lists what is stored and every connection the app makes.

## Basic app-use statistics

From 0.0.11, the app keeps a random per-profile analytics installation identifier and a durable collection preference. From 0.0.12 it also keeps fixed counts for the current day and at most one earlier day. **Settings > Privacy** turns collection off and clears pending observations and unsent counts. The identifier is not a provider login and is excluded from diagnostics exports. Configured production capture uses HTTPS and contains only the coarse fields in the [privacy policy](privacy.md#usage-statistics), which also records the collection destination and retention policy. PostHog still sees the connection’s source IP address even with GeoIP enrichment disabled.

## Reporting a problem

Report a security problem privately to [security@mrstreamer.app](mailto:security@mrstreamer.app), rather than in a public issue. Include what you found, how to reproduce it and the Mr. Streamer version from Settings > About. Leave out your provider's server address, username, password, playlist link and guide address.

## Signed installers

| Download                | Signing                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| Mac DMG                 | Signed with an Apple Developer ID, hardened, notarized and stapled.          |
| Microsoft Store         | Signed by Microsoft when the Store delivers it.                              |
| Windows setup .exe      | Not code-signed yet. SmartScreen may warn. Check the hash before running it. |
| Linux AppImage and .deb | Not signed. Check the hash before running them.                              |

The Microsoft Store and setup-file copies keep separate data. See [Updates and channels](user/updates.md#installed-from-the-microsoft-store).

## Checking a download

Download the installer and `SHA256SUMS.txt` from the **same release** on [GitHub Releases](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/latest). The [download page](https://mrstreamer.app/download) links that release and its sources.

On macOS, check the files you downloaded, ignoring the release's other files:

```sh
shasum -a 256 --ignore-missing -c SHA256SUMS.txt
```

On Linux, check the files you downloaded, ignoring the release's other files:

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
```

On Windows, replace the filename and compare the result with its line in `SHA256SUMS.txt`:

```powershell
Get-FileHash ".\Mr-Streamer-VERSION-win-x64-setup.exe" -Algorithm SHA256
```

A matching checksum confirms that the file matches the release's copy. It is not a signature or proof that software is safe. If it differs, do not run the installer. Download it again from the release and check again.
