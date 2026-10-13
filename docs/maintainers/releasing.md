# Releasing

> For maintainers. Using Mr. Streamer? See [docs/user](../user).

Releases come from `.github/workflows/release.yml`, which plans them and runs `.github/workflows/build-release.yml` for each, and live on GitHub Releases. The app finds them through the [update feed](#update-feed), a small file the workflow publishes to GitHub Pages after each release; see [architecture](../contributing/architecture.md#updates).

## What the workflow does

- Triggers:
  - a nightly check on every push to `main`, and every 30 minutes on a schedule. GitHub starts scheduled runs far less often than asked, often hours apart, so the push is what usually finds a nightly due. The version commit a stable release pushes doesn't start one: GitHub starts no runs for pushes made with the workflow's own token.
  - manual `workflow_dispatch` with `channel=nightly`, which builds `main` right away
  - manual `workflow_dispatch` with `channel=stable`, the only way to ship stable
  - the **release dry run** label on a pull request
- Manual runs must select `main`; the plan refuses any other branch.
- The plan job (`scripts/release-plan.ts`) resolves the commit, version and tag before anything builds. For a stable release it also decides whether a [nightly goes first](#stable-releases). Every later job checks out the planned commit, so merges that land during a run never reach its build.
- `build-release.yml` builds, checks and publishes each release the plan names. On its commit, in parallel:
  - the [CI](../contributing/testing.md#ci) Check and Test jobs. Test keeps its report as the `test-results-<version>-<attempt>` artifact; see [the test report](../contributing/testing.md#the-test-report)
  - `bundle` builds the JavaScript once, with the release version, and hands it to every platform as the `js-bundle-<version>` artifact. It is the release's `pnpm build`: CI's Check job leaves building to it
  - `package` (macOS and Linux) and `package-windows` build each platform on its own runner, from the bundle:
    - the bundled ffmpeg, cached until `apps/desktop/scripts/build-ffmpeg.sh` changes, and checked for the `segment` muxer that playing on a TV needs. Windows uses MSYS2 UCRT64. Its cache hashes the setup action in `apps/desktop/scripts/windows-ffmpeg-toolchain/action.yml` alongside the release source's build script, so unrelated workflow edits reuse it and setup or build-input edits rebuild it. The setup action comes from the workflow commit, the build script from the release's. Windows and MSIX use the same exact key, without fallback restore keys. Both cold and warm Windows runs check and print the cached README's compiler, runtime and package provenance
    - macOS only: the AirPlay helper (`apps/desktop/scripts/build-airplay-helper.sh`), which goes into the app's resources, is signed with it, and must say hello when run from the signed app. The compiler's output is cached under the key `build-airplay-helper.sh --key` prints, a hash of the Swift sources, the Info.plist, the script, the target and the compiler and SDK of the runner image, so any change to them compiles again. The cache never holds a release signature, only the compiler's own ad hoc one: packaging signs the copy inside the app for each release
    - macOS arm64: the DMG, and the ZIP that in-app updates install. Signed with the Developer ID, notarized and stapled (`apps/desktop/scripts/notarize-dmg.ts`), then checked for signature, team, hardened runtime, Gatekeeper and both tickets. Missing secrets or a failed notarization fail the run. After acceptance, a lost CloudKit ticket connection permits at most four attempts within five minutes for each staple or validation command. The job summary times the step's phases (`apps/desktop/scripts/mac-release-phases.ts`): packaging, signing, the app's and the DMG's notary round trips and stapling, and creating the DMG and ZIP, with the waits on Apple apart from the runner's own work. A notary round trip includes uploading the archive. A phase whose marker line is missing is listed as not observed, and the phase before it shows its elapsed time as unknown, counted in the unattributed total and in neither of the others
    - Windows x64: the NSIS installer, unsigned; see [Windows signing](#windows-signing). Its plug-ins must be the ones the notices describe; see [licences](licences.md#windows-setup-program)
    - Linux x64: the AppImage and deb
    - every `latest*.yml` must name the release version
    - the [packaged-app test](../contributing/testing.md#packaged-app) runs on the installed DMG, setup, deb and AppImage
  - `sources` prepares the [source archives](licences.md#sources-on-every-release) a release attaches, each checked against its pinned SHA-256 or commit, and fails unless the bundle's notices link exactly those files
- Publishes only when every check and platform succeeded and the sources are prepared:
  - checks that each platform's installers, blockmaps and update metadata (`packages/contracts/src/release-files.ts`), and every source archive, are present
  - attaches them with `SHA256SUMS.txt` and the [notes](#release-notes)
  - checks again that the tag is unused and the version sorts after every release it competes with
  - uploads into a draft, which the app can't see, then publishes it; publishing creates the tag on the planned commit
- Then points the [update feed](#update-feed) at the release. Until then the app doesn't offer it.
- Release dry runs also run [bounded real-app UI proof](../contributing/testing.md#bounded-release-ui-proof) on the exact shared JS bundle/version, with retained CLI exits, screenshots, side effects and cleanup. Missing or failed required proof fails the dry run. This Linux source-build proof leaves installed native acceptance separate.
- Dry runs and stable releases also build the [Microsoft Store package](#microsoft-store-package) and test it installed. Publishing doesn't wait for it, and it's never attached to the release.
- Once a stable release is published and its package passed, the run [sends the package to the Microsoft Store](#sending-it-to-the-store), when the owner has turned that on.
- Nightlies are pre-releases and never marked latest. Stable releases are marked latest.
- Runs never cancel each other. Nightlies and stable releases wait in one queue, and each pull request's dry runs in their own, so a requested stable release is never dropped.
- Sharing the queue keeps a nightly from being planned while a stable release builds. Planned then, it would preview the same version as the stable release, from newer code, and sort before it. A stable release waits for a nightly that's running, and the other way round.
- The nightly a stable run publishes first is part of that run, not a run of its own, so it never waits in the queue behind the run that needs it.

## Versions

- Stable: `0.0.1`
- Nightly: `0.0.2-nightly.20261002.14`, the stable version it previews, the UTC date and the workflow run number

`package.json` on `main` holds the newest stable release, `0.0.0` before the first. A nightly previews the next patch. It counts from the newest stable release instead when `main` hasn't recorded that one yet, so a nightly always sorts after every published release. It sorts before the stable release it previews. The app offers Nightly users nightlies only, so they never get that release; they already have its changes. Versions 0.0.3 and earlier still offer it to them, as the [feed](#update-feed) explains.

## Nightly builds

- A check, after a push to `main` or on the schedule, builds when the last published nightly is at least six hours old and `main` has commits that descend from it. The check runs once the run's turn in the queue comes, so it sees any release published ahead of it.
  - No nightly yet: builds.
  - Nothing new since the last nightly, or `main` older than it: skipped.
  - `main` no longer contains the last nightly, after its history was rewritten: skipped with a warning. Start a nightly by hand to continue from `main`.
- Drafts and pre-releases without a nightly version don't count as the last nightly.
- A nightly started by hand skips both conditions.
- The version commit after a stable release counts as new, so a nightly follows each stable release.
- A stable run publishes a nightly of `main` first when the latest nightly lacks commits `main` has; see [stable releases](#stable-releases).

## Stable releases

1. Test a nightly: install it, update an existing install to it, and play a few channels.
2. Run the Release workflow on `main` with channel **stable**. Enter the nightly you tested, such as `0.0.2-nightly.20260930.30` or its tag. It's required: the plan refuses a stable run without it, so a nightly published after your test can't ship untested.
3. Leave the version empty to release the version the nightly previewed (`0.0.2-nightly.*` ships as `0.0.2`), or enter one that sorts after it and every stable release, such as `0.1.0`.
   A nightly from before the newest stable release can ship only when it holds that release's commit, like the nightly a stable run publishes first: 0.0.4's run published `0.0.4-nightly.20261002.117` from a newer commit than 0.0.4. The version it previewed is out by then, so enter one, such as `0.0.5`.
4. When `main` has commits the latest published nightly doesn't, the run first publishes a nightly of `main`, without waiting six hours, and updates the feed. Nightly users then have every change before Stable users get any of it. That nightly previews the patch after the newest stable release, usually the same version as the one you tested, such as `0.0.2-nightly.20261002.31`, so it sorts after it and before the stable release. Its notes list the changes since the previous nightly. The stable release builds only once that nightly is published and the feed names it. When the latest nightly already has `main`'s commit, the run skips this step.
5. The run rebuilds the tested nightly's exact commit with the stable version, never that of the nightly it just published. The nightly's files carry the nightly version, so they're never reused. Merges to `main` since the tested nightly don't reach the build.
6. It publishes the release as latest and updates the feed. Stable users are offered it from then on. Nightly users aren't: the feed's `nightly` keeps naming the newest nightly, the one published before the stable release when the run published one.
7. The finalize job commits `chore(release): prepare vX` to `main`, so `package.json` records the release and later nightlies preview the patch after it.
8. The run also builds the [Microsoft Store package](#microsoft-store-package) for the stable release and, once the release is published, [sends it to the Store](#sending-it-to-the-store). The nightly before it gets none.

The plan refuses a stable release when:

- no nightly is entered
- the nightly entered is a draft, has no release, or isn't a nightly version
- `main` doesn't contain the nightly's commit
- the nightly came before the newest stable release and lacks its commit, so it can hold older code
- the nightly came before the newest stable release and no version is entered
- the version is already released or would sort before the nightly
- the nightly to publish first would sort after the stable release, which happens only when `package.json` on `main` records a version no release has

## Release notes

`release-plan.ts notes` lists every pull request merged between the previous release of the same channel and the commit the run builds, each once, oldest first:

- Stable: from the previous stable release to the promoted nightly's commit, covering every nightly in between. Pull requests merged to `main` after that commit are left out.
- Nightly: from the previous nightly to its own commit, also for the nightly a stable run publishes first.
- A channel's first release lists everything up to its commit.

Commits pushed without a pull request, such as the version commit, aren't listed.

## Update feed

The app looks for updates in `updates.json` at the root of the repository's GitHub Pages site: `https://mr-streamer-oss.github.io/MrStreamer/updates.json`, or the root of a custom domain once one is set. It downloads them from GitHub Releases. `packages/contracts/src/update-feed.ts` defines the format:

```json
{
  "schema": 1,
  "generated": "2026-09-30T13:40:12.000Z",
  "stable": {
    "version": "0.0.2",
    "published": "2026-09-30T13:33:35Z",
    "page": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.2",
    "files": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.2",
    "notes": "**Stable** · built from ...",
    "platforms": ["latest-mac.yml", "latest.yml", "latest-linux.yml"],
    "installers": [
      "Mr-Streamer-0.0.2-linux-amd64.deb",
      "Mr-Streamer-0.0.2-linux-x86_64.AppImage",
      "Mr-Streamer-0.0.2-mac-arm64.dmg",
      "Mr-Streamer-0.0.2-win-x64-setup.exe"
    ]
  },
  "nightly": {
    "version": "0.0.3-nightly.20261001.32",
    "published": "2026-10-01T09:12:40Z",
    "page": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.3-nightly.20261001.32",
    "files": "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.3-nightly.20261001.32",
    "notes": "**Nightly** · built from ...",
    "platforms": ["latest-mac.yml", "latest.yml", "latest-linux.yml"],
    "installers": ["..."]
  }
}
```

- `stable` is the highest stable release and `nightly` the highest nightly. Highest means by version, never by date. Either is `null` when there is none.
- The app offers each channel only its own releases, and Nightly only a version newer than the installed one. After a stable release, `nightly` still names the newest nightly, so a Nightly user who missed it before the stable release went out is still offered it.
- Versions 0.0.3 and earlier offer Nightly users the higher of `stable` and `nightly`, so they still get each stable release and each nightly after it, as before.
- Feeds deployed before 0.0.4 named the highest release of either channel as `nightly`, a stable release right after one. The next publication replaces such an entry with the highest nightly even when it's lower, since only versions 0.0.3 and earlier took a stable release from `nightly`, and they still find it as `stable`.
- `files` is the folder electron-updater reads the release's `latest*.yml` and installers from. `notes` is the release body, in Markdown.
- `installers` names the release's files that end in `.dmg`, `.exe`, `.AppImage` or `.deb`. The website's home page links the stable release's, and only the ones listed ([the website's downloads](../../apps/marketing/README.md#downloads)). The app doesn't read the list, and a release that lacks an installer still enters the feed. A feed written before the list existed has none, and the website then keeps the links it was built with.
- A release counts only when it's published, its version and pre-release flag name the same channel, and it carries `latest-mac.yml`, `latest.yml` and `latest-linux.yml`. One missing a platform is incomplete and never enters the feed.

`.github/workflows/update-feed.yml` writes the feed with `release-plan.ts feed` and deploys it, with an empty `.nojekyll`, after every published nightly and stable release. Dry runs publish nothing. Publications wait in a queue of their own and are never cancelled, so each reads the releases after the one before it deployed.

The feed never goes back. Each channel is compared with its own releases. When the releases name a lower version than the deployed feed, that channel keeps the deployed release, so a late or stale publication can't take users back. Only a run by hand with **allow-regress** moves a channel down. A publication that can't read the deployed feed or look up the Pages site stops instead of publishing from the releases alone; only a 404 for either counts as nothing deployed yet.

A failed publication shows on the release run's **Update feed** job but doesn't fail the run, since the release is out by then. Fix the cause, then regenerate the feed. The nightly a stable run publishes first is the exception: its failed publication fails the run before the stable release builds.

### Regenerating the feed

Run the **Update feed** workflow on `main`. It rebuilds the feed from the releases as they are now, and the run summary names each channel's release. Tick **allow-regress** only to move a channel to a lower version, after taking a bad release's update files away ([recovery](#recovery)).

### Enabling Pages

Needed once. Until then, every release's **Update feed** job fails at deploying, without failing the release.

1. In the repository's settings, under Pages, set the source to **GitHub Actions**.
2. Run **Update feed** on `main` to publish the first feed.
3. Open the feed's address: it must name the newest releases.

A custom domain set there moves the feed to that domain's root. The workflow looks the address up through the Pages API, so it needs no change.

## Dry runs

Add the label **release dry run** to a pull request from a branch of this repository. The run builds, signs, notarizes and tests the pull request's head commit like a nightly, prepares and checks the [source archives](licences.md#sources-on-every-release) a release would attach, and builds and tests the [Microsoft Store package](#microsoft-store-package) too. It keeps the files as workflow artifacts for 14 days and publishes nothing, so no update channel can offer the build. `build-release.yml` never publishes for a pull request, whatever the plan says, and a dry run never plans a nightly first. It takes the label off at once; add it again to test a later commit. The plan also logs what a scheduled nightly and a stable release of the latest nightly would do on `main` at that moment, including any nightly that would go first.

Forks get no signing secrets, so their pull requests can't run it.

A dry run of a pull request that only adds checks to a published nightly can be the later build the [installed upgrade check](../contributing/testing.md#installed-upgrade) installs over it.

## Package receipts

Successful Mac arm64, Linux x64, Windows x64 and Store package jobs upload a separate `package-receipt-<platform>-<distribution>-<app-version>-attempt-<attempt>` artifact. It contains only `package-receipt.json`. The authoritative schema, producer and read-only resolver are in `apps/desktop/scripts/package-receipt.ts`, using the existing ArkType validator.

Schema version 1 records `status: "success"`, repository, `sourceCommit`, `workflowCommit`, app and package versions, platform, direct or Store distribution, run id/attempt/head commit, the package artifact's exact id/name/SHA-256, and every uploaded file's name/byte count/SHA-256. Direct package versions equal the app version. Store package versions use the existing four-part version rule. Source, workflow and run head can differ: stable rebuilds the tested nightly's source under the current workflow and a distinct stable version.

The job loads receipt tooling from the pinned workflow commit after packaging, signing/notarization, installed smoke checks and package upload have succeeded. Store also retains its manifest, installed identity/data, WACK and uninstall checks. The final Mac set is the notarized/stapled DMG, ZIP, ZIP blockmap and latest-mac.yml. Notarization deletes the stale DMG blockmap before upload; receipts do not require or restore it. The producer checks the source checkout, package.json and complete uploaded file set; a partial or failed job cannot upload a successful receipt. An uploaded package without its receipt can remain after a failed receipt step and is refused by receipt consumers. Receipts stay separate from installer/source uploads, GitHub Releases, update feeds and Store submission. The existing MSIX verification record and Store checksum handoff remain intact.

`resolvePackageReceipt` takes a pinned source and workflow commit, app/package version, platform/distribution and run/attempt/head commit. It validates downloaded JSON, requires one exact receipt and package artifact, checks GitHub run/head/expiry/digests and artifact id, recomputes both archive digests, and verifies every file's size and hash. Missing or ambiguous artifacts/files, duplicate ZIP names, extra files, wrong metadata and altered bytes stop resolution. Listing all artifact pages prevents a truncated response from masquerading as absence.

The Windows installed-upgrade resolver uses receipts and GitHub commit/pull-request metadata for new dry runs. It queries `/actions/runs/<run>/attempts/<attempt>` for the selected attempt, validates its run/head/repository/workflow/success identities, and requires exactly one `referenced_workflows` entry for this repository's `.github/workflows/build-release.yml`. That entry's SHA becomes the expected `workflowCommit`; the receipt must match it. Missing, ambiguous or mismatched workflow identity stops selection without assuming the app source or event head is the workflow commit. See GitHub's [workflow run attempt API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt). Only runs through number 296 and id `38104229048`, the last observed Release run before this contract, may use historical Plan logs when the complete artifact listing contains no package receipt. This boundary is fixed. Those receipt-free historical runs may legitimately lack `referenced_workflows` and do not require a selected-attempt workflow identity. That exception never applies when a receipt exists. A malformed receipt, a missing current-attempt receipt when other receipts exist, an API/download failure or a hash mismatch never triggers legacy fallback. Published stable and nightly installers retain their tag/checksum/update-metadata checks.

Public contract tests use synthetic package bytes and mocked GitHub responses, including producer CLI execution. They do not prove a native CI package. Before release acceptance, retain actual same-source receipt/package pairs from an authorized dry run for every applicable target and run the affected installed-upgrade verification. Neither a receipt nor these tests authorize dispatch, publication or Store submission.

## Microsoft Store package

The Microsoft Store gets an MSIX of the same app for Windows x64, which electron-builder's `appx` target builds from the same files as the installer. The [Store runbook](microsoft-store.md) covers Partner Center and the submission.

- **Identity:** `apps/desktop/electron-builder.yml` holds the identity Partner Center reserved, exactly as its Product identity page shows it, and the application id `MrStreamer`. Windows pins and groups the app by the two together, `MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr!MrStreamer`, so neither may change after the first submission.
- **Name:** the package and its Start entry are called "Mr. Streamer: IPTV Player", the app's [Store name](microsoft-store.md#store-name). The installers, the `.exe` and the data folder keep "Mr. Streamer".
- **Capabilities:** only `runFullTrust`, which every Electron app needs. Partner Center asks why it's needed. Answer that Mr. Streamer is a desktop app built on Electron, which runs as a full-trust desktop process: it starts its bundled ffmpeg and ffprobe, and plays through a proxy on 127.0.0.1.
- **Logos:** `pnpm icons:export` renders them from the bare mark into `apps/desktop/build/appx`, not from the macOS icon's squircle. The app list icon comes at the 14 target sizes Windows asks for, each plated, white for the dark theme (`altform-unplated`) and black for the light theme (`altform-lightunplated`), so Windows draws the hat itself in the taskbar and Start instead of shrinking it onto a system plate. The tiles, `StoreLogo` and the Windows 10 small and large tiles come at 100, 125, 150, 200 and 400 %, true black with the white mark large in the middle.
- **Windows versions:** Windows 11 and later, as for the installer.
- **Building:** the **Package Microsoft Store MSIX** job builds it for dry runs and stable releases, as soon as the Windows installer is built and not when the other platforms are. Nightlies never build it. The Windows installer's job caches the Windows ffmpeg and passes the cache's key on, so the package restores it on a cold cache too. Publishing doesn't wait for the job, so a failure there can't hold up or undo a release. On a Windows PC, `pnpm dist:msix` builds the same file.
- **What it keeps:** the job's `msix-<version>` artifact holds `Mr-Streamer-<version>-win-x64.msix`, a `.msix.json` naming the release version, the package version, the commit and the file's SHA-256, and the certification kit's report, `.wack.xml`. Dry runs keep it 14 days, stable releases 90. Only a package that passed every check gets that name: one that failed is kept 14 days as `msix-failed-<version>`, to look at. It never goes on the release, and electron-builder writes no `latest*.yml` for it, so no update channel offers it.
- **Checks:** the job compares the manifest with Partner Center's identity, the Store name and the package version, which `scripts/store-release.ts` holds and runs from the workflow commit, and checks that the package holds the app, ffmpeg, ffprobe and Chromium's and Electron's notices. Then it signs a copy with a throwaway certificate (see [signing](signing.md#microsoft-store-package)), installs it, checks that Windows gives it the reserved package family name, runs the [packaged-app test](../contributing/testing.md#packaged-app) on it, runs the Windows App Certification Kit, which must pass, and uninstalls it, which must remove its data. The kit's optional "Blocked executables" test fails, because it flags strings such as "cmd" and "reg" inside Electron's and ffmpeg's files; the overall result passes.

### Store versions

The Store reads a four-part version with 0 to 65535 in each part. The first part can't be 0, and the fourth belongs to the Store and must be 0, as Microsoft's [package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements) said on 2 October 2026. Releases start at 0, so:

- Only stable releases go to the Store, with 1 added to the major version: 0.0.4 is `1.0.4.0`, 0.1.0 is `1.1.0.0` and 1.0.0 is `2.0.0.0`.
- The 1 stays added for good. The Store only moves a package up, and without it 1.0.0 would be `1.0.0.0`, below 0.0.9's `1.0.9.0`.
- A dry run or nightly makes a test package for sideloading, numbered between the stable release before it and the one it previews, with the workflow run last: 0.0.4-nightly.20261002.14 is `1.0.3.14`. The Store refuses a fourth part that isn't 0, so a test package can't be submitted by mistake.
- The app keeps showing the release version. Settings says 0.0.4 while Windows lists `1.0.4.0`.

`packages/contracts/src/package-version.ts` maps them, and `apps/desktop/scripts/msix-version.ts` writes the result into the manifest. Testing an update through the Store takes two stable releases, such as 0.0.4 and then 0.0.5. The package's `.msix.json` and the release's tag tie each Store version to its commit.

### Sending it to the Store

Once a stable release is published and its package passed every check, the run's **Microsoft Store** job sends that package to Partner Center, from `.github/workflows/microsoft-store.yml`. The [Store runbook](microsoft-store.md#how-a-release-reaches-the-store) has what it checks, what it changes in the listing and what it never does.

- Only a stable release started from `main` reaches it. A nightly, a dry run, a push or a tag never does.
- It sends the file the run built and tested, from the `msix-<version>` artifact, and never builds another.
- It's off until the owner [sets it up](microsoft-store.md#setting-up): until then the job says so and sends nothing, and the package is [submitted by hand](microsoft-store.md#submitting-by-hand).
- It waits until Microsoft has taken the upload, ten minutes at most, and not for certification, which can take days. The job belongs to the release run, so the next run in the queue waits those minutes too.
- The release is out before it starts. A failure shows on the run and changes nothing about the release.

## Recovery

- **Preparing the sources failed:** nothing was published. When an upstream server didn't answer, re-run the job. When a download no longer matches its SHA-256 or a commit is gone, upstream changed: find out why before touching the pin in `apps/desktop/licences.config.json`. When the notices and the sources differ, fix that on `main`; see [licences](licences.md#sources-on-every-release).
- **A check or platform failed:** nothing was published. Re-run the failed jobs to retry the same commit and version, or fix it on `main` and let the next nightly pick it up. For stable, promote a nightly that has the fix.
- **The nightly before a stable release failed:** the stable release hasn't built. Re-run the failed jobs, after fixing the cause when its feed failed; the stable release builds once the nightly is published and the feed names it. To get the nightly into the feed sooner, [regenerate the feed](#regenerating-the-feed) first.
- **Publishing failed:** re-run the failed jobs. A broken attempt leaves at most a draft, which the next attempt deletes first.
- **The version was taken meanwhile:** publishing refuses. The next nightly plans a new version; start a stable release again, with another version if needed.
- **Finalize failed:** re-run it. It only moves `package.json` forward, so running it late or twice is harmless, and until it succeeds nightlies count from the published stable release.
- **The feed wasn't updated:** the release is out, and the run's **Update feed** job shows why. Fix that, such as [enabling Pages](#enabling-pages), then [regenerate the feed](#regenerating-the-feed) by running **Update feed** on `main`. When the job couldn't reach the deployed feed or the Pages API, regenerating once GitHub answers again is enough.
- **The Store job failed, or the MSIX job before it:** the release is out. The [Store runbook](microsoft-store.md#when-a-submission-fails) says what each failure needs.
- **A bad release is out:** publish a fixed one. To stop offering it sooner, delete the release's three `latest*.yml` files, then regenerate the feed with **allow-regress**: without them the release counts neither for the feed nor for the app's fallback to GitHub's API, and the feed never goes back by itself. For a stable release, mark the stable release before it as latest too. Keep the release itself, with its installers and its [source archives](licences.md#sources-on-every-release). Whoever installed it is owed those sources under the GPL and the LGPL, and the release holds their only copy. Run **Marketing deploy** on `main` after regenerating the feed so the website also stops offering the bad release. None of this downgrades anyone who installed it.

## Permissions

- The publish job creates releases with the workflow token (`contents: write`) and reads the pull requests behind each commit for the notes (`pull-requests: read`).
- The finalize job pushes to `main` with the same token (`contents: write`). `main` has no branch protection or rulesets. If one is added, let GitHub Actions bypass it or give finalize a GitHub App token, or the push is refused.
- Pushes by the workflow token start no workflows, so the version commit doesn't run CI.
- The plan job removes the dry-run label (`pull-requests: write`).
- The feed job reads the releases (`contents: read`) and deploys to Pages (`pages: write`, `id-token: write`) through the `github-pages` environment.
- The Store job reads the run's own package and the Store environment's branch rule (`actions: read`). Its credential is the secret of the `microsoft-store` environment, which only `main` may use, and only that job's last step reads it; see the [Store runbook](microsoft-store.md#setting-up).
- Only the macOS packaging step reads the signing secrets; see [signing](signing.md). The bundle step reads `TMDB_API_KEY` (see [TMDB key](#tmdb-key)) and, except in dry runs, `POSTHOG_PROJECT_TOKEN` with the variable `POSTHOG_HOST`, which turn on the app's analytics. Without them the build sends nothing. CI needs none.

## TMDB key

Movies and Series take genres, popularity and streaming services from TMDB. The bundle step passes the repository secret `TMDB_API_KEY`, a TMDB API Read Access Token, to the build as `MR_STREAMER_TMDB_KEY`, which builds it into the main process's bundle. Without the secret, the build succeeds and the app has no key: movies and series show without genres or services until a viewer adds their own in Settings.

The token can be read out of any installer. It only reads TMDB's public data. If it's abused or revoked, regenerate it in the TMDB account's API settings, update the secret, and release; until then, viewers can use their own key.

TMDB's terms ask that the app shows its logo and notice, which Settings > About does, keeps its data no longer than six months, which the app drops after that, and credits JustWatch for streaming services, which About and the Services tab do.

## Windows signing

Windows installers are unsigned for now, and SmartScreen warns on first run. The Store signs the MSIX it delivers; see [signing](signing.md#microsoft-store-package). Signing the installer belongs in the "Build for Windows" step, with its own secrets and never the Mac certificate; electron-builder signs when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are set. Once signed, set `win.signtoolOptions.publisherName` in `electron-builder.yml` so updates must carry the same publisher.

## Testing updates against another feed

To try an update flow without publishing, serve a folder over HTTP holding an `updates.json` in the [feed format](#update-feed), and start the app with `MR_STREAMER_UPDATE_FEED=http://127.0.0.1:PORT/updates.json`. Point each release's `files` at a folder holding its `latest*.yml` and installers, on the same server or on GitHub Releases. Copying the deployed feed and editing `version` and `files` is the quickest start.
