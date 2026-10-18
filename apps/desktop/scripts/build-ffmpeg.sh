#!/usr/bin/env bash
# Builds the small ffmpeg and ffprobe that Mr. Streamer ships. ffmpeg converts live streams its
# player cannot decode and plays movies and episodes; ffprobe lists a file's tracks first.
#
#   scripts/build-ffmpeg.sh mac-arm64    on an Apple silicon Mac
#   scripts/build-ffmpeg.sh linux-x64    on x64 Linux
#   scripts/build-ffmpeg.sh win-x64      on Windows in an MSYS2 UCRT64 shell, or cross-compiled
#                                        on x64 Linux with mingw-w64
#
# Needs a C compiler, make, nasm, pkg-config, meson, ninja, git and curl; a Linux cross build also needs
# x86_64-w64-mingw32-gcc.
# Sources are pinned: FFmpeg and dav1d by SHA-256, x264 by commit. The result lands in vendor/ffmpeg/<target>
# with the licences and the exact configuration, where electron-builder picks it up. The build
# keeps only what playback uses: live MPEG-TS in and out on pipes; Matroska, MP4, AVI, FLV and
# MPEG-PS files read over loopback HTTP and written as fragmented MP4, WebVTT cues, subtitle
# packets beside them and a framecrc report of the first video packet; the decoders for the
# codecs these carry; the AAC, x264, WebVTT and DVB subtitle encoders; and the deinterlace and
# scale, padding and pixel-aspect filters. For receivers on the network it also cuts MPEG-TS into the segments of an HLS
# stream, sent to the app over loopback HTTP like the reports.
set -euo pipefail

target=${1:?usage: scripts/build-ffmpeg.sh mac-arm64|linux-x64|win-x64}
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
DAV1D_VERSION=1.5.3
DAV1D_SHA256=732010aa5ef461fa93355ed2c6c5fedb48ddc4b74e697eaabe8907eaeb943011

root=$(cd "$(dirname "$0")/.." && pwd)
work=${XDG_CACHE_HOME:-$HOME/.cache}/mr-streamer/ffmpeg-build/$target
out=$root/vendor/ffmpeg/$target
prefix=$work/prefix
jobs=$(getconf _NPROCESSORS_ONLN)

x264_flags=(--enable-static --disable-cli --enable-pic --disable-opencl --bit-depth=8 --chroma-format=420)
dav1d_flags=(--default-library=static --buildtype=release --libdir=lib -Db_staticpic=true
  -Denable_tools=false -Denable_examples=false -Denable_tests=false -Denable_docs=false)
ffmpeg_flags=()
exe=
native_windows=false
case $target in
  mac-arm64)
    export MACOSX_DEPLOYMENT_TARGET=12.0
    ;;
  linux-x64) ;;
  win-x64)
    ffmpeg_flags+=(--extra-ldflags=-static --pkg-config=pkg-config)
    if [[ $(uname -s) == MINGW* || $(uname -s) == MSYS* ]]; then
      if [[ ${MSYSTEM:-} != UCRT64 ]]; then
        echo "Windows builds require an MSYS2 UCRT64 shell." >&2
        exit 1
      fi
      # Check the compiler's headers too: a changed PATH must not silently select MSVCRT.
      printf '#include <_mingw.h>\n#ifndef _UCRT\n#error UCRT compiler required\n#endif\n' | gcc -E -x c - >/dev/null
      export CC=gcc
      ffmpeg_flags+=(--cc=gcc)
      native_windows=true
    else
      x264_flags+=(--host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32-)
      dav1d_flags+=(--cross-file="$work/dav1d-cross.ini")
      ffmpeg_flags+=(--target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32-
        --enable-cross-compile)
    fi
    exe=.exe
    ;;
  *)
    echo "Unknown target $target" >&2
    exit 1
    ;;
esac

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

mkdir -p "$work"
cd "$work"
archive=ffmpeg-$FFMPEG_VERSION.tar.xz
if [[ ! -f $archive || $(sha256 "$archive") != "$FFMPEG_SHA256" ]]; then
  curl -sSfL -o "$archive" "https://ffmpeg.org/releases/$archive"
