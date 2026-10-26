#!/usr/bin/env bash
# Local signed archives and explicit App Store Connect exports. Run heavy work with
# `onmac run -- onmac-job`; signing uses cached fleet material without provisioning updates.
set -euo pipefail

usage() {
  echo "Usage: testflight.sh archive | export internal-only|app-store | upload internal-only|app-store" >&2
  exit 1
}
command=${1:-}
intent=${2:-}
case "$command" in
  archive) [[ $# == 1 ]] || usage ;;
  export|upload) [[ $# == 2 && ( $intent == internal-only || $intent == app-store ) ]] || usage ;;
  *) usage ;;
esac

cd "$(dirname "$0")/.."
archive=build/MrStreamer.xcarchive
archive_symlinks() {
  node - "$archive" build/main.jsbundle.map build/configuration.json <<'JS'
const { lstatSync, readdirSync, readlinkSync } = require('node:fs');
const { join } = require('node:path');
const links = [];
function visit(path) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) links.push([path, readlinkSync(path)]);
  else if (entry.isDirectory()) {
    for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
}
for (const path of process.argv.slice(2)) visit(path);
process.stdout.write(JSON.stringify(links) + '\n');
JS
}
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit local changes first: the archive and export must identify one commit." >&2
  exit 1
fi
: "${APPLE_TEAM_ID:?Use the fleet-managed signing interface.}"
[[ $APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || {
  echo "Invalid signing team." >&2
  exit 1
}

case "$command" in
  archive)
    for artifact in "$archive" build/main.jsbundle.map build/source.txt build/archive.sha256 build/archive-symlinks.json build/configuration.json; do
      if [[ -e $artifact ]]; then
        echo "Candidate files already exist; retain the archive, map and receipts together before rebuilding." >&2
        exit 1
      fi
    done
    # Expo must use only the approved environment, never leftover dotenv or fixture inputs.
    export EXPO_NO_DOTENV=1
    if [[ -n ${EXPO_PUBLIC_TMDB_API:-} || -n ${EXPO_PUBLIC_PROOF_URL:-} ||
      -n ${EXPO_PUBLIC_MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT:-} ]]; then
      echo "Fixture overrides are not allowed in a distribution archive." >&2
      exit 1
    fi
    if [[ -z ${EXPO_PUBLIC_TMDB_KEY:-} || ${EXPO_PUBLIC_MR_STREAMER_ANALYTICS_RELEASE_BUILD:-} != 1 ||
      ! ${EXPO_PUBLIC_MR_STREAMER_ANALYTICS_HOST:-} =~ ^https://(eu|us)\.i\.posthog\.com$ ||
      ! ${EXPO_PUBLIC_MR_STREAMER_ANALYTICS_PROJECT_TOKEN:-} =~ ^phc_[A-Za-z0-9_-]+$ ]]; then
      echo "Load the approved production TMDB and statistics inputs before archiving." >&2
      exit 1
    fi
    source=$(git rev-parse HEAD)
    pnpm install --frozen-lockfile
    scripts/build-ffmpeg.sh ios
    CI=1 npx expo prebuild --platform ios --clean
    # Hash the approved inputs without storing their values in receipts or logs.
    node <<'JS'
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const names = ['EXPO_PUBLIC_TMDB_KEY', 'EXPO_PUBLIC_MR_STREAMER_ANALYTICS_RELEASE_BUILD',
  'EXPO_PUBLIC_MR_STREAMER_ANALYTICS_HOST', 'EXPO_PUBLIC_MR_STREAMER_ANALYTICS_PROJECT_TOKEN'];
const hashes = Object.fromEntries(names.map(name =>
  [name, createHash('sha256').update(process.env[name]).digest('hex')]));
writeFileSync('build/configuration.json', JSON.stringify(hashes, null, 2) + '\n');
JS
    # Hold the Settings inventory to the actual JavaScript packages and native pods.
    node scripts/licences.ts --check --pods ios/Podfile.lock
    # Xcode-managed cached profiles require Automatic. With no provisioning-update flags,
    # missing signing material fails rather than creating or refreshing it. Scope to the app.
    node <<'JS'
const { writeFileSync } = require('node:fs');
const { IOSConfig } = require('expo/config-plugins');
const xcode = IOSConfig.XcodeUtils;
const project = xcode.getPbxproj(process.cwd());
const { target } = xcode.getApplicationNativeTarget({ project, projectName: 'MrStreamer' });
const [, release] = xcode.getBuildConfigurationForListIdAndName(project, {
  configurationListId: target.buildConfigurationList,
  buildConfiguration: 'Release',
});
Object.assign(release.buildSettings, {
  DEVELOPMENT_TEAM: process.env.APPLE_TEAM_ID,
  CODE_SIGN_STYLE: 'Automatic',
  CODE_SIGN_IDENTITY: '"Apple Development"',
});
delete release.buildSettings.PROVISIONING_PROFILE_SPECIFIER;
writeFileSync(project.filepath, project.writeSync());
JS
    # Keep the composed Metro/Hermes map with the exact bundle from this archive.
    xcodebuild archive -workspace ios/MrStreamer.xcworkspace -scheme MrStreamer \
      -configuration Release -destination generic/platform=iOS -archivePath "$archive" \
      SOURCEMAP_FILE="$PWD/build/main.jsbundle.map" | xcbeautify
    app="$archive/Products/Applications/MrStreamer.app"
    if [[ ! -s "$app/main.jsbundle" || ! -s build/main.jsbundle.map ]]; then
      echo "The archive needs its embedded JavaScript and matching source map." >&2
      exit 1
    fi
    # Installed FFmpeg frameworks are stripped; the exact linked build outputs still carry
    # debug maps to the objects. Retain their matching symbols before the workspace is cleaned.
    for lib in libavcodec libavformat libavutil; do
      xcrun dsymutil build/ffmpeg/src-iphoneos/"$lib"/"$lib".*.dylib \
        -o "$archive/dSYMs/$lib.framework.dSYM"
    done
    [[ $(git rev-parse HEAD) == "$source" && -z "$(git status --porcelain)" ]] || {
      echo "Source changed during the archive; candidate not accepted." >&2
      exit 1
    }
    echo "$source" >build/source.txt
    archive_symlinks >build/archive-symlinks.json
    find "$archive" build/main.jsbundle.map build/configuration.json build/archive-symlinks.json -type f -exec shasum -a 256 {} + >build/archive.sha256
    echo "commit $source"
    for key in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion MinimumOSVersion UIDeviceFamily; do
      echo "$key"
      /usr/libexec/PlistBuddy -c "Print :$key" "$app/Info.plist"
    done
    ;;
  export|upload)
    if [[ ! -s build/source.txt || $(cat build/source.txt) != "$(git rev-parse HEAD)" ]]; then
      echo "No archive of this commit: run archive first. Rebase or source changes require a rebuild." >&2
      exit 1
    fi
    current_links=$(archive_symlinks)
    [[ $current_links == "$(cat build/archive-symlinks.json)" ]] || {
      echo "Archive symlinks differ from the receipt." >&2
      exit 1
    }
    manifest_paths=$(sed -E 's/^[[:xdigit:]]{64}  //' build/archive.sha256 | LC_ALL=C sort)
    actual_paths=$(find "$archive" build/main.jsbundle.map build/configuration.json build/archive-symlinks.json -type f -print | LC_ALL=C sort)
    [[ $manifest_paths == "$actual_paths" ]] || {
      echo "Archive contents differ from the receipt." >&2
      exit 1
    }
    shasum -a 256 -c build/archive.sha256 >/dev/null
    internal=false
    [[ $intent == internal-only ]] && internal=true
    # The command is the destination: export saves locally and never uploads. Both keep the
    # archived version and build; internal-only limits the build to internal TestFlight testers.
    cat >build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$command</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
  <key>testFlightInternalTestingOnly</key><$internal/>
</dict></plist>
PLIST
    # Never empty: macOS's bash 3.2 treats an empty "${array[@]}" as unbound under set -u.
    args=(-exportArchive -archivePath "$archive" -exportOptionsPlist build/ExportOptions.plist
      -exportPath "build/$command-$intent")
    if [[ $command == upload ]]; then
      args+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID"
        -authenticationKeyIssuerID "$ASC_ISSUER_ID")
    fi
    xcodebuild "${args[@]}" | xcbeautify
    echo "$command intent=$intent source=$(cat build/source.txt); Apple processing/eligibility requires separate readback."
    ;;
esac
