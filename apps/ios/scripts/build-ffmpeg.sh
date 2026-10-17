#!/usr/bin/env bash
# Builds the FFmpeg libraries the iOS app links to play files AVPlayer can't open, such as
# Matroska: libavformat reads the file and writes its packets, unchanged, as fragmented MP4 for
# a loopback HLS stream (modules/title-formats). Nothing is decoded; the only codecs are FFmpeg's
# own AC-3 and E-AC-3 encoders, which make one frame of silence per such sound track to fill
# where it has none. No decoders, programs, resampler or network code, and nothing under the GPL.
#
#   scripts/build-ffmpeg.sh ios          on a Mac with Xcode: dynamic xcframeworks for the iPhone
#                                        and the arm64 simulator, in the module that links them,
#                                        modules/title-formats/ios/vendor/ffmpeg
#   scripts/build-ffmpeg.sh reference    on Linux or a Mac: the same configuration for this
#                                        machine, in vendor/ffmpeg/reference, for the core's tests
#
# Needs a C compiler, make, pkg-config and curl. The source is FFmpeg 9.0.2, pinned by the
# SHA-256 the desktop's scripts/build-ffmpeg.sh pins, from the copy attached to Mr. Streamer's
# v0.0.14 release. Beside the result, BUILD.txt records the archive, its checksum, the
# configure lines and the toolchain, and NOTICE.txt and COPYING.LGPLv2.1 are the notice the app
# carries for them (modules/title-formats bundles all three).
set -euo pipefail

target=${1:?usage: scripts/build-ffmpeg.sh ios|reference}
cd "$(dirname "$0")/.."
root=$PWD

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
FFMPEG_URL=https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.14/ffmpeg-$FFMPEG_VERSION.tar.xz
IOS_MIN=16.4

# The one list of what the libraries can do. Matroska is what AVPlayer refuses; MP4 and MOV read
# too, for a file whose name says otherwise. The parsers fill in what a copied packet's track
# needs to be written as MP4. The encoders only ever encode silence.
features=(
  --disable-everything --disable-autodetect --disable-doc --disable-programs
  --disable-avdevice --disable-avfilter --disable-swscale --disable-swresample --disable-network
  --disable-asm
  --enable-avformat --enable-avcodec --enable-avutil
  --enable-demuxer=matroska,mov
  --enable-muxer=mp4
  --enable-parser=h264,hevc,aac,ac3,mpegaudio
  --enable-encoder=ac3,eac3
  --enable-shared --disable-static
)

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
jobs=$(getconf _NPROCESSORS_ONLN)
work=$root/build/ffmpeg
out=$root/vendor/ffmpeg/$target
[[ $target == ios ]] && out=$root/modules/title-formats/ios/vendor/ffmpeg
mkdir -p "$work"
archive=$work/ffmpeg-$FFMPEG_VERSION.tar.xz
if [[ ! -f $archive || $(sha256 "$archive") != "$FFMPEG_SHA256" ]]; then
  curl -sSfL -o "$archive" "$FFMPEG_URL"
fi
if [[ $(sha256 "$archive") != "$FFMPEG_SHA256" ]]; then
  echo "$archive does not match its pinned SHA-256" >&2
  exit 1
fi

# Configures and installs one build of the libraries into $2, from a clean source tree.
build() {
  local name=$1 prefix=$2
  shift 2
  local src=$work/src-$name
  rm -rf "$src" "$prefix"
  mkdir -p "$src"
  tar -xJf "$archive" -C "$src" --strip-components 1
  (cd "$src" && ./configure --prefix="$prefix" "${features[@]}" "$@" >"$work/configure-$name.log" ||
    { tail -40 "$src/ffbuild/config.log" >&2; exit 1; })
  make -C "$src" -j"$jobs" >"$work/make-$name.log"
  make -C "$src" install >/dev/null
  echo "configure --prefix=<prefix> ${features[*]} $*" >"$prefix/CONFIGURE.txt"
}

