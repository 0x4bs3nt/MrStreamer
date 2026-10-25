# Security

## Your login

Your subscriptions are stored on your computer. Passwords, playlist links, guide addresses and subtitle-service logins use Electron's system storage encryption: macOS Keychain, your Windows account, or GNOME Keyring or KWallet when selected on Linux. Linux can instead use `basic_text`, a fixed-key fallback that does not protect secrets from other programs running as you. Server addresses, subscription usernames and your own TMDB key are not encrypted.

The app refuses HTTP redirects that it recognizes as carrying the known login of an HTTPS source. In 0.0.20, including its Nightly previews, it also checks playlist addresses and removes recognized login-bearing headers when requests leave that source's origin. HTTP addresses without a recognized login can still be used. Unknown tokens and encodings are not all recognizable, so use subscriptions and playlists you trust.

An address entered with `http://` sends its login unencrypted. An address without a scheme asks before using HTTP when HTTPS fails. The [privacy policy](privacy.md) lists what is stored and the connections the app makes.

## Basic app-use statistics

**Share basic usage statistics** in Settings > Privacy is on by default without a prompt. The app uses a random installation identifier to link coarse usage and reliability events. That makes them pseudonymous. Turning statistics off stops collection and sending, clears pending work and keeps the choice after restart. It retains an identifier already stored, as does removing a subscription. Turning statistics on again uses that identifier without reporting activity while they were off. A new profile gets its identifier at its first foreground observation.

Configured production capture uses HTTPS. The [privacy policy](privacy.md#usage-statistics) describes the fixed event fields, destination and retention. Statistics exclude provider logins, viewing titles, searches, file paths and raw errors. PostHog receives the connection's source IP address even with location lookup disabled.

## Diagnostics

**Diagnostics…** in Settings > About reconstructs text from fixed fields for you to inspect and save. It uploads nothing and excludes the analytics identifier. Ordinary local console output is separate and can include file paths or invalid values from damaged local files. Review it before sharing.

## Playing on a TV

Casting relies on a trusted local network. The TV receives an HTTP stream address on your computer with a random token for the active playback session. Anyone on that network with the address can use it while it is active. The address lasts for its active session or title load, with no separate expiry timer. Pausing alone does not expire it.

Google Cast discovery and the receiver's identity are not cryptographically verified by Mr. Streamer. Choose a device you recognize on a network you trust. See [Playing on a TV](user/playback.md#playing-on-a-tv).

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
