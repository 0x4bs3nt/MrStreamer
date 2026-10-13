# Licences and sources

> For maintainers. What every installer, release and Store submission must carry so Mr. Streamer and what it bundles can be distributed under their licences. [Development](../contributing/development.md#third-party-notices) describes how the notices are built.

Mr. Streamer is GPL-3.0-only. The bundled ffmpeg is GPL-2.0-or-later, because it's built with `--enable-gpl --enable-libx264`. Electron brings Chromium's FFmpeg under LGPL-2.1-or-later and two Microsoft files that aren't open source, and the Windows setup program brings NSIS and its plug-ins. Check this page before changing what the installers ship, how releases are published or withdrawn, or the Store listing, and before upgrading Electron or electron-builder.

This page records what the project ships and what it knows about the terms. It isn't legal advice, and [open questions](#open-questions) lists what it leaves undecided.

## In the app

Settings > About shows:

- The app's own licence: its copyright, the lack of warranty, where the source is, then the repository's `LICENSE`. GPL-3.0 sections 4 and 5 ask for all of these in an app with an interactive interface. The entry is under `components` in `apps/desktop/licences.config.json`.
- Every component the installers ship, with its licence. The build fails when one has none (see [development](../contributing/development.md#third-party-notices)). That includes the MinGW-w64 runtime and winpthreads, which the Windows ffmpeg links in statically.
- What comes with Electron and with the Windows setup program: [Chromium's FFmpeg](#chromiums-ffmpeg), [Microsoft's two Direct3D files](#microsofts-direct3d-files), and [NSIS with its four plug-ins](#windows-setup-program). They show on every platform, and each text says which builds contain the files.
- Chromium's credits, which hold Node.js's licence and those of the LGPL parts inside Chromium, and Electron's MIT licence. Every installer keeps `LICENSES.chromium.html` and `LICENSE.electron.txt`: beside the executable on Linux and Windows, in the app's Resources on macOS.
- Source links: the commit the build comes from (`__BUILD_COMMIT__`), Chromium's source at its exact tag, Node.js's at its tag, and the [archives on the build's own release](#sources-on-every-release).
- The privacy policy at `https://mrstreamer.app/privacy`, which the website builds from `docs/privacy.md` on `main`. Keep that file where it is.

## Sources on every release

Every release, nightlies included, attaches these archives. `sources` in `apps/desktop/licences.config.json` lists them, and a notice in About links each on the release its build belongs to. Together they are about 54 MB.

| File                              | Holds                                                                   | Pinned by                     |
| --------------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| `ffmpeg-<version>.tar.xz`         | FFmpeg, as `apps/desktop/scripts/build-ffmpeg.sh` builds it             | SHA-256, in `build-ffmpeg.sh` |
| `x264-<commit>.tar.gz`            | x264, linked into that ffmpeg                                           | commit, in `build-ffmpeg.sh`  |
| `chromium-ffmpeg-<commit>.tar.gz` | [Chromium's FFmpeg](#chromiums-ffmpeg) at the revision Chromium pins    | commit, under `reviewed`      |
| `electron-<version>.tar.gz`       | Electron at its release tag: its DEPS file, patches and build arguments | commit, under `reviewed`      |
| `stdutils-1.14.zip`               | StdUtils as its author published it, source included                    | SHA-256, under `sources`      |
| `nsis7z-19.00.7z`                 | Nsis7z as published, with the plug-in's own source                      | SHA-256, under `sources`      |
| `lzma-sdk-19.00.7z`               | LZMA SDK 19.00, the rest of what Nsis7z compiles                        | SHA-256, under `sources`      |
| `spiderbanner-2016-06-25.zip`     | SpiderBanner as published, source included                              | SHA-256, under `sources`      |

- The release workflow's **Prepare sources** job runs `apps/desktop/scripts/release-sources.ts`. A download must match its SHA-256. A repository is fetched at its commit and archived with `git archive`, which writes the commit into the file: `zcat <file> | git get-tar-commit-id` prints it. The tarballs git hosts generate aren't the same bytes each time, so no checksum pins those.
- The job then reads the notices built into the app. Every file they link on the release, in a source link or in a text, must be one it prepared, and it must have prepared nothing else. `pnpm build` holds the same names against `sources` on every pull request.
- [Dry runs](releasing.md#dry-runs) run the job too, so a source that moved or changed shows before a release needs it. Publishing checks that every archive the job named is among the release's files.
- To prepare them on your own machine, with git and curl: `pnpm build`, then `node apps/desktop/scripts/release-sources.ts <folder>`.
- Each installer's `resources/ffmpeg/README.txt` names FFmpeg's and x264's versions, both configure lines and the toolchain that built them. Windows release builds use MSYS2 UCRT64 and record the compiler, C runtime and installed build-tool and UCRT64 package versions. MinGW-w64 support libraries and winpthreads link statically; Windows provides UCRT.
- The release workflow caches the ffmpeg build by the hash of `build-ffmpeg.sh`. The Windows key also names UCRT64 and hashes the toolchain action, `apps/desktop/scripts/windows-ffmpeg-toolchain/action.yml`, which holds the MSYS2 setup, environment and package list. It has no fallback to MINGW64 caches. The README stays with the cached binaries, and the Windows job checks and prints its UCRT64 provenance on both cold and warm runs.
- **Never delete a release.** It holds the only copy of the sources owed to everyone who installed it: GPL-2.0 asks for three years, GPL-3.0 section 6(d) "for as long as needed". To stop offering a bad release, take its update files away instead, as [releasing](releasing.md#recovery) describes.

## Chromium's FFmpeg

Electron plays audio and video in its window with Chromium's own build of FFmpeg, under LGPL-2.1-or-later. It is a separate library file in every installer: `ffmpeg.dll`, `libffmpeg.so` or `libffmpeg.dylib`.

- It isn't in `chromium/src`, which About's Chromium notice links. Chromium's DEPS file pins it as a repository of its own, `chromium/third_party/ffmpeg`, at one revision.
- Electron builds it with its own arguments: `ffmpeg_branding = "Chrome"` and `proprietary_codecs = true` in `build/args/all.gn`, `is_component_ffmpeg = true` in `build/args/release.gn`. It applies one patch, `patches/ffmpeg/link_with_loader_path.patch`, which changes the library's install name on macOS.
- The **FFmpeg in Chromium** notice names the revision, links that tree and Electron's source on the release, and gives the checkout and build commands for Electron's tag.
- The two archives aren't a copy of Chromium. A rebuild also needs Chromium itself, its other dependencies and its build tools, which Electron's `gclient` checkout fetches from Google's and GitHub's servers. The notice says so, and [open questions](#open-questions) has what that leaves.

## Windows setup program

electron-builder makes the setup program with NSIS. With `toolsets.nsis` unset in `electron-builder.yml`, it uses its `nsis-3.0.4.1` and `nsis-resources-3.4.1` bundles, which it pins by checksum. The NSIS compiler in the first reports itself as `v27-Nov-2019.cvs`.

| File               | In the setup | In the uninstaller | Terms                                                                                  | Source on the release                  |
| ------------------ | ------------ | ------------------ | -------------------------------------------------------------------------------------- | -------------------------------------- |
| NSIS's own code    | yes          | yes                | zlib/libpng                                                                            | none owed                              |
| `System.dll`       | yes          | yes                | zlib/libpng, part of NSIS                                                              | none owed                              |
| `nsExec.dll`       | yes          | yes                | zlib/libpng, part of NSIS                                                              | none owed                              |
| `StdUtils.dll`     | yes          | yes                | LGPL-2.1-or-later, with its author's clarification about installers                    | `stdutils-1.14.zip`                    |
| `WinShell.dll`     | yes          | yes                | "Freeware" on its author's page, with no licence text                                  | none published                         |
| `nsis7z.dll`       | yes          | no                 | Its own files treated as LGPL-2.1-or-later. The rest is LZMA SDK, in the public domain | `nsis7z-19.00.7z`, `lzma-sdk-19.00.7z` |
| `SpiderBanner.dll` | yes          | no                 | None stated                                                                            | `spiderbanner-2016-06-25.zip`          |

- The uninstaller stays in the app's folder, so four plug-ins are installed with the app. The other two run only while the setup does.
- The four plug-ins from other authors are the same bytes as the ones in the archives the release attaches. The setup uses NSIS's zlib compression, not its bzip2 or LZMA modules, which have licences of their own.
- About has one notice for NSIS and one for each of the four plug-ins. The Microsoft Store package and the Mac and Linux builds contain none of these files.
- `installer` in `licences.config.json` lists the plug-ins of the setup and of the uninstaller by SHA-256. The Windows packaging job runs `apps/desktop/scripts/installer-plugins.ts` on the setup it built, in dry runs too. It fails when either carries a file that isn't listed, a listed file with other contents, or lacks one. That matters because an option in `electron-builder.yml`, an NSIS script of our own or another toolset can change the plug-ins while every version stays the same.
- To check a setup by hand, with 7-Zip's `7z` on the PATH: `node apps/desktop/scripts/installer-plugins.ts <setup>.exe`.

## Microsoft's Direct3D files

Electron's Windows build carries two files from Microsoft beside its executable, so the setup program and the Store package do too:

- `d3dcompiler_47.dll`, version 10.0.26100.7705, "Direct3D HLSL Compiler for Redistribution". ANGLE's build copies it from the Windows SDK's `Redist/D3D` folder.
- `dxil.dll`, version 1.8.2502.11. Dawn's build copies it from the Windows SDK's `bin` folder.

Both are Microsoft's and neither is open source. Chromium's credits page mentions neither, and Electron's MIT licence says nothing about them.

- Microsoft's [REDIST list](https://learn.microsoft.com/en-us/legal/windows-sdk/redist) names both under `Redist\D3D`, as files a holder of the [Windows SDK licence](https://learn.microsoft.com/en-us/legal/windows-sdk/license) may redistribute. The licence's conditions for such files include: unmodified, only for Windows, with their notices intact, and under terms that protect them at least as much. The list adds that these files go with "Classic Windows applications" and not with "Universal Windows apps".
- `dxcompiler.dll`, beside them, is another case. Its version resource says "Google Dawn Custom Build": it is built from the open-source DirectX Shader Compiler, whose licence Chromium's credits hold under DirectX-Shader-Compiler.
- The **Microsoft Direct3D compiler files** notice says whose the two files are, links Microsoft's terms and says what the project hasn't confirmed. Its licence is `LicenseRef-proprietary`, which the build accepts only through the exception written on that one component in `licences.config.json`.
- The project hasn't confirmed which Microsoft agreement applies to these files, or which one Electron's builders redistribute them under. [Open questions](#open-questions) has the rest.

## Upgrading Electron or electron-builder

`reviewed` in `licences.config.json` names the one version of each that the notices, `sources` and `installer` were checked for. Under any other version `pnpm build` fails, so an upgrade can't ship with stale notices. Go through the list, then set the new version.

Electron:

1. `ELECTRON_COMMIT`: the commit of the tag, from `git ls-remote https://github.com/electron/electron 'refs/tags/v<version>^{}'`.
2. `CHROMIUM_VERSION`: `chromium_version` in the `DEPS` file at that commit.
3. `CHROMIUM_FFMPEG_COMMIT`: `ffmpeg_revision` in Chromium's `DEPS` file at that version.
4. In Chromium's FFmpeg at that revision, `chromium/config/Chrome/*/*/config.h` must still say `FFMPEG_LICENSE "LGPL version 2.1 or later"` and `CONFIG_GPL 0`. In Electron's tree, read `patches/ffmpeg` and `build/args`. Update `apps/desktop/licences/chromium/FFmpeg.txt` when the patches, the arguments or the build commands in `docs/development/build-instructions-gn.md` changed.
5. `D3DCOMPILER_VERSION` and `DXIL_VERSION`: `7z l -slt <file>` on each DLL in Electron's Windows zip prints its version. Look for Microsoft files that are new or gone, and update the notice in `apps/desktop/licences/microsoft` to match.

electron-builder:

1. Build a setup, in a dry run or with `pnpm dist:win`, and run `installer-plugins.ts` on it. For each difference, find the plug-in in electron-builder's [bundle script](https://github.com/electron-userland/electron-builder-binaries/blob/master/packages/nsis/assets/nsis-windows.sh), which names its upstream archive and checksum, and read that archive's licence. Then update `installer`, the plug-in's notice under `components` and its archive under `sources`.
2. `NSIS_BUNDLE`: the NSIS bundle that version uses, from `toolsets/windows.js` in `app-builder-lib`.

Update the versions this page quotes. Then finish with `pnpm build`, `node apps/desktop/scripts/release-sources.ts <folder>` and a [dry run](releasing.md#dry-runs).

## Microsoft Store

- Only stable releases go to the Store, so every Store package has a release with its sources. The package carries the same notices as the direct download, and they link that release.
- The package isn't made with NSIS, so the notices for NSIS and its plug-ins describe files it doesn't contain, as each of them says. It does carry [Microsoft's two Direct3D files](#microsofts-direct3d-files).
- GPL-3.0 section 6(d) allows the sources on another server with clear directions next to the object code. About, the notices and the listing give them.
- The listing's **Additional license terms** say the app is free software under GPL-3.0-only, with links to `LICENSE` and to the releases. Without them, Microsoft's Standard Application License Terms apply, and they forbid reverse engineering and copies beyond what the app allows, which GPL-3.0 section 10 rules out.
- Free, with Partner Center's organizational licensing defaults, and nothing that encrypts or locks the package. The Store's signature limits none of the GPL's rights.

## Open questions

The notices and archives above settle none of these. Each is Wout's to decide, with an advisor where it turns on law.

- **WinShell's terms.** Its author publishes it as "Freeware", as a binary, with no licence text and no source. Nothing written says what redistribution it allows. electron-builder's templates call it in every setup and uninstaller. The choices are to accept that, to ask its author, or to replace it with NSIS scripts of our own; the [plug-in's page](https://nsis.sourceforge.io/WinShell_plug-in) shows a way without it.
- **SpiderBanner's terms.** Neither its archive nor its [page](https://nsis.sourceforge.io/SpiderBanner_plug-in) states a licence. The NSIS wiki's footer puts page content under zlib/libpng "unless otherwise noted". That line is the wiki's default for every page, and nothing shows its author meant it for the plug-in. The choices are the same three.
- **Microsoft's terms for the two DLLs.** Which Microsoft agreement Electron's builders hold, and what it passes on to an app built on Electron, isn't known here. The Windows SDK licence asks a distributor for more than a notice. It wants distributors and end users held to "terms that protect it at least as much as this agreement", and it has a clause on licences that require source code, which it calls Excluded Licenses. How that sits with shipping them beside a GPL-3.0 program is a legal question this page doesn't answer. The FSF's [FAQ on Windows runtime DLLs](https://www.gnu.org/licenses/gpl-faq.html#WindowsRuntimeAndGPL) is the nearest published view. It doesn't say whether it matters that Chromium's code loads the files and the app's own code doesn't.
- **The Store package and "Universal Windows apps".** Microsoft's list keeps the D3D files to "Classic Windows applications". The Store package is the desktop app in an MSIX, with `runFullTrust`. MSIX is a way of packaging, and a desktop app inside one isn't a Universal Windows app for that reason alone. Whether Microsoft's wording counts it as one is unconfirmed.
- **Leaving the two DLLs out.** Untested. The app uses no WebGPU, which is what `dxil.dll` serves, so that file might go. `d3dcompiler_47.dll` would stay. Nothing here removes either.
- **The rest of Chromium's source.** A release holds FFmpeg's tree and Electron's. Chromium's own tree stays on upstream servers the project doesn't control, with its other dependencies and its build tools. That includes the LGPL parts of Blink, which are linked into Electron's executable. A copy of everything is several GB for each Electron version, and GitHub limits a release file to 2 GiB. Whether exact directions to upstream are enough for those parts is open.
- **Earlier releases.** 0.0.6 and every release from before this page's archives attach only the FFmpeg and x264 sources, and their About has none of the notices above. Adding the archives to those releases changes published files, which needs Wout's go-ahead. Their notices stay as they shipped.

## TMDB and JustWatch

- About shows TMDB's logo, less prominent than the app's own marks, and "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB" ([TMDB's API terms](https://www.themoviedb.org/api-terms-of-use), section 3).
- Nothing from TMDB older than six months is used or kept (section 1.C, `apps/desktop/src/main/ondemand/metadata.ts`).
- Where titles stream comes from JustWatch, credited in About and the Services tab.
- The built-in key belongs to a TMDB account registered for non-commercial use. Charging, ads or selling access needs TMDB's written agreement (section 2). Review the terms again before any income, donations included.
- TMDB's terms forbid an app used mainly for pornographic content. The app asks TMDB about titles for adults only while the viewer has turned them on.
