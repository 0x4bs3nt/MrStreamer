# Linux payload audit

Inspected 20 October 2026. This is a **0.0.17 layout/dependency baseline**, not a marker-aware
candidate or package-managed runtime receipt. Repeat this audit against the exact tested .18
candidate and final stable bytes before acceptance. The deb layout is suitable, so AppImage
extraction was not needed.

- Official [release v0.0.17](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.17),
  source commit `53b8e5aadfe56666f4faa042d22429da53476eb9`.
- Artifact: `Mr-Streamer-0.0.17-linux-amd64.deb`, 107003164 bytes,
  SHA-256 `0acbbdd685b6b35e2fcc9208913c67d81a6c54a3a9e78c285b75e18fc712ad07`.
- `SHA256SUMS.txt` SHA-256: `06984bec3fc5ce613554093e7aba228fb9d4ad5f7abcef57a203924e43de8783`.
  The downloaded deb matches both this file and GitHub's asset digest. No detached signature or
  embedded deb signature was available. The archive has only `debian-binary`, `control.tar.xz`
  and `data.tar.xz`; no Debian script was executed.
- App license at that exact commit: SHA-256
  `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`.

## Debian effects and Arch decisions

`postinst` creates `/usr/bin/mrstreamer` through alternatives or a symlink, sets chrome-sandbox
0755 or 4755 after a host user-namespace probe, refreshes MIME/desktop caches, and may copy/load
an Ubuntu AppArmor profile. `postrm` removes the alternative/link and unloads/deletes that policy.
The profile is ABI 4.0, attaches to `/opt/Mr. Streamer/mrstreamer`, and grants user namespaces
under `flags=(unconfined)`. None of those scripts/policy effects run in the Arch package.

The payload has no launcher symlink; Arch owns it in the archive. Its desktop entry invokes
`"/opt/Mr. Streamer/mrstreamer" %U`, icon `mrstreamer`, WM class `mrstreamer`, category AudioVideo,
and no MIME types. Preserve it and the hicolor 1024px icon. Existing Arch ALPM hooks update caches.

Upstream `resources/package-type` contains `deb`; `resources/app-update.yml` points at the official
GitHub repo with updater cache `mrstreamer-updater`. Both are removed in the Arch copy along with
the unused Ubuntu AppArmor resource. The separate schema-1 pacman marker is the sole new update
ownership input. No `PacmanUpdater` or system Electron is introduced.

All eight ELF files are x86-64. The main executable has `$ORIGIN` RPATH; bundled libraries remain
beside it. `libffmpeg.so` has `$ORIGIN` RUNPATH. Both bundled CLI tools link only libc and libm;
x264 and dav1d are built into those tools. Their README records FFmpeg 9.0.2, the pinned x264
commit, dav1d 1.5.3, complete configure arguments and the Ubuntu build toolchain. Keeping their
bytes and resource locations preserves that tested decoder/runtime combination.

Arch's current [electron44 recipe](https://gitlab.archlinux.org/archlinux/packaging/packages/electron44/-/blob/main/PKGBUILD)
sets `u+s` on its bundled sandbox helper. This recipe uses `install -m4755` inside fakeroot instead
of running Debian's host-dependent namespace probe. No sandbox-disabling flags, host policy or
system service changes were used. Native sandbox operation is still unverified.

## Direct ELF dependencies

The mapping below comes from `readelf -hd`, `ldd` and `pacman -Qqo` inside an updated disposable
Arch environment on 20 October 2026. Include direct dependencies even when gtk3 currently brings
them transitively. The earlier attempted Debian-like `libxscrnsaver` package name did not exist;
no such dependency was retained. Neither libXss nor libXtst is a direct link in this payload.

