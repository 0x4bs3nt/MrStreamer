#!/usr/bin/env bash
# Builds the reference check against vendor/ffmpeg/reference and runs it on each file given:
#   modules/title-formats/reference/run.sh <out-folder> [--start <seconds>] <file>...
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ff=$here/../../../vendor/ffmpeg/reference/prefix
out=${1:?usage: run.sh <out-folder> [--start <seconds>] <file>...}
shift
start=0
if [[ ${1:-} == --start ]]; then
  start=$2
  shift 2
fi
mkdir -p "$out"
cc -std=c11 -O1 -g -Wall -Wextra -Wno-unused-parameter -fsanitize=address,undefined \
  -I"$ff/include" "$here/check.c" "$here/../ios/core/title_hls.c" -L"$ff/lib" \
  -Wl,-rpath,"$ff/lib" -lavformat -lavcodec -lavutil -lm -o "$out/check"
status=0
for file in "$@"; do
  name=$(basename "$file")
  rm -rf "${out:?}/$name"
  mkdir -p "$out/$name"
  echo "== $name"
  code=0
  "$out/check" "$file" "$out/$name" "$start" || code=$?
  if [[ $code == 3 ]]; then echo "direct: AVPlayer opens it itself"
  elif [[ $code != 0 ]]; then echo "FAILED $name"; status=1; fi
done
exit $status