record() {
  {
    echo "FFmpeg $FFMPEG_VERSION"
    echo "archive $FFMPEG_URL"
    echo "sha256 $FFMPEG_SHA256"
    echo "licence LGPL-2.1-or-later (no --enable-gpl, no --enable-version3, no nonfree)"
    echo "toolchain $1"
    for each in "${@:2}"; do echo "$(basename "$(dirname "$each")") $(cat "$each")"; done
  } >"$out/BUILD.txt"
  cp "$work/src-${slices[0]}/COPYING.LGPLv2.1" "$out/COPYING.LGPLv2.1"
  cat >"$out/NOTICE.txt" <<NOTICE
FFmpeg $FFMPEG_VERSION: libavutil, libavcodec and libavformat.
Copyright the FFmpeg developers, https://ffmpeg.org.
Licensed under the GNU Lesser General Public License, version 2.1 or later; its text is in
COPYING.LGPLv2.1 beside this file.

Source: the unchanged FFmpeg release archive at
$FFMPEG_URL
SHA-256 $FFMPEG_SHA256
built by apps/ios/scripts/build-ffmpeg.sh at the app's commit, configured as BUILD.txt says.
In the app the libraries are separate dynamic frameworks: Frameworks/libavutil.framework,
libavcodec.framework and libavformat.framework.
NOTICE
}

case "$target" in
  reference)
    slices=(reference)
    build reference "$out/prefix" --enable-rpath --enable-debug=3 --disable-stripping
    record "$(cc --version | head -1)" "$out/prefix/CONFIGURE.txt"
    ;;
  ios)
    [[ $(uname) == Darwin ]] || { echo "The iOS libraries build on a Mac." >&2; exit 1; }
    slices=(iphoneos iphonesimulator)
    libs=(libavutil libavcodec libavformat)
    for sdk in "${slices[@]}"; do
      triple=arm64-apple-ios$IOS_MIN
      [[ $sdk == iphonesimulator ]] && triple=$triple-simulator
      cc="$(xcrun -sdk "$sdk" -f clang) -target $triple -isysroot $(xcrun -sdk "$sdk" --show-sdk-path)"
      build "$sdk" "$work/out-$sdk" --enable-cross-compile --target-os=darwin --arch=aarch64 \
        --cc="$cc" --install-name-dir=@rpath
      # Each dylib becomes a framework, the form an app embeds, named by what links to it.
      for lib in "${libs[@]}"; do
        dir=$work/frameworks-$sdk/$lib.framework
        rm -rf "$dir"
        mkdir -p "$dir"
        cp "$(readlink -f "$work/out-$sdk/lib/$lib.dylib")" "$dir/$lib"
        install_name_tool -id "@rpath/$lib.framework/$lib" "$dir/$lib"
        for dep in "${libs[@]}"; do
          linked=$(otool -L "$dir/$lib" | awk -v d="$dep" '$1 ~ d"\\." {print $1}')
          [[ -n $linked ]] && install_name_tool -change "$linked" "@rpath/$dep.framework/$dep" "$dir/$lib"
        done
        cat >"$dir/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$lib</string>
  <key>CFBundleIdentifier</key><string>app.mrstreamer.ffmpeg.$lib</string>
  <key>CFBundleName</key><string>$lib</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>$FFMPEG_VERSION</string>
  <key>CFBundleVersion</key><string>$FFMPEG_VERSION</string>
  <key>MinimumOSVersion</key><string>$IOS_MIN</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$( [[ $sdk == iphoneos ]] && echo iPhoneOS || echo iPhoneSimulator )</string></array>
</dict>
</plist>
PLIST
      done
    done
    rm -rf "$out"
    mkdir -p "$out"
    for lib in "${libs[@]}"; do
      xcodebuild -create-xcframework \
        -framework "$work/frameworks-iphoneos/$lib.framework" \
        -framework "$work/frameworks-iphonesimulator/$lib.framework" \
        -output "$out/$lib.xcframework" >/dev/null
    done
    # The headers are the same for both slices; the module's C code compiles against them.
    cp -R "$work/out-iphoneos/include" "$out/include"
    record "$(xcodebuild -version | tr '\n' ' ')" "$work/out-iphoneos/CONFIGURE.txt" \
      "$work/out-iphonesimulator/CONFIGURE.txt"
    du -sh "$out"/*.xcframework
    ;;
  *)
    echo "Unknown target $target" >&2
    exit 1
    ;;
esac
echo "Built FFmpeg $FFMPEG_VERSION into $out"