| SONAME                   | Arch owner      |
| ------------------------ | --------------- |
| `ld-linux-x86-64.so.2`   | `glibc`         |
| `libX11.so.6`            | `libx11`        |
| `libXcomposite.so.1`     | `libxcomposite` |
| `libXdamage.so.1`        | `libxdamage`    |
| `libXext.so.6`           | `libxext`       |
| `libXfixes.so.3`         | `libxfixes`     |
| `libXrandr.so.2`         | `libxrandr`     |
| `libasound.so.2`         | `alsa-lib`      |
| `libatk-1.0.so.0`        | `at-spi2-core`  |
| `libatk-bridge-2.0.so.0` | `at-spi2-core`  |
| `libatspi.so.0`          | `at-spi2-core`  |
| `libc.so.6`              | `glibc`         |
| `libcairo.so.2`          | `cairo`         |
| `libcups.so.2`           | `libcups`       |
| `libdbus-1.so.3`         | `dbus`          |
| `libdl.so.2`             | `glibc`         |
| `libexpat.so.1`          | `expat`         |
| `libffmpeg.so`           | `bundled`       |
| `libgbm.so.1`            | `mesa`          |
| `libgcc_s.so.1`          | `libgcc`        |
| `libgio-2.0.so.0`        | `glib2`         |
| `libglib-2.0.so.0`       | `glib2`         |
| `libgobject-2.0.so.0`    | `glib2`         |
| `libgtk-3.so.0`          | `gtk3`          |
| `libm.so.6`              | `glibc`         |
| `libnspr4.so`            | `nspr`          |
| `libnss3.so`             | `nss`           |
| `libnssutil3.so`         | `nss`           |
| `libpango-1.0.so.0`      | `pango`         |
| `libpthread.so.0`        | `glibc`         |
| `libsmime3.so`           | `nss`           |
| `libudev.so.1`           | `systemd-libs`  |
| `libxcb.so.1`            | `libxcb`        |
| `libxkbcommon.so.0`      | `libxkbcommon`  |

`libsecret-1.so.0`, libnotify and libpulse also appear among Electron's runtime-loaded library
names. `libsecret` supports credential encryption and is required; `xdg-utils` supplies external
URL handling. Notifications and PulseAudio client integration are optional. Secret Service
availability remains an installed desktop gate, not something libsecret alone proves.
`hicolor-icon-theme` is explicit because the package installs into that hierarchy. No Debian
recommends list was copied and no system Electron/FFmpeg package is used.

## Complete upstream file inventory

These are all 33 regular files in the inspected data archive. Modes are upstream modes; the
Arch sandbox mode changes from 0755 to 4755 without changing its bytes. The three removed Debian
metadata files remain listed here as evidence of the original payload. All other upstream file
bytes must survive packaging. Directories are 0755; the original payload has no symlinks.

