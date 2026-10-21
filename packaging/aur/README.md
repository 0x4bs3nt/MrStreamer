# AUR maintainer runbook

Owner: Wout Stiens (`hello@mrstreamer.app`). Proposed package: `mrstreamer-bin`, x86_64 only.
This is an unpublished recipe template. There is no public AUR install command yet.
Public user documentation and website activation wait for checked public availability.

## Ownership and inputs

`PKGBUILD.in` owns the native package layout. The package-update preparation card
([276993052](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=276993052))
owns the **one shared renderer** for AUR and Homebrew. This directory adds no release discovery,
publishing workflow or generic renderer. Run it from the checkout:

```sh
node apps/desktop/scripts/package-updates.ts render --version 0.0.18 \
  --out .local/package-updates/stable-0.0.18
```

The offline `srcinfo` step needs an unprivileged clean Arch builder with `makepkg`,
`vercmp`, the [repository-supported Node/pnpm toolchain](../../docs/contributing/development.md)
and a checkout prepared with `pnpm install --frozen-lockfile`. The builder user must
be able to read that checkout and its installed dependencies and write to the
rendered directory. Copying only the rendered folder into a `base-devel` environment
is insufficient. From the checkout root inside that builder, replace
`/path/to/rendered-directory` with your rendered directory and run:

```sh
node apps/desktop/scripts/package-updates.ts srcinfo --dir "/path/to/rendered-directory"
```

