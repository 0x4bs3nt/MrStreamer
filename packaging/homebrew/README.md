# Homebrew cask preparation

Maintainer-only preparation for desktop 0.0.18. Wout Stiens owns the first
release and tap maintenance. The proposed repository is
`Mr-Streamer-OSS/homebrew-tap`, token `mr-streamer`. Neither the tap nor a public
install route is activated by these files. Confirm repository/token availability
and obtain publication authorization before creating or publishing the tap.
In a published tap, the rendered file belongs at `Casks/mr-streamer.rb` and the
fully qualified name is `Mr-Streamer-OSS/tap/mr-streamer`.

## Template contract

`mr-streamer.rb.in` has exactly two scalar substitutions:

| Marker        | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `{{VERSION}}` | Verified stable desktop version, three numeric parts, at least 0.0.18 |
| `{{SHA256}}`  | Lowercase 64-character SHA-256 of the exact released arm64 DMG        |

The download origin, tag and filename are fixed by the template. Keep the
signed/notarized DMG and app bundle unchanged. The planned shared package-update
preparation tool must render production metadata and check successful verified
release provenance, stable channel, exact assets and downloaded bytes against
`SHA256SUMS.txt`, and fail on any mismatch or unresolved marker. It must not push,
publish or activate automation. A livecheck result is update discovery, not that
verification or permission to publish.

Livecheck uses GitHub's latest release and an anchored stable-only version regex.
The cask supports Apple silicon and macOS 13 or newer, installs only
`Mr. Streamer.app`, and declares `auto_updates true`. The app's existing
user-confirmed updater stays available. There are no install scripts, signed
resource changes, package-manager detection, credential changes or zap stanza.
Normal uninstall keeps the profile, Keychain credentials and downloaded copies.

Historical 0.0.16/0.0.17 and non-candidate nightly reconciliation casks are
hand-pinned local fixtures outside production output, using the canonical versioned
asset URL. The planned shared renderer must refuse those historical stable versions.
Candidate-test rendering belongs to that same tool and accepts only a pinned,
tested 0.0.18 nightly manifest with source/origin/digests verified. Mark its output
non-publishable and keep it separate from stable metadata. Never copy a fixture
or candidate cask into the public tap.

## Isolated local validation

Use an Apple silicon Mac and the repository's mac-mini workflow. Keep the
Homebrew repository/prefix, Caskroom, cache, logs, temporary files, app directory
and disposable app profile inside this checkout's ignored `.local/` tree.
`--appdir` alone does not isolate Caskroom. Do not use the shared `/opt/homebrew`
installation for lifecycle checks or change an existing daily-driver app.
A nonstandard prefix is suitable for this local cask check, not a claim that
Homebrew supports every formula in it. Never run `brew shellenv` into a user's
shell configuration.

1. Clone a released Homebrew revision into the disposable prefix. Disable
   automatic brew updates, analytics and cleanup for the session. Set
   `HOMEBREW_CACHE`, `HOMEBREW_LOGS`, `HOMEBREW_TEMP`, `BUNDLE_USER_HOME`,
   `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` to task-local paths. Set
   `HOMEBREW_CASK_OPTS="--appdir=<task-local Applications directory>"`.
   The local test tap is read from disk. Allow Homebrew's normal API
   reads into the task-local cache for catalogue checks; setting
   `HOMEBREW_NO_INSTALL_FROM_API=1` can make audit clone all of `homebrew/core`.
2. Record `brew --version`, `brew config`, the Homebrew source SHA and the actual
   prefix, Caskroom and app paths. Unset and record
   `HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS`, `HOMEBREW_UPGRADE_GREEDY` and
   `HOMEBREW_UPGRADE_GREEDY_CASKS`. Keep these unset for plain-upgrade proof.
3. Hand-pin a baseline render in an ignored local test tap, for example
   `mrstreamer-validation/local`. Mark it `LOCAL VALIDATION ONLY`, preserving the
   template's token and canonical versioned DMG URL. Download the DMG and published
   checksum list. Compare the checksum list, release asset digest and local hash.
4. Run the following with the isolated brew executable. These are local
   maintainer commands; they do not establish a public install route.

   ```sh
   brew style <local-tap>/Casks/mr-streamer.rb
   brew audit --cask --online mrstreamer-validation/local/mr-streamer
   brew livecheck --cask mrstreamer-validation/local/mr-streamer
   brew install --cask mrstreamer-validation/local/mr-streamer
   brew info --json=v2 --cask mrstreamer-validation/local/mr-streamer
   ```

5. Retain original failures. Record every audit exception with its exact message
   and reviewed reason. Check both DMG and installed app signatures and Gatekeeper
   acceptance, and validate the DMG's stapled ticket:

   ```sh
   shasum -a 256 <dmg>
   codesign --verify --strict --verbose=2 <dmg>
   spctl --assess --type open --context context:primary-signature -vv <dmg>
   xcrun stapler validate <dmg>
   codesign --verify --deep --strict --verbose=2 '<app>'
   spctl --assess --type execute -vv '<app>'
   /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' '<app>/Contents/Info.plist'
   /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' '<app>/Contents/Info.plist'
   ```

6. Run `apps/desktop/test/e2e/packaged-app.ts` against the installed executable
   with `--use-mock-keychain`, never the development Electron executable. Use only
   fixture provider/TMDB data and an explicit disposable profile. Record executable
   and resource hashes. Verify Live TV, VOD, subtitles and bundled ffmpeg/ffprobe
   and AirPlay helper lookup. Physical AirPlay, audible output and real-provider
   acceptance need their own evidence. Complete the offline/restart and retained
   state gates below; the packaged smoke alone does not cover them.
