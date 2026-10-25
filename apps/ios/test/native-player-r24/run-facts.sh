#!/usr/bin/env bash
set -euo pipefail
# ROOT must grant a separate native window before invoking this on a Mac.
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Native facts require Apple AVFoundation. No substitute is run on Linux.' >&2
  exit 2
fi
if [[ $# != 1 ]]; then
  echo 'usage: run-facts.sh <owned-output-directory>' >&2
  exit 2
fi
repo_root=$(git rev-parse --show-toplevel)
owned_output=$1
umask 077
mkdir -p "$owned_output"
production="$repo_root/apps/ios/node_modules/expo-video/ios/VideoPlayerObservationFacts.swift"
xcrun swiftc -parse-as-library -framework AVFoundation "$production" \
  "$repo_root/apps/ios/test/native-player-r24/facts-main.swift" -o "$owned_output/native-facts"
"$owned_output/native-facts"