See [package updates](../../docs/maintainers/releasing.md#package-updates) for
candidate `--candidate <nightly> --run <id>`, positive `--pkgrel`, exact input checks
and the three-day candidate receipt window. Render needs only the existing
read-only GitHub login, never AUR credentials. Each output leaf must be new.
`preparation.json` is written last, with deterministic output hashes and
`native: null`. The offline step validates it and the PKGBUILD digest for
consistency, generates identical metadata twice, checks its version/revision/deb
URL/hash and candidate ordering, then records native completion. Missing native
tools leave it incomplete without writing `.SRCINFO`. makepkg sources the local
PKGBUILD as usual; the digest comparison is not a security boundary.

Its output contract is:

| Literal token          | Required value                                                           |
| ---------------------- | ------------------------------------------------------------------------ |
| `@PREPARATION_NOTICE@` | `Verified stable release` or `CANDIDATE TEST ONLY. NEVER PUBLISH.`       |
| `@PKGVER@`             | Stable upstream version; candidate `0.0.18alphaYYYYMMDD.RUN`             |
| `@PKGREL@`             | Positive Arch package revision, initially `1`                            |
| `@UPSTREAM_VERSION@`   | Exact upstream version, including the nightly suffix for candidate tests |
| `@SOURCE_COMMIT@`      | Full verified 40-character release source commit                         |
| `@DEB_SHA256@`         | Verified deb SHA-256 from the matching official `SHA256SUMS.txt`         |
| `@LICENSE_SHA256@`     | SHA-256 of `LICENSE` fetched from that exact source commit               |

Render by literal replacement after validation, never shell evaluation of input. Reject
unexpanded/unknown tokens. URLs are constructed by the template from the version and commit;
do not accept arbitrary asset hosts, moving tags such as `latest`, or arbitrary shell text.
The deb asset uses the upstream `linux-amd64.deb` name, while Arch's architecture is `x86_64`.
The pinned builder replaces `-` with `~` only in the embedded Debian control version; release
tags, asset filenames and download URLs keep the upstream hyphens.
`package()` checks the embedded Debian version and architecture before copying payload files,
including when `makepkg --nocheck` skips `check()`.
`mrstreamer-LICENSE` is a download alias so it cannot collide with this recipe's 0BSD `LICENSE`.
The packaged application's license remains GPL-3.0-only; the bundled components keep their notices.

The shared renderer must refuse production input before marker-aware **0.0.18**, all nightlies,
untested main, mismatched tag/version/channel/commit, missing assets or source archives,
checksum mismatch and wrong-origin or unversioned URLs. Verify the release checksum file and
downloaded bytes; an API digest alone is not release acceptance. The inspected Linux deb has
no embedded signature and the release exposes no detached Linux signature. Do not claim a
signature check where only HTTPS and SHA-256 were available.

Candidate-test input requires a successful published `0.0.18-nightly.YYYYMMDD.RUN` prerelease
run, verified release assets and checksums, and the nightly tag's exact source commit, which
must contain the managed-update implementation. The version string alone does not prove marker awareness.
Unpublished dry-run workflow artifacts cannot use this template's canonical release URLs.
Render the candidate before running Arch installed-package acceptance on that render; full
Arch acceptance is not a prerequisite for building its input. Use a separate ignored output
directory, the explicit candidate notice, no credentials and no publishing path.
Keep the upstream version unchanged in its download URL; only Arch `pkgver` changes to
`0.0.18alphaYYYYMMDD.RUN`. Native `vercmp` must show candidate < stable and increasing candidate
runs in order. Never use the usual underscore conversion without checking its ordering.

No actual marker-aware candidate was available for this recipe slice. The local 0.0.17
**payload inspection** render has a different package name, no `provides`/`conflicts` and no
managed marker. It is neither a production render nor a candidate-test render, and must never
be published or used to claim managed behavior. A separate historical nightly 394 recipe
inspection exercises `package()`, including the marker and `provides`/`conflicts`, under a
different non-publishable package name. Those old bytes cannot prove managed runtime behavior
and were not launched. See [payload audit](payload-audit.md).

## Native layout and updater contract

Install the payload at `/opt/mrstreamer`. A 21 October 2026 trace showed Chromium's SUID
sandbox fallback splitting the original helper path at its space when user namespaces were
unavailable. The direct deb keeps `/opt/Mr. Streamer`. Resource-relative paths, executable name,
ASAR bytes and profile identity stay unchanged. `/usr/bin/mrstreamer` is a package-owned symlink
to the bundled executable. The upstream desktop entry is retained except for Exec, which becomes
`Exec=/opt/mrstreamer/mrstreamer %U`; its original single Exec line is checked before rewriting.
The WM class, icon and changelog are retained. Arch's existing ALPM hooks refresh the desktop
and hicolor caches; there are no Debian alternatives, `.install` scripts or custom cache hooks.
No MIME association is invented.

The package removes exactly three upstream Debian resource files: `package-type`,
`app-update.yml` and `apparmor-profile`. It does not execute `postinst`/`postrm` or install/load
the Ubuntu `flags=(unconfined)` AppArmor policy. Other documentation and all bundled licenses,
Electron, Chromium libraries, FFmpeg and ffprobe stay intact. `!strip` and `!debug` preserve
the tested executable bytes. No dependency on system Electron or system FFmpeg is allowed.

`package()` records the upstream `chrome-sandbox` as root:root mode **4755** through fakeroot
and pacman's archive, following [Arch Electron packaging](https://gitlab.archlinux.org/archlinux/packaging/packages/electron44/-/blob/main/PKGBUILD).
Its containing directories are root-owned 0755. No runtime chmod/probe, `--no-sandbox`, AppArmor
exception or host sysctl change is added. Review future upstream sandbox changes before release.
The container validates the stored mode and ownership, not operation of a desktop sandbox.

The package adds `/opt/mrstreamer/resources/mrstreamer-installation.json` mode 0644:

```json
{ "schema": 1, "updates": "pacman" }
```

The authoritative filename/schema are `INSTALLATION_MARKER` and `PACMAN_INSTALLATION` in
`packages/contracts/src/updates.ts`. Keep this recipe aligned with that public contract.
Packaged Linux resolves it before Analytics and updater composition. A genuinely absent marker
means direct updates; a present damaged/unreadable marker fails startup. The original executable
name and `resources/app.asar` must give Electron `app.isPackaged === true`. Marker presence alone
does not prove that identity or pacman mode. A development launch and old 0.0.17 cannot prove it.
The Arch copy must report pacman ownership, inert update IPC, no direct-update timer/feed/writes,
and Analytics update channel `none` in an actual installed marker-aware run.

The unchanged profile is `${XDG_CONFIG_HOME:-$HOME/.config}/Mr. Streamer`, including its
`downloads/` subtree, database, preferences and retained subtitles. Desktop keyring secrets
belong to the user's existing keyring. Neither the recipe nor package removal touches these.
Require a working desktop Secret Service or supported desktop keyring for credential acceptance;
do not bypass encryption with a basic password store. Quit the app before replacing files.

## Build and metadata generation

In a disposable, fully updated Arch environment with `base-devel` and the declared dependencies,
prepare the checkout and toolchain as above. Run the following as an unprivileged builder in
the **rendered output directory**, replacing `/path/to/checkout` with the builder's checkout
path. Review every PKGBUILD before sourcing it. Do not run this against the unrendered template.

```sh
bash -n PKGBUILD
shellcheck -s bash -e SC2034,SC2154 PKGBUILD
makepkg --verifysource
makepkg --cleanbuild --noconfirm --log
node /path/to/checkout/apps/desktop/scripts/package-updates.ts srcinfo --dir "$PWD"
namcap PKGBUILD
namcap ./*.pkg.tar.zst
```

`.SRCINFO` is generated by native `makepkg` from each exact rendered PKGBUILD, never a second
template or hand-maintained file. Production output contains `PKGBUILD`, generated `.SRCINFO`
and this recipe's 0BSD `LICENSE`; binaries, build logs and candidate metadata stay out of AUR Git.
Until real verified stable inputs exist, there is intentionally no production `PKGBUILD` or
`.SRCINFO` checked in. The shared renderer must retain both output files and their digests in
its preparation receipt and prove regeneration leaves `.SRCINFO` unchanged.

Inspect namcap output even when its process exits zero. Expected reviewed findings for this
unchanged upstream payload are ELF under `/opt` (permitted for self-contained applications by
Arch guidelines), an unstripped bundled Vulkan library, the deliberate SUID helper, obsolete
glibc `libdl`/`libpthread` link entries, and non-ELF uses of `libsecret`/`xdg-utils`. Missing
libraries, unexpected permissions or changed binaries need investigation, not suppression.

## Installed acceptance and retained state

Record commands, cwd, original exit codes, source commit, artifact/checksum hashes, package
hash, file inventory/modes, environment identity and screenshots in ignored evidence. Never
record provider credentials or real stream URLs. Do not equate container tests with Arch GUI,
keyring, audio or GPU proof.

1. Install the exact candidate with `pacman -U` in an owned Arch GUI VM/machine. Check `pacman -Qkk`,
   owned launcher/desktop/icons/licenses, bundled executable/tool hashes and sandbox owner/mode.
   Launch through the installed desktop entry and directly through `/usr/bin/mrstreamer`.
   Check the actual menu and dock icon; the retained upstream 1024px icon may not be found by
   the desktop theme. If it fails, fix the upstream icon set rather than resizing in this recipe.
2. Prove packaged identity and pacman update mode through actual app UI/status/diagnostics. Check
   stale direct-update state is unchanged, updater IPC is inert, and no direct update requests or
   package writes occur beyond the normal check delay. Do not use an environment override as proof.
3. Use the repo's fake provider/TMDB controls for Live TV/VOD, track/subtitle selection and offline
   playback. Prove keyring credential storage across restart. Separately run the actual private
   provider smoke using ignored inputs. Capture audible output/GPU evidence only where observed.
4. Upgrade between two exact tested marker-aware candidates, retaining settings, favourites,
   watchlist, progress, completed downloads and saved subtitles. Also verify direct stable to
   AUR migration on the same profile without losing keyring access. Old .17 can seed state but
   cannot provide package-owned updater acceptance.
5. Remove with `pacman -R mrstreamer-bin`; check only owned files disappear, the profile/downloads
   and keyring remain, and reinstall reuses them. Check offline playback and retained state again.

The present host has Docker and can run Arch build tooling. It has no isolated Arch GUI session,
GPU/audio device or desktop keyring. Its container shares an Ubuntu kernel. Installed final
candidate launcher/keyring/playback, retained-state migration/upgrade/removal/reinstall and
private-provider smoke remain pending. Baseline container ownership checks cover filesystem
mechanics only, using dummy retained files with no real app state.

## Manual release, retry and recovery

Wout owns release selection, review and any later AUR credentials. No credentials or automation
are configured here. Before first publication, read the current [Arch package guidelines](https://wiki.archlinux.org/title/Arch_package_guidelines)
and [AUR submission guidelines](https://wiki.archlinux.org/title/AUR_submission_guidelines), then
recheck the official package database and AUR exact names `mrstreamer-bin`, `mrstreamer`,
`mr-streamer` and `mr-streamer-bin`. Read-only searches do not reserve a name; do not overwrite
an existing maintainer's package. `conflicts` covers the alternate names; no `replaces` is used.

After approved stable publication, regenerate from its exact stable tag/assets/checksums and
repeat clean makepkg/namcap plus installed version/resources/managed-update/retained-state proof
on those new stable bytes. Native nightly acceptance does not cover a rebuilt stable artifact.
Request separate authorization for external AUR creation/publication, credentials, or automation
activation. Only then use a dedicated maintainer-controlled AUR SSH key/repository, review its
existing history, commit the verified recipe/source metadata/license on AUR's `master` branch
and publish. Do not upload binary packages or a generated filelist. Verify the public entry,
source checksum and clean user install before website route activation or public user docs.

On a build/check/publication failure, keep this route inactive and the release gate open. Fix and
retry the same pinned inputs; do not rebuild or replace already published upstream release files.
An AUR problem does not block direct downloads or the separate Homebrew route. Automation stays
disabled until separately approved; the same manual path remains the recovery path.

For recipe-only fixes to the same upstream release, increment `pkgrel`; a new upstream version
resets it to `1`. Never move an old version backwards or introduce `epoch` to hide a bad update.
For an emergency local rollback, quit the app, preserve the profile and keyring, review schema
compatibility, then install a previously verified cached **marker-aware** package with `pacman -U`.
A 0.0.17 rollback restores direct updater behavior and requires its own explicit decision. Do not
delete release/source archives or user data. Do not use `--overwrite`, `-Rdd` or `-Rns` as a shortcut
for file conflicts; identify the owning package and plan the migration first.