7. With the app quit, test explicit reinstall and normal uninstall. Keep the
   profile and copies outside Caskroom and the app bundle. Compare retained data
   before/after; check that normal uninstall removes the app and Caskroom metadata.
   Test a direct existing-install conflict in the disposable app directory and
   retain the refusal. Never use `--force` or `--adopt` to bypass that conflict.

## Safe update and recovery policy

Quit Mr. Streamer before a brew upgrade, reinstall or uninstall. The recipe does
not kill processes or promise an automatic running-app refusal. For local
validation, refuse a replacement while any app process remains:

```sh
if pgrep -x 'Mr. Streamer' >/dev/null; then
  echo 'Quit Mr. Streamer before replacing the app.' >&2
  exit 1
fi
```

Run that guard in a validation script or subshell, then invoke the intended
isolated brew command only after it succeeds. Recheck immediately before replacing
the app. Do not force-quit another session. For an existing direct install, quit it
and move its app bundle aside deliberately before installing into the same
location. Leave its profile, Keychain entries and downloads alone.

With current Homebrew and the recorded environment toggles unset, plain
`brew upgrade` compares installed bundle versions for self-updating casks. It can
upgrade an older app or skip a newer app when version shapes match. Stable bundle
versions have three dotted parts and nightlies five. Mixed shapes normally skip
because Homebrew cannot compare them reliably; the app updater remains available.
Do not use a mixed-shape skip as proof of reconciliation.

An explicitly named upgrade, `--greedy` or `brew reinstall` can replace an app
newer than the tap with the tap version. To preserve an app that updated itself,
inspect both installed plist fields and tap version first, and use the app updater
or plain `brew upgrade` with the default toggles. In an isolated validation prefix,
`brew upgrade` affects only the test cask. On a user's normal prefix it can update
other installed packages too. There is no universal downgrade-prevention promise.

For an intentional repair, quit the app, inspect the exact tap version and run
`brew reinstall --cask mrstreamer-validation/local/mr-streamer` only in the local
test environment. A maintainer rollback restores the previously reviewed cask
version/checksum in a new tap commit. It never overwrites a published DMG or assumes
that restoring the tap downgrades an already newer app. An intentional app rollback
needs a separate decision about profile compatibility and a retained data backup.
Retry failed preparation from the same verified inputs; leave successful direct
release downloads available. Keep automation disabled until separately authorized.

## Release validation

Track completion on the [Homebrew project card](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=276992982).
The list below is the validation recipe, not a second progress checklist. The
initial signed 0.0.17 baseline is recorded there; candidate-specific checks still
need their own receipts.

Record raw commands, explicit exit statuses beside each log, local artifact hash
output, screenshots and exact app/tap versions before/after each transition.
Record both plist fields, Caskroom INSTALL_RECEIPT source.version, the metadata
version directory and brew info --json=v2 installed/outdated fields. A local cask's
saved JSON definition can be empty and cannot establish version identity.

- Existing signed stable baseline: checksum, signature, Gatekeeper, native
  style/audit, isolated install and fixture smoke.
- Exact tested 0.0.18 nightly candidate: repeat full native validation with a
  non-publishable cask, source and artifact identity pinned to that candidate.
- Same-shape nightly A < B < C behind case: Caskroom/app at B, local tap at C,
  app quit, plain `brew upgrade` actually installs C.
- Same-shape nightly ahead case: Caskroom at A, app updated through its updater
  to C, local tap at B, app quit, plain `brew upgrade` skips. Tap B must differ
  from Caskroom A so the skip exercises bundle comparison.
- App-led and brew-led upgrade plus explicit reinstall retain settings,
  favourites, watchlist, progress, credentials, completed copies, details and
  subtitles. Offline playback works after restart and subscription removal.
  A mock-keychain run does not establish native Keychain retention.
- Running-app guard and deliberate quit path, existing direct-install refusal,
  normal uninstall keeping user data. No force overwrite or zap.
- After stable publication, regenerate from exact verified 0.0.18 stable
  assets and repeat checksum/signature/style/audit plus installed
  launch/version/resources/retained-state checks on those bytes.
- Stable-only behind case with real DMGs: Caskroom/app 0.0.17, local tap 0.0.18,
  app quit, plain `brew upgrade` installs 0.0.18.
- Stable-only ahead case with real DMGs: Caskroom 0.0.16, app updated through
  its stable updater to 0.0.18, local tap advanced only to 0.0.17, app quit,
  plain `brew upgrade` skips. No plist edits or manually copied bundle can
  substitute for the app-led update.
- Confirm proposed tap repository/token availability, authorized publication,
  and the exact fully qualified public command/artifact before enabling the
  website route. Keep the route inactive on failure and release acceptance
  pending. Main-catalogue acceptance is separate optional work.

## Official references

Checked during preparation on 20 October 2026. Review current docs and the
installed Homebrew revision again when executing final candidate checks.

- [Cask cookbook](https://docs.brew.sh/Cask-Cookbook)
- [Third-party taps](https://docs.brew.sh/Taps)
- [Acceptable casks](https://docs.brew.sh/Acceptable-Casks) and its linked shared
  package acceptance policy. A graphical upstream binary fits a cask, but
  supported-platform, Gatekeeper, distribution and notability requirements still
  need review before a main-catalogue submission. No inclusion is promised.
- [Homebrew FAQ](https://docs.brew.sh/FAQ)
- [Homebrew 7.0.10 bundle comparison](https://github.com/Homebrew/brew/blob/7.0.10/Library/Homebrew/cask/cask.rb)
