#!/usr/bin/env bash
# Builds the iOS app for TestFlight on the Mac mini. Run it through `onmac run`, which unlocks the
# signing keychain and exports APPLE_TEAM_ID and the App Store Connect key (ASC_KEY_ID,
# ASC_ISSUER_ID, ASC_KEY_PATH); see the mac-mini skill's signing reference.
#
#   onmac run -- apps/ios/scripts/testflight.sh archive
#   onmac run -- apps/ios/scripts/testflight.sh upload
#
# archive generates the native project from app.json and archives a Release build with its
# JavaScript inside, signed for this team. It refuses uncommitted changes, so an archive is one
# commit, and prints the identity it built. upload sends that archive to App Store Connect for
# internal testers only, with the version and build number app.json gave it.
set -euo pipefail

cd "$(dirname "$0")/.."
archive=build/MrStreamer.xcarchive
auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$ASC_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

case "${1:-}" in
  archive)
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "Commit or drop local changes first: an archive is one commit." >&2
      exit 1
    fi
    pnpm install --frozen-lockfile
    rm -rf build
    # The FFmpeg libraries modules/title-formats links, from their pinned source.
    scripts/build-ffmpeg.sh ios
    CI=1 npx expo prebuild --platform ios --clean
    xcodebuild archive -workspace ios/MrStreamer.xcworkspace -scheme MrStreamer \
      -configuration Release -destination generic/platform=iOS -archivePath "$archive" \
      "${auth[@]}" DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic | xcbeautify
    app="$archive/Products/Applications/MrStreamer.app"
    if [[ ! -s "$app/main.jsbundle" ]]; then
      echo "The archive has no JavaScript bundle; it would need Metro." >&2
      exit 1
    fi
    echo "commit $(git rev-parse HEAD)"
    for key in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion MinimumOSVersion; do
      echo "$key $(/usr/libexec/PlistBuddy -c "Print :$key" "$app/Info.plist")"
    done
    ;;
  upload)
    if [[ ! -d "$archive" ]]; then
      echo "No archive: run archive first." >&2
      exit 1
    fi
    # Xcode raises the build number by default; the one app.json gave stays, so the uploaded build
    # is the archived one.
    cat >build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict>
</plist>
PLIST
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist build/ExportOptions.plist \
      -exportPath build/export "${auth[@]}" | xcbeautify
    ;;
  *)
    echo "Usage: testflight.sh archive|upload" >&2
    exit 1
    ;;
esac
