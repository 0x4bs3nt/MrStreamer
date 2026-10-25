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