| Path                                                    | Mode  | SHA-256                                                            |
| ------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| `opt/Mr. Streamer/LICENSE.electron.txt`                 | `644` | `5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d` |
| `opt/Mr. Streamer/LICENSES.chromium.html`               | `644` | `a62dabd1c6ef1327365b2a3fdffb806222684a746dcb8f4afd1c1f690eba5535` |
| `opt/Mr. Streamer/chrome-sandbox`                       | `755` | `a4f6dfd7325ddd55f94ddc0c487d22726d40ef099ded6475d5dffe236e277896` |
| `opt/Mr. Streamer/chrome_100_percent.pak`               | `644` | `891176da5eee33b54352fdb1407a8e09a2bd48c7eb2077311e75787de33a095e` |
| `opt/Mr. Streamer/chrome_200_percent.pak`               | `644` | `b3ce9953a50959e9c1a018d6512742f48cee0dbf53644ea952909418bd7c2b3e` |
| `opt/Mr. Streamer/chrome_crashpad_handler`              | `755` | `089a4bad7bc3342c49f29741a1cd8c076f312ffb9e6be5da027b2296c301dfa0` |
| `opt/Mr. Streamer/icudtl.dat`                           | `644` | `9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe` |
| `opt/Mr. Streamer/libffmpeg.so`                         | `755` | `3544b3c9a8ee8d97ff7f76fe421ce601e484a5cf8695ebba99ae6a4fb54ef974` |
| `opt/Mr. Streamer/libvk_swiftshader.so`                 | `755` | `b591072c9127b8569640e104fcd4f374c052d5420b2216bd0697dabf026c2253` |
| `opt/Mr. Streamer/libvulkan.so.1`                       | `755` | `9b9c42fe2df5429dda9ca1298e3986d08b81fabcabe965691387082ea1a667f9` |
| `opt/Mr. Streamer/locales/de.pak`                       | `644` | `e9090345d349cf456f8b62ec46ef4fc086f61e19b423e726a5883780150c669c` |
| `opt/Mr. Streamer/locales/en-US.pak`                    | `644` | `1457718914324001ada1848b1fa68b823ca8f34ffe8a60fa1ae76954697ee9ed` |
| `opt/Mr. Streamer/locales/es.pak`                       | `644` | `cabdad81807f948ccd99cb55e97ebe9ee8e2f55914a56d73fdbc363c866f4e3b` |
| `opt/Mr. Streamer/locales/fr.pak`                       | `644` | `555ddd3addddcb1378db58f03f77f8baeba89d8f906b6f7406b3c20090a8b97e` |
| `opt/Mr. Streamer/locales/nl.pak`                       | `644` | `65335fdb72f323b82e74c7b9ed849fc752213786041613bab0f6d90466e26981` |
| `opt/Mr. Streamer/mrstreamer`                           | `755` | `ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97` |
| `opt/Mr. Streamer/resources/app-update.yml`             | `644` | `bb94f188f44849b782de7ef40655c30a9464ab96f4b58f9fdd47bbca56378d60` |
| `opt/Mr. Streamer/resources/app.asar`                   | `644` | `655e7dcb04a99263b79973a4417c00abac24473d0bba867c2796c5d30480052e` |
| `opt/Mr. Streamer/resources/apparmor-profile`           | `644` | `80c878351075c2b9fa4fccfca07de5289c9ac53a91b5e29632cf668b1439f0b6` |
| `opt/Mr. Streamer/resources/ffmpeg/LICENSE-FFmpeg.txt`  | `644` | `8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643` |
| `opt/Mr. Streamer/resources/ffmpeg/LICENSE-dav1d.txt`   | `644` | `dd92c3c2247c5651606fc23a5e2d6a1ebc5ace9a3e49cbde0e12f05ad1cb1ee5` |
| `opt/Mr. Streamer/resources/ffmpeg/LICENSE-x264.txt`    | `644` | `32b1062f7da84967e7019d01ab805935caa7ab7321a7ced0e30ebe75e5df1670` |
| `opt/Mr. Streamer/resources/ffmpeg/README.txt`          | `644` | `d4d1c94a1edb7cce03d08f2a48323e87171a15330252490cbd37f2a16cabc96c` |
| `opt/Mr. Streamer/resources/ffmpeg/ffmpeg`              | `755` | `93dd921e6c3135944939983423a8322429c1e0c0d08972a2ac1d45444aae0d72` |
| `opt/Mr. Streamer/resources/ffmpeg/ffprobe`             | `755` | `eb24221366063376ec98aec5fe76fdae1b8e0cc29c6a2040efd7de6b17d52e72` |
| `opt/Mr. Streamer/resources/package-type`               | `644` | `9cfa1468c93fc18652e34a000f0c6614b0fa18f6f4887477ad9b0d36ca6a7eaa` |
| `opt/Mr. Streamer/resources.pak`                        | `644` | `36c69ef429b0674fa0154ee2406ee16789881ebdd2aad365acb47d805fa6dee1` |
| `opt/Mr. Streamer/snapshot_blob.bin`                    | `644` | `6a80dc5091db83ef5d8ff6d935b52f87d876ce9d1472f691cc1ff5dba6e12b62` |
| `opt/Mr. Streamer/v8_context_snapshot.bin`              | `644` | `ffd0c848332e16ddf0f0f240ee6b8abd722329098f2b7b10e249579fc837c186` |
| `opt/Mr. Streamer/vk_swiftshader_icd.json`              | `644` | `c9eef28b6b984fec220ef0abfecc40b502d46946706e47bfe97707027cb818bd` |
| `usr/share/applications/mrstreamer.desktop`             | `644` | `d112c3098d17a343dd9e41e7d3aeae74b6172b2bdbdb26b0e1ab5943a043114b` |
| `usr/share/doc/mrstreamer/changelog.gz`                 | `644` | `e90ac068401ab0bd4303d0df35f644d0e1340ea6435e239d6a6e1d878ace4a1d` |
| `usr/share/icons/hicolor/1024x1024/apps/mrstreamer.png` | `644` | `6e935b9f36f49bb1e5db41ba979a518ff6c1e74f5742f0247b2c7d89f0cc67a9` |