fi
if [[ $(sha256 "$archive") != "$FFMPEG_SHA256" ]]; then
  echo "$archive does not match its pinned SHA-256" >&2
  exit 1
fi
dav1d_archive=dav1d-$DAV1D_VERSION.tar.xz
if [[ ! -f $dav1d_archive || $(sha256 "$dav1d_archive") != "$DAV1D_SHA256" ]]; then
  curl -sSfL -o "$dav1d_archive" "https://downloads.videolan.org/pub/videolan/dav1d/$DAV1D_VERSION/$dav1d_archive"
fi
if [[ $(sha256 "$dav1d_archive") != "$DAV1D_SHA256" ]]; then
  echo "$dav1d_archive does not match its pinned SHA-256" >&2
  exit 1
fi
rm -rf ffmpeg x264 dav1d dav1d-build "$prefix"
mkdir ffmpeg
tar -xJf "$archive" -C ffmpeg --strip-components 1
mkdir dav1d
tar -xJf "$dav1d_archive" -C dav1d --strip-components 1
git init -q x264
git -C x264 fetch -q --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
git -C x264 -c advice.detachedHead=false checkout -q FETCH_HEAD

(cd x264 && ./configure --prefix="$prefix" "${x264_flags[@]}" >/dev/null && make -j"$jobs" >/dev/null && make install >/dev/null)

# Meson must use the target compiler and Windows threading when cross-building on Linux.
if [[ $target == win-x64 ]] && ! $native_windows; then
  cat >dav1d-cross.ini <<EOF
[binaries]
c = 'x86_64-w64-mingw32-gcc'
ar = 'x86_64-w64-mingw32-ar'
strip = 'x86_64-w64-mingw32-strip'
[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
[properties]
needs_exe_wrapper = true
EOF
fi
meson setup dav1d-build dav1d --prefix="$prefix" "${dav1d_flags[@]}" >/dev/null
ninja -C dav1d-build -j"$jobs" >/dev/null
ninja -C dav1d-build install >/dev/null

features=(
  --disable-everything --disable-autodetect --disable-doc --disable-debug
  --disable-programs --enable-ffmpeg --enable-ffprobe --disable-avdevice
  --enable-gpl --enable-libx264 --enable-libdav1d --enable-swscale --enable-swresample
  # Live streams arrive on stdin, files from the app's loopback server: no TLS.
  --enable-protocol=pipe,file,http,tcp
  # mpegvideo recognises the MPEG-2 picture in an MPEG-PS file; it reads no files itself.
  --enable-demuxer=mpegts,matroska,mov,avi,flv,mpegps,mpegvideo
  # sup writes PGS subtitles as they are stored, beside the picture. segment cuts a stream into
  # the MPEG-TS files a receiver's HLS player asks for, at the times it is given.
  --enable-muxer=mpegts,mp4,webvtt,framecrc,sup,segment
  --enable-parser=h264,hevc,mpegvideo,mpeg4video,mpegaudio,aac,aac_latm,ac3,dca,mlp,flac,vorbis
  --enable-parser=opus,dvbsub,dvdsub,vp8,vp9,av1
  --enable-decoder=h264,hevc,mpeg1video,mpeg2video,mpeg4,msmpeg4v3,h263,flv
  --enable-decoder=mp2,mp2float,mp3,mp3float,aac,aac_latm,ac3,eac3,dca,truehd,mlp,flac,vorbis,opus
  --enable-decoder=pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_dvd
  --enable-decoder=pcm_bluray
  --enable-decoder=vp8,vp9,libdav1d
  # Text subtitles and CEA-608 tracks, which the WebVTT encoder rewrites. DVD and DivX pictures
  # become DVB subtitles, which the app draws, as it does PGS, DVB and teletext.
  --enable-decoder=subrip,srt,ass,ssa,movtext,webvtt,text,ccaption,dvdsub,xsub
  --enable-encoder=aac,libx264,webvtt,dvbsub
  # extract_extradata finds the parameter sets an MP4 needs in a picture copied from MPEG-TS.
  # filter_units keeps only a picture's SEI units, which carry its closed captions; the two
  # metadata filters bring the H.264 and HEVC readers it needs.
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,filter_units
  --enable-bsf=h264_metadata,hevc_metadata,vp9_superframe_split
  --enable-filter=yadif,scale,pad,setsar,format,aresample,aformat,anull,null
)
configure=(
  --prefix="$prefix"
  --pkg-config-flags=--static
  --extra-cflags="-I$prefix/include"
  --extra-ldflags="-L$prefix/lib"
  "${features[@]}"
  ${ffmpeg_flags[@]+"${ffmpeg_flags[@]}"}
)
(cd ffmpeg && PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure "${configure[@]}" >/dev/null ||
  { tail -n 20 ffbuild/config.log >&2; exit 1; })
make -C ffmpeg -j"$jobs" >/dev/null

# What built the binaries, for the build instructions that come with the GPL's source: the
# compiler and assembler, and the C runtime. Windows links the MinGW-w64 support runtime and
# winpthreads statically; UCRT itself is provided by Windows. Retain the installed package versions
# with the binaries so restoring the cache retains the original build's provenance.
compiler=$(sed -n 's/^CC=//p' ffmpeg/ffbuild/config.mak)
toolchain=$("$compiler" --version | sed -n 1p)
toolchain+="; Meson $(meson --version); Ninja $(ninja --version)"
case $target in
  mac-arm64)
    toolchain+="; macOS SDK $(xcrun --show-sdk-version), for macOS $MACOSX_DEPLOYMENT_TARGET and later"
    ;;
  linux-x64)
    toolchain+="; $(nasm --version | sed -n 1p); $(ldd --version | sed -n 1p)"
    ;;
  win-x64)
    toolchain+="; $(nasm --version | sed -n 1p)"
    runtime=$(printf '#include <_mingw.h>\n__MINGW64_VERSION_STR\n' | "$compiler" -E -P - | sed -n '$p')
    macros=$(printf '#include <_mingw.h>\n' | "$compiler" -dM -E -)
    if grep -Eq '^#define _UCRT( |$)' <<<"$macros"; then crt=UCRT; else crt=MSVCRT; fi
    toolchain+="; MinGW-w64 runtime $runtime; C runtime $crt"
    if $native_windows; then
      packages=$(pacman -Q | grep -E '^(make|git|curl) |^mingw-w64-ucrt-x86_64-')
      toolchain+="; MSYS2 UCRT64; packages ${packages//$'\n'/, }"
    else
      toolchain+="; Linux cross-build"
    fi
    ;;
