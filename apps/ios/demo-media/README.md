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
