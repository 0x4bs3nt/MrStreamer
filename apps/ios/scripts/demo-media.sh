#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Original sample media. The script is the preferred form for modification.
set -euo pipefail
umask 077
export LC_ALL=C

if [[ $# != 1 || $1 != /* || $1 == */ ]]; then
  printf 'Usage: %s /absolute/path/to/NEW-output-directory\n' "$0" >&2
  exit 64
fi
output=$1
if [[ -e $output || -L $output ]]; then
  printf 'Refusing existing output path: %s\n' "$output" >&2
  exit 73
fi
for tool in ffmpeg ffprobe sha256sum; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 69; }
done
# No force mode, removal, downloads, installs, or writes outside this fresh directory.
mkdir "$output"
cd "$output"
mkdir provenance
trap 'printf "Generation failed; partial outputs retained in %s\n" "$output" >&2' ERR
run() {
  local argument separator=''
  for argument in "$@"; do
    printf '%s%q' "$separator" "$argument" >>provenance/commands.sh
    separator=' '
  done
  printf '\n' >>provenance/commands.sh
  "$@"
}
printf '# Commands run from the output directory, in order. Bash quoting.\n' >provenance/commands.sh
run ffmpeg -version >provenance/ffmpeg-version.txt
run ffprobe -version >provenance/ffprobe-version.txt

# A disc inside two fine orbital rings on a dark diagonal colour field.
# No randomness: seed 0 denotes this fixed formula, not a random-number source.
# Cover and backdrop use the same normalized geometry at their own aspect ratios.
artwork() {
  local name=$1 width=$2 height=$3 centre=$4 palette=$5
  local distance disc ring red green blue
  distance="sqrt(pow((X/W-$centre)*1.35,2)+pow(Y/H-0.46,2))"
  disc="clip((0.265-$distance)*90,0,1)"
  ring="max(clip(1-abs($distance-0.32)*140,0,1),clip(1-abs($distance-0.39)*160,0,1))"
  if [[ $palette == coral ]]; then
    red="12+16*Y/H+196*$disc+42*$ring"
    green="16+22*Y/H+68*$disc+132*$ring"
    blue="34+35*X/W+42*$disc+155*$ring"
  else
    red="14+20*Y/H+52*$disc+176*$ring"
    green="18+18*Y/H+144*$disc+84*$ring"
    blue="38+42*X/W+156*$disc+144*$ring"
  fi
  run ffmpeg -hide_banner -loglevel warning -nostdin -n -filter_threads 2 \
    -f lavfi -i "color=c=black:s=${width}x${height}:r=1" \
    -vf "format=gbrp,geq=r='$red':g='$green':b='$blue',format=rgb24" \
    -frames:v 1 -c:v png -threads:v 2 -fflags +bitexact -flags:v +bitexact \
    -map_metadata -1 -update 1 "$name.png"
}
artwork movie-cover 600 900 0.50 coral
artwork movie-backdrop 960 540 0.62 coral
artwork series-cover 600 900 0.50 ice
artwork series-backdrop 960 540 0.62 ice

# A slow orbit of the camera across the original still, at 24 fps.
# The quiet sine is synthesized, duplicated to stereo, and faded at both ends.
movie() {
  local name=$1 seconds=$2 picture=$3 frequency=$4 phase=$5 hue=$6
  local fade_end=$((seconds - 2)) motion audio
  motion="zoompan=z='1.10+0.035*sin(on/240+$phase)':x='iw/2-iw/zoom/2+iw*0.012*sin(on/360+$phase)':y='ih/2-ih/zoom/2+ih*0.012*cos(on/360+$phase)':d=1:s=960x540:fps=24,hue=h=$hue,format=yuv420p,setsar=1"
  audio="volume=0.16,pan=stereo|c0=c0|c1=c0,afade=t=in:st=0:d=2,afade=t=out:st=$fade_end:d=2"
  run ffmpeg -hide_banner -loglevel warning -nostdin -n -filter_threads 2 -filter_complex_threads 2 \
    -threads 2 -loop 1 -framerate 24 -i "$picture.png" \
    -f lavfi -i "sine=frequency=$frequency:sample_rate=48000:duration=$seconds" \
    -map 0:v:0 -map 1:a:0 -t "$seconds" -vf "$motion" -af "$audio" \
    -c:v libx264 -threads:v 1 -preset veryfast -profile:v baseline -level:v 3.1 \
    -b:v 240k -maxrate:v 280k -bufsize:v 560k -pix_fmt yuv420p \
    -g 48 -keyint_min 48 -sc_threshold 0 -bf 0 \
    -x264-params 'threads=1:lookahead_threads=1:sliced_threads=0:force-cfr=1' \
    -c:a aac -threads:a 2 -profile:a aac_low -b:a 48k -ar 48000 -ac 2 \
    -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
    -map_metadata -1 -map_chapters -1 -metadata:s:v:0 language=und -metadata:s:a:0 language=und \
    -disposition:v:0 0 -disposition:a:0 0 -movflags +faststart "$name.mp4"
}
movie movie 150 movie-backdrop 174 0 0
movie episode-1 90 series-backdrop 196 1 0
movie episode-2 90 series-backdrop 220 2 32

printf 'id\tkind\tpath\tduration_seconds\tseries_id\tseason\tepisode\tlanguage\twidth\theight\n' >catalogue.tsv
for name in movie episode-1 episode-2; do
  run ffprobe -v error -show_format -show_streams -show_chapters -of json "$name.mp4" >"provenance/$name.ffprobe.txt"
  duration=$(run ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$name.mp4")
  if [[ $name == movie ]]; then
    printf 'movie\tmovie\tmovie.mp4\t%s\t\t\t\tund\t960\t540\n' "$duration" >>catalogue.tsv
  else
    printf '%s\tepisode\t%s.mp4\t%s\tseries\t1\t%s\tund\t960\t540\n' "$name" "$name" "$duration" "${name#episode-}" >>catalogue.tsv
  fi
done
for name in movie-cover movie-backdrop series-cover series-backdrop; do
  run ffprobe -v error -show_format -show_streams -of json "$name.png" >"provenance/$name.ffprobe.txt"
  if [[ $name == *cover ]]; then
    printf '%s\tartwork\t%s.png\t\t\t\t\t\t600\t900\n' "$name" "$name" >>catalogue.tsv
  else
    printf '%s\tartwork\t%s.png\t\t\t\t\t\t960\t540\n' "$name" "$name" >>catalogue.tsv
  fi
done

cat >README.md <<'EOF'
# Original generated demo media

These are abstract samples made for Mr. Streamer, licensed under the repository's
GPL-3.0. See `../../../LICENSE`. The preferred form for modification is
`../scripts/demo-media.sh`. No footage, fonts, faces, logos, music samples, speech
or borrowed artwork is used. All picture pixels come from the original geometric
formula in that script. Audio is a quiet generated sine, with two-second fades.
There are no subtitles or spoken-language claims. Track language is undetermined.

`movie.mp4` is a 150-second sample. `episode-1.mp4` and `episode-2.mp4` are one
series, season 1, in that order, each 90 seconds. They are generated samples, with
no film credits, release year, TMDB identity or human cast. Suggested factual
labels are "Generated sample movie", "Generated sample series", "Episode 1" and
"Episode 2". The future adapter owns the labels and must label these as samples.

`catalogue.tsv` records stable IDs, paths, measured container durations in seconds,
dimensions and episode order. `movie-cover.png` and `series-cover.png` are 600 x 900
portraits. The matching `*-backdrop.png` files are 960 x 540 landscapes. All four
are opaque RGB, text-free original compositions. Nothing here is bundled or
connected to the app by this asset contribution.

Every MP4 has one H.264 Baseline video at 960 x 540, 24 fps, one AAC-LC 48 kHz
stereo tone track, and a two-second video keyframe interval. Each is below
8,000,000 bytes. The MP4 moov atom precedes mdat for progressive seeking.
These are Linux file-contract facts, not AVPlayer or offline-download acceptance.

## Regenerate

Use Bash, FFmpeg with libx264/AAC/PNG/lavfi, ffprobe and sha256sum, already installed.
Run from the repository root and give a new absolute output path with an existing
parent. The script refuses any existing output path, including symlinks. It never
deletes files or installs tools. It retains partial outputs on failure. No force
mode is provided. Filter and decoder worker counts are bounded to two. x264 uses
one encoding worker and one lookahead worker to avoid thread timing changes in
VBV rate control. Run sequentially in an appropriate runtime slot. On Linux, a caller can bound the
whole invocation with `timeout --signal=TERM --kill-after=10s 10m`.

```sh
bash apps/ios/scripts/demo-media.sh /absolute/owned/parent/new-demo-media
cd /absolute/owned/parent/new-demo-media
sha256sum -c SHA256SUMS
```

`provenance/commands.sh` records every expanded FFmpeg/ffprobe command in order,
using Bash quoting and paths relative to the output directory. It is a command
transcript, not a regeneration script. `provenance/*-version.txt` records the exact
installed tool versions and build configuration used for these bytes.
`provenance/*.ffprobe.txt` holds unmodified JSON output with measured container and
complete track facts. The text extension preserves the tool's own formatting.
`provenance/recipe.md` records the seed convention, colours and encoding choices.
`SHA256SUMS` hashes all other generated files, including provenance and this README.
It excludes itself. The script is versioned alongside the assets in Git.

Bitexact flags suppress variable encoder metadata. Identical output across FFmpeg
versions, builds or platforms is not promised. Use the recorded versions and
actual hashes to identify these bytes. Pin the actual asset commit in the future
adapter after integration preserves it as an ancestor. This directory contains no
self-referencing commit hash and no placeholder or published media URL.

GitHub raw availability, actual HTTP 206 ranges, native AVPlayer play/seek and
background download/offline Next remain separate unrun integration gates. Live
activation stays none. Broadcaster rights are unanswered and Guide is unmet.
EOF
cat >provenance/recipe.md <<'EOF'
# Provenance

Copyright 2026 Mr. Streamer contributors. GPL-3.0, as in the repository LICENSE.
Original algorithm and generation commands were authored for this contribution.
No source media was fetched or read. FFmpeg's lavfi color and sine sources supply
the inputs. PNGs made by the formula become the sole video picture inputs.

Seed 0 means a fixed deterministic formula with no random generator. Coordinates
are normalized by width and height. The disc radius is 0.265 with a 90-unit edge
ramp. Rings have radii 0.32 and 0.39, with edge factors 140 and 160. The horizontal
distance is scaled by 1.35. Vertical centre is 0.46. Horizontal centre is 0.50 for
portraits and 0.62 for landscapes.

Coral RGB base is (12,16,34); vertical additions (16,22,0); horizontal addition
(0,0,35); disc addition (196,68,42); ring addition (42,132,155).
Ice RGB base is (14,18,38); vertical additions (20,18,0); horizontal addition
(0,0,42); disc addition (52,144,156); ring addition (176,84,144).
The full geq expressions are in commands.sh and the source script.

Camera zoom is 1.10 + 0.035*sin(frame/240 + phase). The small horizontal and
vertical offsets use sin/cos(frame/360 + phase). Phases are movie 0, episode 1 1,
episode 2 2. Episode 2 rotates hue by 32 degrees; the others use 0.
Tone frequencies are 174, 196 and 220 Hz respectively, not music or recordings.
Lavfi sine's default 1/8 amplitude is multiplied by 0.16, nominal peak 0.02
or about -34 dBFS before AAC. Both channels carry the same gentle tone.
Every tone fades in for two seconds and out over the last two seconds.

H.264 uses libx264 veryfast, Baseline level 3.1, yuv420p, 240 kb/s target,
280 kb/s maximum, 560 kb buffer, no B frames, fixed 48-frame GOP at 24 fps,
scene cut disabled. AAC-LC is 48 kb/s, stereo, 48000 Hz. No chapters, subtitle,
data or attached picture tracks are mapped. Metadata is stripped, track language
is und, and no forced disposition is requested. Faststart relocates moov.
fflags and codec flags use +bitexact. Filter/decoder threads are bounded to two.
x264 encoding and lookahead use one worker each. commands.sh records the exact
option ordering. Two-worker x264 with VBV produced different hashes on a repeated
one-second sample on this build; single-worker encoding passed the same check.
EOF

files=(README.md catalogue.tsv movie.mp4 episode-1.mp4 episode-2.mp4
  movie-cover.png movie-backdrop.png series-cover.png series-backdrop.png
  provenance/commands.sh provenance/ffmpeg-version.txt provenance/ffprobe-version.txt provenance/recipe.md
  provenance/movie.ffprobe.txt provenance/episode-1.ffprobe.txt provenance/episode-2.ffprobe.txt
  provenance/movie-cover.ffprobe.txt provenance/movie-backdrop.ffprobe.txt
  provenance/series-cover.ffprobe.txt provenance/series-backdrop.ffprobe.txt)
sha256sum "${files[@]}" >SHA256SUMS
printf 'Generated original media in %s\n' "$output"