esac

rm -rf "$out"
mkdir -p "$out"
for program in ffmpeg ffprobe; do
  cp "ffmpeg/$program$exe" "$out/"
  case $target in
    mac-arm64) strip -x "$out/$program$exe" ;;
    linux-x64) strip "$out/$program$exe" ;;
    win-x64)
      if $native_windows; then strip "$out/$program$exe"; else x86_64-w64-mingw32-strip "$out/$program$exe"; fi
      ;;
  esac
done
cp ffmpeg/COPYING.GPLv2 "$out/LICENSE-FFmpeg.txt"
cp x264/COPYING "$out/LICENSE-x264.txt"
cp dav1d/COPYING "$out/LICENSE-dav1d.txt"
cat >"$out/README.txt" <<EOF
ffmpeg$exe and ffprobe$exe: FFmpeg $FFMPEG_VERSION with x264 $X264_COMMIT and dav1d $DAV1D_VERSION, built for $target by
scripts/build-ffmpeg.sh in the Mr. Streamer source repository. FFmpeg and x264 are licensed under
the GNU GPL, version 2 or later. dav1d is licensed under BSD-2-Clause.
Sources: https://ffmpeg.org/releases/$archive (SHA-256 $FFMPEG_SHA256)
         https://code.videolan.org/videolan/x264/-/tree/$X264_COMMIT
         https://downloads.videolan.org/pub/videolan/dav1d/$DAV1D_VERSION/$dav1d_archive (SHA-256 $DAV1D_SHA256)
Configuration: ${configure[*]}
x264 configuration: --prefix=$prefix ${x264_flags[*]}
dav1d configuration: --prefix=$prefix ${dav1d_flags[*]}
Built with: $toolchain
EOF
du -h "$out/ffmpeg$exe" "$out/ffprobe$exe"