## Build evidence and limits

The owned Arch container used official image digest
`sha256:0ccc8b2e55c0c26a6e501e892cc6b1cdea7cfdf77e432941320148b4dabd2bff`, then a full `pacman -Syu`.
Native makepkg 7.1.0, namcap 3.6.0, Bash syntax, ShellCheck, desktop-file validation and `.SRCINFO`
regeneration ran against the hand-pinned payload-inspection render. It deliberately renames the
package to `mrstreamer-payload-inspection`, removes provides/conflicts and omits the managed marker.

A follow-up recipe-execution probe uses complete official stable .17 and nightly 394 debs,
both pinned to source `53b8e5aadfe56666f4faa042d22429da53476eb9`. The nightly artifact is
107003748 bytes, SHA-256 `c124c69f87f2ff0c164d663de34b394301ea96db857ac8d54c6d247b5b3f15db`,
matching its canonical `SHA256SUMS.txt` and API digest. Its checksum file SHA-256 is
`06018a6a4a40d2c5b685ab11c2d414b697288f221c32fe4773655e747ca08f4b`.
Actual control versions are `0.0.17` and `0.0.17~nightly.20261020.394`; the expected Debian
version uses the pinned builder's hyphen-to-tilde normalization. Upstream release URLs,
asset filenames and Arch's separate alpha ordering remain unchanged.

Both renders use an inspection-only package name and an explicit NEVER PUBLISH
notice. They retain the template's actual `package()`, marker and provides/conflicts branches.
Native makepkg source checks, clean builds, `.SRCINFO` regeneration, Bash syntax, ShellCheck
and namcap recipe lint pass. Archive inspection verifies every retained upstream file hash,
root ownership, directory modes, sandbox 4755, launcher/license links and package metadata.
The marker has exact bytes `{"schema":1,"updates":"pacman"}` followed by a newline, mode 0644
and root ownership. Native mismatched-version and wrong-architecture checks abort before
payload copying, including with `--nocheck`. Validation and receipt details are recorded on the
[AUR card](https://github.com/orgs/Mr-Streamer-OSS/projects/1?pane=issue&itemId=262338894).
These historical inspection packages were neither installed nor
launched. Their marker proves packaging execution only; actual marker-aware .18 archive,
installed managed-runtime and full native GUI acceptance remain open.

Namcap's process exited zero but reported an `/opt` ELF error, unstripped Vulkan, the intentional
SUID helper, unused upstream libdl/libpthread links, and possibly-unused libsecret/xdg-utils.
The `/opt` finding is its questionable-directory rule, while Arch's package guidelines explicitly
allow `/opt/pkg` for large self-contained applications. Preserving the official layout avoids
unnecessary relocation. The remaining findings describe deliberate preservation or runtime-loaded
libraries; none was hidden. The hicolor implicit-dependency warning was fixed by declaring it.

The initial container install check failed because the official Docker image's `NoExtract`
configuration omitted documentation. That image-minimization setting was removed only inside the
owned disposable container before repeating package ownership checks. Raw failure logs retain
original exit codes. The corrected install/remove/reinstall check passed: `pacman -Qkk` reported
56 files and zero altered files, all 30 retained upstream files had identical hashes and root
ownership, the sandbox had mode 4755, and the launcher link was correct. Removal deleted owned
files and retained two dummy profile/download files; reinstall preserved those same bytes. No
application was launched and these dummy files do not prove preservation of actual app state.
The container has no isolated Arch display, GPU/audio devices or desktop
keyring and shares the Ubuntu host kernel. It cannot establish app.isPackaged, managed updates,
credential encryption, GUI playback or a real retained-state migration. Follow the runbook's
candidate/stable installed gates before publication.
