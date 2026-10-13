# Microsoft Store

> For maintainers. How a stable release reaches the Store, the one-time setup, and what to do when a submission fails. [Releasing](releasing.md#microsoft-store-package) covers how the package is built, numbered and checked, and [licences](licences.md#microsoft-store) the source offer the listing carries.

The Store gets a Windows x64 MSIX of each stable release, beside the direct-download installer. The listing is public: anyone installs it from `https://apps.microsoft.com/detail/9N45GG76ZP4T`, and an update reaches every Store user once Microsoft certifies it. The Store installs and updates the app, and signs what it delivers.

After a stable release is published, the release run sends its package to Partner Center through Microsoft's [Store submission API](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services). That is off until the owner [sets it up](#setting-up) and turns it on. Until then, and whenever the automation can't go on, a package is [submitted by hand](#submitting-by-hand). Credentials, identity documents and anyone's addresses never go into the repository, logs or published evidence.

## Listing languages

[store-listings.json](store-listings.json) holds an English reference for the translations, not a replacement for the live English listing, and Dutch, French, German and Spanish listing text. The approved 0.0.8 text is available at merged commit `2755cde`; the 0.0.9 capability additions for mapped M3U movie and episode imports are candidate copy awaiting owner approval before external use. Submit them only with that release and approval. From 0.0.10 the app's interface is in English, Dutch, French, German and Spanish, and the package declares those five languages (`languages` in `apps/desktop/electron-builder.yml`). Each listing says so; that sentence is candidate copy awaiting owner approval with the 0.0.10 release. Before using it for a later release, check its feature claims against that release, including what a plain M3U playlist can play.

The owner adds a listing language in Partner Center and pastes its short description, description, features and keywords. Confirm that Partner Center accepts a listing language without a matching package language, and check which screenshots it requires. Paste the fixed introduction from `scripts/store-submission.ts` into What's new and save it, to confirm the field accepts its release-history address. A refusal needs revised copy approval before submission. Put the next release into this existing draft by [naming it and its fingerprint](#using-a-draft-made-in-partner-center); an ordinary release run stops at a listing draft. The JSON is a copy source, not an automatic submission input. Existing listing descriptions, keywords and screenshots are preserved by the submission script.

The automated submission gives each Dutch, French, German and Spanish listing a fixed introduction in its language, followed by the English PR titles. The introduction links to the English release history. English and other listings keep the English notes. Each field stays within 1,500 characters, with whole PR titles only.

## Package identity

From Partner Center's Product identity page. These values are public: every package carries them, `apps/desktop/electron-builder.yml` uses them exactly, and none may change.

| Value                                   | Mr. Streamer                              |
| --------------------------------------- | ----------------------------------------- |
| Package/Identity/Name                   | `MrStreamerOSS.Mr.Streamer`               |
| Package/Identity/Publisher              | `CN=A132E842-C4C9-40BF-83C4-D304E7952C2D` |
| Package/Properties/PublisherDisplayName | `Mr Streamer OSS`                         |
| Package family name                     | `MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr` |
| Store ID                                | `9N45GG76ZP4T`                            |

The publisher display name has no period on purpose: Partner Center doesn't allow one there. The Store ID is also what the submission API calls the application ID. `STORE_APP` in `scripts/store-release.ts` holds these values, and the release run's package check and the Store job hold every package to them. A test fails when `electron-builder.yml` differs.

## Store name

The Store lists the app as "Mr. Streamer: IPTV Player". On 7 October 2026 the Store's search put "Mr. Streamer" first for "mr streamer" and outside the top 20 for "iptv", "iptv player", "m3u player" and "xtream". Every app in the top 12 for "iptv player" but VLC had "IPTV" in its title.

Partner Center holds two names for the app, under Product management > Manage app names: that one, reserved the same day, and "Mr. Streamer", which every package up to 0.0.7 carries. Keep both reserved.

| Where                                                       | Name                                    |
| ----------------------------------------------------------- | --------------------------------------- |
| The Store's listing and search                              | Mr. Streamer: IPTV Player               |
| Start, Windows search and Settings > Apps, for a Store copy | Mr. Streamer: IPTV Player               |
| The window, `Mr. Streamer.exe` and the direct installers    | Mr. Streamer                            |
| The Store copy's data folder                                | `Mr. Streamer Store`, under the package |

- `appx.displayName` in `apps/desktop/electron-builder.yml` sets it, and `STORE_NAME` in `scripts/store-release.ts` is the same string. A test fails when they differ.
- electron-builder 26 has one setting for the package's name and for the name of its Start entry, and writes the same string to both. The release run's package check fails when the two differ. Giving Start the short name would take a manifest template of our own (`appx.customManifestPath`). We use the Store name in both, so the app is called in Start what it is called where it was installed from.
- The [identity](#package-identity), the application id and the data folder don't follow the name. Windows updates, pins and keeps data by those, so a renamed package is an update of the installed one.
- A listing has to carry the name its package does, and Partner Center offers a name under Product name only once a package with it is uploaded. So the automation goes by the package. When the package is named "Mr. Streamer: IPTV Player", every listing titled otherwise takes that name in the same submission, and the report says so. A package named "Mr. Streamer" changes no title.

### The first rename

0.0.8 is the first release whose package carries the name. Until its submission is published, the listing and every installed copy say "Mr. Streamer". These are 0.0.8's checks, with their results recorded on its release card:

1. Release 0.0.8 from a nightly that has the rename. The package check's line in the run's summary says `named 'Mr. Streamer: IPTV Player'`. Then, a commit from before the rename built a package named "Mr. Streamer", which passed too and left the listing as it was. Since every promotable nightly holds 0.0.12, the package check now refuses any name but the Store name.
2. The Store job's report has the line `The submission retitles the listing in en-us "Mr. Streamer: IPTV Player", as its package is named.` Without it, the submission left the title alone.
3. The API has never changed a title for us. If Microsoft refuses it, at the update or at the commit, [submit by hand](#submitting-by-hand), choosing the name under Product name yourself. A submission the automation created is deleted in Partner Center first. A [draft a run named](#using-a-draft-made-in-partner-center) is finished there instead.
4. Once **status** says `Published`, the public listing shows "Mr. Streamer: IPTV Player".
5. On a Windows 11 PC that has 0.0.7 from the Store, with a subscription connected, a favourite, something watched and the app pinned to Start or the taskbar, let the Store update it. Don't uninstall first. Then:
   - Start, Windows search and Settings > Apps > Installed apps list "Mr. Streamer: IPTV Player" once, at 1.0.8.0.
   - The pin opens the app.
   - The subscription, favourites, watchlist, history and progress are there, and nothing asks for the login again.
   - The data is still in `%LOCALAPPDATA%\Packages\MrStreamerOSS.Mr.Streamer_5yzg1erdm3xmr\LocalCache\Roaming\Mr. Streamer Store`.
6. Two weeks after publication, run the searches above again and record the positions on the Store name's card.
7. The report of the release after 0.0.8 has no retitling line, and the listing keeps the name.

To see the names Windows uses before any of that, sideload a dry run's package as [signing](signing.md#microsoft-store-package) describes.

## How a release reaches the Store

1. The stable release run builds the MSIX, tests it installed, and keeps it as the artifact `msix-<version>` with a record of its release, commit and SHA-256 ([releasing](releasing.md#microsoft-store-package)).
2. Once the release is published and the package passed every check, the run's **Microsoft Store** job starts, in `.github/workflows/publish.yml`. Only a stable release started from `main` gets there: never a nightly, a dry run, a push or a tag. It's a job of the release run because GitHub starts no workflow for a release the workflow's own token created.
3. `scripts/store-release.ts` checks, before anything signs in:
   - the release is published, neither a draft nor a pre-release, and its tag points at the commit the run built, which `main` contains
   - the package is that run's own artifact, and its checksum is the one the build job reported and the one in its record
   - the package's manifest carries the identity above, x64, and the release's [Store version](releasing.md#store-versions). It also reads the name the manifest gives the app.
4. `scripts/store-submission.ts` then signs in and:
   - reads the published submission and any submission in progress
   - creates a submission, which is Microsoft's copy of the published one
   - changes two things in it. The package: the new one is added and the copied ones are marked for removal, since the Store gives the newest to everyone they served. And "What's new": the titles of the release's changes, without authors and links. The description, screenshots, trailers, price, markets and every other field go back as they came.
   - gives every listing the package's name as its title, when the package carries the [Store name](#store-name) and a listing doesn't yet. That happens once, in the first submission with such a package.
   - uploads the package under a name that carries the release's commit and the file's checksum, such as `Mr-Streamer-0.0.5-win-x64.5f3a9c0d1e2f.0a1b2c3d4e5f6071.msix`
   - commits the submission and waits, ten minutes at most, until Microsoft has taken or refused the upload
5. Microsoft certifies the submission, which can take up to three business days, and the listing publishes it as soon as it passes. The job doesn't wait for that: [status](#checking-and-repeating) reads how it ended.

The release is out before the job starts, and neither the update feed nor the version commit waits for it. A failed submission shows on the release's run and changes nothing about the release.

### What a run reports

Each on its own line, in the log and the run's summary: the GitHub release, its commit, the Store package version and file name, the submission ID and Microsoft's status. A committed submission isn't a published one, so the last line says which it is.

| Microsoft's status                                                                               | What it means                             | The run          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------- |
| `Published`                                                                                      | Live in the Store                         | Passes           |
| `CommitStarted`, `PreProcessing`, `Certification`, `Release`, `Publishing`, `PendingPublication` | Microsoft is checking or publishing it    | Passes, not live |
| `PendingCommit`                                                                                  | A draft that was never committed          | Fails            |
| `CommitFailed`, `PreProcessingFailed`, `CertificationFailed`, `ReleaseFailed`, `PublishFailed`   | Microsoft refused it                      | Fails            |
| `Canceled`, or a status this list doesn't name                                                   | Stopped, or unknown and treated as failed | Fails            |

### What it never does

- It never sets who sees the app or when it is published. The published submission must be `Public` and publish as soon as it is certified, which the API calls `Immediate`. Otherwise the run stops before it creates anything.
- It never deletes a submission, and never changes one that was committed.
- It never starts a second submission. The Store takes one at a time: a submission in progress that doesn't hold this release's package stops the run, whoever made it.
- It never takes up a draft someone made in Partner Center, and never goes on with one an earlier run put a release in, unless a run started by hand [names that draft](#using-a-draft-made-in-partner-center) and its fingerprint.
- It never sends a package the Store's own doesn't sort before.
- It never gives a listing a name its package doesn't carry.
- It repeats only requests that change nothing by being repeated. When creating or committing gets no clear answer, it reads what happened instead of asking twice.
- It prints nothing of the key, a token or an upload address, and of Microsoft's answers only what the script knows the shape of.

Don't edit a draft the automation made in Partner Center. Once someone has, Microsoft's API can no longer change or commit that submission.

## Checking and repeating

Run the **Publish** workflow on `main` with target **store**, and one of three actions under **store-action**:

- **preflight** signs in and lists what the account holds: the application, the published submission with its audience and publishing mode, its packages, listings and trailers, and any submission in progress. With a version it also checks that release's package and says what a submission would do. It reads only, and works before submissions are turned on.
- **status**, with a version, says where that release stands in the Store. Run it a few days after a release to see whether certification passed. It finds a package uploaded by hand too, by its version, and says so. It reads only.
- **submit**, with a version, sends a published stable release's package when the release's own run couldn't. It takes the package from the newest stable release run that still holds `msix-<version>`, and follows the same checks and rules. Run again for a release the Store already has, it reports where that submission stands and sends nothing.

Every Store job, a release's or one started by hand, waits its turn in one queue, so no two read or change the Store at once.

### Using a draft made in Partner Center

A draft someone made in Partner Center, to change the listing with the next release, takes that release only when a run names it. A release's own run and a plain **submit** stop at it, as at any submission that doesn't hold their package.

1. Run **preflight** with the version and, under **draft**, the draft's submission ID. A plain preflight prints that ID as the submission in progress. The run reads only. It prints the fields in which the draft differs from the published submission, by their paths and never their contents, and the draft's fingerprint.
2. Check that those are the fields someone edited.
3. Run **submit** with the same version and draft, and the fingerprint under **draft-metadata-sha256**.

The fingerprint is the SHA-256 of everything Microsoft's API shows of the draft that a release leaves alone. That is all of it but the packages, each listing's "What's new", its title when the package carries the [Store name](#store-name), and Microsoft's own status and upload address. The order Microsoft sends fields in doesn't change it. The order of a list, such as the search terms, does. Two preflights of an untouched draft print the same one.

**submit** then:

- changes nothing unless the submission in progress is that draft, still has that fingerprint, is `Public` and `Immediate`, and holds no package but the published ones and the release's. It never creates a submission.
- puts the package, "What's new" and the title in as it does with a new submission, and marks the packages the draft copied for removal
- reads the draft again, and uploads nothing unless every other field is as it was and the draft holds what was sent. The error names the fields that changed, by their paths.
- uploads the package
- reads the draft once more and checks the same again, since anyone who can open the draft may have changed it during the upload. Only then does it commit. When someone committed the draft meanwhile, the run commits nothing and reports where that submission stands.

In such a draft the package has a longer name: the one it has anywhere, then the draft's ID and the first 16 characters of the fingerprint, such as `Mr-Streamer-0.0.5-win-x64.5f3a9c0d1e2f.0a1b2c3d4e5f6071.draft-1152921500000000000.9f8e7d6c5b4a3921.msix`. The file is the same. The name is how runs tell this draft from one the automation created:

- A run that stops after the update leaves the draft listing the package, uncommitted. Go on with **submit**, the same draft and the same fingerprint. It finds the package by that name, uploads again and commits. A **preflight** with both says first what that run would do.
- A plain **submit** and a release's own run, re-run, look for the shorter name. They stop at the draft and send nothing, however far the earlier run got.
- **status** finds the package under either name.

When the run says something a release leaves alone has changed, during the update or the upload, the draft no longer has the fingerprint its package is named for. No run goes on with it then, not even one with the fingerprint a new preflight reads. Look at the draft in Partner Center. Putting the fields the error names back as they were makes the first fingerprint fit again, and the same **submit** then goes on. Microsoft may still refuse to commit a draft that was edited there after the API changed it. When it does, or when the fields can't be put back, finish the draft there, following [submitting by hand](#submitting-by-hand) from step 3.

Nothing holds the draft still between that last read and the commit. A change made in those seconds would go in unseen, so leave the draft alone while a run that names it is under way.

Microsoft's API takes an update of a draft made in Partner Center. It may refuse one the API made and someone edited in Partner Center afterwards. When Microsoft refuses, the run prints its answer and leaves the draft as it was. The draft holds its owner's edits, so finish it there, following [submitting by hand](#submitting-by-hand) from step 3.

## When a submission fails

The release is out either way. The run's error names the case.

- **Submissions are off:** a notice on the release's run, and no failure. [Submit by hand](#submitting-by-hand) or [set the automation up](#setting-up).
- **The MSIX job failed:** the Store job was skipped. Re-run the failed jobs. When the package passes, the Store job follows in the same run. A package that failed a check is kept as `msix-failed-<version>` and is never submitted.
- **Another submission is in progress:** let it finish, or delete it in Partner Center if nobody needs it, then run **submit**. A draft that carries listing edits is one somebody needs: [put the release in it](#using-a-draft-made-in-partner-center).
- **A run that named a draft stopped:** the error says whether the draft was changed. [Using a draft](#using-a-draft-made-in-partner-center) says how to go on, always with the draft and its fingerprint named. A plain **submit** and a re-run of the release's Store job stop at such a draft.
- **A submission appeared and nothing shows whether this run made it:** the request to create one got no answer. Open that submission in Partner Center. When it is an untouched copy of the published one that nobody is working on, delete it there, then run **submit**.
- **A submission is left as an untouched copy:** Microsoft created it and then refused the package's entry. Delete it in Partner Center, then run **submit**.
- **A draft the automation created holds the package but wasn't uploaded or committed:** run **submit**. It finds the draft by the package's name, uploads again and commits it.
- **Microsoft refused it** (`CommitFailed`, `CertificationFailed` and the like): the run prints Microsoft's errors, and Partner Center holds the certification report. Nothing of that release is live. A fault in the package needs a fixed stable release: delete the refused submission in Partner Center first, since the API creates a new one only when none is in progress. A fault in the listing or the notes for certification is fixed in Partner Center, where the submission is then sent again by hand. A refused submission that began as a [draft a run named](#using-a-draft-made-in-partner-center) still holds its owner's edits, so its owner decides what becomes of it.
- **The listing isn't Public and Immediate:** someone changed the audience or the publishing hold. Decide which is meant. The automation only updates a public listing that publishes when certified.
- **The sign-in is refused:** the key ended or was replaced. [Renew it](#renewing-the-key).
- **No run holds the package any more:** release runs keep it for 90 days. A later stable release brings a new package.

## Submitting by hand

1. Download the artifact `msix-<version>` from the stable release's run. Its `.msix.json` names the package version, the commit and the SHA-256.
2. In Partner Center, start a new submission of Mr. Streamer. It copies the previous one's settings.
3. Under Packages, upload the artifact's `.msix` unchanged. A rebuild from `pnpm dist:msix` is a different file, one the release run never checked.
4. Wait for the row to show the package version from `.msix.json`, such as `1.0.6.0` for 0.0.6. If it stays on "Analyzing package", reload the page first. A reload has cleared such a row before. Upload again only when the reloaded page doesn't list the package.
5. Save, then look at Packages again. It should list the new version alone. Partner Center removed the lower version by itself when 1.0.6.0 was saved. Microsoft [describes](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages#removing-redundant-packages) a warning with an option to remove redundant packages instead, so use that option if a lower version is still listed.
6. Check the [settings below](#settings-every-submission-keeps) and update "What's new" in the listing. When the package carries a name the listing doesn't show, choose it under Product name in each language's listing. Partner Center offers it once the package is uploaded.
7. Submit for certification, which can take up to three business days. Nothing holds the submission after that. The listing publishes it to everyone as soon as it passes, so submitting is the decision to publish, and that decision is Wout's.
8. Partner Center sends a notice when the submission is published. Check that the public listing shows a new "Last updated date". Record the submission, its package version and when it was submitted and published on the release's card in the GitHub project.

While a submission made by hand is in progress, the automation refuses to start another. **status** follows it by the package's version.

## Setting up

`scripts/setup-microsoft-store.sh` walks through it, resumes where it stopped, and keeps its progress in the gitignored `.local/`. It needs `gh` signed in with admin access to the repository. Each stage asks before it changes anything.

1. **tenant:** Partner Center needs a Microsoft Entra tenant linked to the account, under Account settings > Tenants. The page links an existing directory or creates one.
2. **application:** an application of that tenant, added under Account settings > User management > Microsoft Entra applications with the **Manager** role. Microsoft's submission API takes no lesser role, and a Manager can change every product and user of the account, so its key is as sensitive as the owner's own sign-in.
3. **environment:** the GitHub environment `microsoft-store`, which only `main` may use, with the two IDs as variables.
4. **key:** a key of the application, stored as the environment's secret. The wizard reads it hidden, hands it to GitHub through `gh`'s standard input and keeps no copy.
5. **check:** a **preflight** run, which signs in and reads the account without sending anything.
6. **activate:** the repository variable that turns submissions on.

| Setting                       | Where                                         | What it is                                                         |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `STORE_TENANT_ID`             | Variable of the `microsoft-store` environment | The tenant's ID. Not secret.                                       |
| `STORE_CLIENT_ID`             | Variable of the `microsoft-store` environment | The application's ID. Not secret.                                  |
| `STORE_CLIENT_SECRET`         | Secret of the `microsoft-store` environment   | The application's key                                              |
| `STORE_CLIENT_SECRET_EXPIRES` | Variable of the `microsoft-store` environment | The day the key ends, as `YYYY-MM-DD`                              |
| `STORE_AUTOMATION_ENABLED`    | Repository variable                           | `true` lets a run submit. Anything else, and nothing is ever sent. |

The API needs no seller ID.

The environment must exist for `main` alone before any job names it: GitHub creates a missing environment, open to every branch, for the first job that does. So the **Check the Store setup** job reads the setup through GitHub's API and stops when the environment is missing or allows more than `main`. Only then does the Store job start. That job runs `main`'s scripts with node alone, installs no packages, never checks out the release's commit, and gives the key to its last step only.

### Renewing the key

The key ends on the day Partner Center shows beside it. The Store job warns from 30 days before the recorded day, and a key that has ended fails the sign-in.

1. Run `scripts/setup-microsoft-store.sh key`: add a new key in Partner Center, and the wizard stores it and its end day.
2. Run `scripts/setup-microsoft-store.sh check` to see the new key sign in.
3. Only then select **Remove** beside the old key in Partner Center.

### Revoking

Remove the key on the application's page in Partner Center, or delete the application under User management. Either ends its access at once. Do it right away when the key may have leaked, then look through the app's submissions in Partner Center for one nobody here made. Deleting the GitHub secret alone revokes nothing.

### Turning it off

```sh
gh variable set STORE_AUTOMATION_ENABLED --body false
```

From then on a stable release says that submissions are off and sends nothing. The read-only actions keep working.

## Settings every submission keeps

A submission copies the one before it, by hand or through the API, so these stay as they are unless someone changes them in Partner Center.

**Pricing and availability.** Every market. Under Visibility, "Public audience" and "Make this product available and discoverable in the Store". Free, with no trial or sale, and the organizational licensing defaults.

**Properties.** Category Entertainment. "Yes, my product uses personal information", with `https://mrstreamer.app/privacy`. Website `https://mrstreamer.app`, support `hello@mrstreamer.app`. Untick "designed to run in an immersive (not 2D) view on Windows Mixed Reality" for PC and HoloLens: ticked, it declares a headset app and Partner Center then demands headset hardware. Windows backups to OneDrive off, since the data stays on the PC and a password sealed with the Windows account couldn't be opened elsewhere. No accessibility claim until someone tests it. Under System requirements, Keyboard and Mouse ticked as Minimum hardware. The listing shows them as required. Microsoft's [system requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/system-requirements) page says the Store may warn on a device without them. That device can still install the app but can't rate or review it.

**Age rating.** The IARC questionnaire for "All Other App Types", answered honestly. Online Content is Yes, because the app plays whatever the user's provider sends, which gives 18+ everywhere (ESRB Adults Only). Store policy 11.11.2 asks for an accurate rating.

**Listing.** English (United States).

- Product name "Mr. Streamer: IPTV Player", the [name](#store-name) the package carries.
- The description opens with what the app needs, as policy 10.2.4 asks: it supplies no channels, playlists or subscriptions, and the user connects their own provider.
- Screenshots and artwork come from the fake provider with made-up titles, as for the README ([development](../contributing/development.md#artwork)), and stay at a PEGI 12 level (policy 11.1) whatever the app's rating.
- The trailer stays selected to play at the top of the listing.
- Search terms name the formats it reads, never providers or channels.
- Copyright "Copyright (c) 2026 Mr Streamer OSS", which the public listing shows with ©. Keep that listing text for updates. The app and the package carry "Copyright © 2026 Wout Stiens" from `apps/desktop/electron-builder.yml`.
- **Additional license terms** carry the GPL-3.0 source offer ([licences](licences.md#microsoft-store)).

**Submission options.** Publishing hold options: "Publish this submission as soon as it passes certification (or per dates you selected in the Schedule section)", which is Partner Center's default and the mode the API calls `Immediate`. Never "Don't publish this submission until I select Publish now", which keeps a certified update unpublished until someone selects **Publish now** and stops the automation before it creates anything. The `runFullTrust` capability needs a justification: Mr. Streamer is an Electron app, which runs as a full-trust Win32 process like every Electron app packaged as MSIX. It starts its bundled ffmpeg and ffprobe as child processes and serves playback through a local proxy on 127.0.0.1. It installs no drivers or services, doesn't start with Windows and writes only to its own data folder.

**Notes for certification**, under Supplemental info > Additional Testing Information. The Description field won't save a link and the Credentials table refuses one too, so the notes say how to find the reviewers' playlist: open the public repository Mr-Streamer-OSS/certification-playlist on GitHub, open `reviewer.m3u`, choose Raw and copy the address. Then connect with **Use an M3U link** and no login. The notes also say that the demo is live TV only, without a guide, that Movies and Series need a provider that offers them, that titles and channels for adults stay hidden until Settings > General > For adults, and that the app asks before sending a login over http. Never give Microsoft a real subscription.

## The reviewers' playlist

[Mr-Streamer-OSS/certification-playlist](https://github.com/Mr-Streamer-OSS/certification-playlist) lists five channels that broadcasters stream free on their own watch-live pages: Al Jazeera English, DW English, DW Español, DW Arabic and ABC News Australia. Check what reviewers will see against it:

```
https://raw.githubusercontent.com/Mr-Streamer-OSS/certification-playlist/main/reviewer.m3u
```

It holds only broadcasters' own official streams that are free worldwide, on their own domains or CDNs, each with its official page cited. No aggregators, restreams, redirectors or geo-blocked streams, and logos only from the broadcaster's own domain. Its README links only, claims no affiliation, leaves the rights with the broadcasters and gives `hello@mrstreamer.app` for removal requests. Wout approves any change to its channels.
