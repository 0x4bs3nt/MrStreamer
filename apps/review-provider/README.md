# Original review provider

This hosted environment is for App Review reviewers only.

One private read-only Xtream review account, entered manually through the app's
normal Add provider form. The Worker serves one original linear channel with a
matching XMLTV guide, the existing original movie and two episodes. The app's
Provider, Keychain, catalogue, Guide, player and download owners remain unchanged.
The built-in Try demo is separate. There is no public video/account, signup,
database, administration interface, user-state backend or scheduled encoder.

This package has no configured Cloudflare account, Worker target, bucket or
hostname. `wrangler.jsonc` is deliberately inert. Do not run any deploy, secret,
version-upload, bucket, DNS or billing operation without explicit authorization
for the named target. `wrangler secret put` deploys immediately; a versions secret
write is also a remote operation. Local code or checks grant neither.

## Source and preparation

Source media/artwork and GPL-3.0 provenance are in `../ios/demo-media`, fixed at
commit `9791b09908e03742cee981c97e37d47829fc7a18`. No broadcaster streams or rights,
TMDB identity, spoken language, human cast or subtitles are invented. Audio is an
original quiet sine tone tagged `und`. The preparation driver checks the frozen
input hashes and copies originals without modifying them.

`src/catalogue.ts` owns sample definitions and relationships. `src/timeline.ts`
owns one UTC video clock for both rolling HLS and XMLTV. Generated `media.json`
contains actual object sizes/hashes, video/audio certification and measured
rendition metadata. No guessed index ships. Preparation is a separately approved
local runtime task, never an import-time or test side effect.

After that runtime authorization, from the repository root, give an absolute
stage path whose parent exists. The driver refuses existing stages and indexes.
Do not discard a failed or successful stage: it contains the unique bytes and
evidence the owner needs for review and a separately authorized upload.

```sh
timeout --signal=TERM --kill-after=5s 12m node apps/review-provider/scripts/prepare-media.ts /absolute/private/new-stage
```

The driver runs sequentially with bounded subprocess deadlines/output, one
encoder thread and bounded filter/decoder workers. The 540p rendition remuxes the
original video; 180p re-encodes it. AAC is copied once per programme and those same
access units are muxed into both variants. Evidence includes every command,
stdout/stderr, actual decoded frame count, packet PTS, first-VCL IDR/SPS, shared AAC
hash/timestamps, edge offsets, object hashes and tool versions. It fetches nothing
and installs nothing. Partial failures stay in the new stage; only completed,
certified preparation creates `generated/media.json`.

Video alone defines 3600/2160/2160 frames at 24 fps: 150/90/90 seconds. The cycle
is 55 six-second segments, 144 video frames/540000 ticks each, 29700000 ticks per
cycle. Actual video PTS must stay continuous across every segment within each
programme and match between variants. Only programme/cycle boundaries reset with
HLS discontinuities. AAC never extends this clock. Each signed first/last audio
edge must be within 2048 samples/3840 ticks of the corresponding video edge,
with continuous AAC inside the programme. A failed measurement returns evidence;
it does not silently change timing or round a container duration.

Both variants begin each segment with IDR. The master carries independent-segments
and measured BANDWIDTH, AVERAGE-BANDWIDTH, CODECS, RESOLUTION and FRAME-RATE=24.000.
Peak uses the largest complete muxed segment's bits/6; average uses whole-cycle
bits/330. AAC and TS overhead count. The 180p measured peak must be <=192000 bit/s.
Encoder targets alone are not certification. Originals remain MP4 download files.

## HTTP contract

With later private username/password configuration, the existing Xtream client
uses `player_api.php` auth, live/movie/series categories/lists/details, `xmltv.php`,
`/live/U/P/original-live.m3u8`, `/movie/U/P/movie.mp4` and the two
`/series/U/P/episode-N.mp4` files. Catch-up and live MPEG-TS are absent; iOS already
requests HLS. A default desktop MPEG-TS client is outside this minimal contract.

Parse only grammar and credentials before auth. Known and unknown well-formed
protected resource requests with bad credentials both return 401. Action/ID/
release/rendition/sequence lookup, metadata, ranges and HEAD follow auth. Missing
configuration/expected objects fail 503, unsupported actions 400, unknown resources
404, unsupported methods 405. No successful empty replacement or arbitrary key/
URL proxy exists. Only the four original PNG artwork names under `/art` are public.
R2 itself must remain nonpublic. All protected answers/errors are private/no-store.

The fixed epoch is UTC 2026-01-01. Last 150 completed video segments provide 900s;
prepend one older segment if the first would begin a programme. Insufficient
history is 503. Media sequence/PDT never wrap at the source cycle. DSN counts
removed programme boundaries, target duration is 6, and media playlists have no
ENDLIST or playlist type. XMLTV derives the same half-open programme intervals for
the prior hour and next day. Keep every advertised immutable object/release table
through review and beyond the required segment retention interval.

HLS responses are plain strings with negotiated gzip headers and Vary. Workers
performs automatic transmission compression. No precompression/manual encoding.
GET binary uses FixedLengthStream with indexed full/range length, backpressure,
cancel/error propagation and no buffering/hand-set Content-Length reliance.
Valid single ranges produce 206; unsatisfiable ranges 416; malformed/multi-range
is ignored with 200. If-Range needs a matching strong ETag or falls back to full 200. Before headers a read failure is 503; after headers it errors the transfer.

HEAD ignores Range and returns metadata without reading an object body. Actual
local workerd HTTP preserves its explicitly declared indexed Content-Length and
sends no body. GET/206 use FixedLengthStream rather than relying on a hand-set
length. Deployed HEAD behavior remains a required gate, since AVPlayer/URLSession
can issue HEAD internally. A Node Response header assertion is insufficient.

## Credentials and delivery

`REVIEW_LOGIN` is an encrypted binding holding the generated username, password
SHA-256 verifier and optional retiring verifier/retirement time. Both generated
credential strings must be unpadded base64url using only `[A-Za-z0-9_-]`. The
username is 1 to 128 characters. The password encodes at least 32 random bytes,
256 bits, and must fit the 256-character route limit. Standard base64 padding or
other punctuation can pass query authentication but fail media path parsing.

The exact configuration shape below uses descriptive placeholders, not a login:

```json
{
  "username": "<unpadded-base64url username>",
  "passwordSha256": "<64 lowercase hex characters>",
  "retiring": {
    "passwordSha256": "<64 lowercase hex characters>",
    "retireAfterUtc": null
  }
}
```

Hash the exact UTF-8 password string with SHA-256 and encode the digest as 64
lowercase hexadecimal characters. Omit `retiring` until a coordinated rotation.
It holds the previous password verifier for the same stable username;
`retireAfterUtc` is null during overlap, or an explicitly approved UTC ISO timestamp.
The current verifier has no expiry. ROOT owns the existing private login and vault
handoff; do not generate another login or copy private values into this package.

`PUBLIC_ORIGIN` is an explicitly approved HTTPS origin; `MEDIA` is its private R2
binding. No actual credentials/target are included here. Nothing is embedded in
the app. No expiry or automatic rotation may strand current private App Review
notes. Verify notes/handoff before revocation.

Xtream embeds login parts in URLs. Disable invocation/tracing/URL exports before
the first credentialed request, audit account-level logs/retention and avoid raw
Request/URL/error logging. The Worker emits no such logs. Cloudflare necessarily
processes the transport URL. Never publish review credentials, request captures
with those paths, or private provider URLs in evidence.

R2 needs account/subscription/payment activation even when included usage covers
this small service. Free allowances are shared and are not a guaranteed zero bill
or availability promise. No billing activation or paid Workers/Stream service is
authorized. The separately named target, actual uploaded HTTP behavior, native
player/Guide/download/offline/Next journey and Apple approval remain separate.

## Local checks

After the approved dependency setup and actual media preparation, the package's
typecheck, test and build scripts perform the local checks. Root typechecking
includes both package configs; root test globs include these tests. The focused
Vitest config avoids the desktop global setup. No encoder runs in CI tests.
`workerd: false` explicitly declines its install script under pnpm's strict build
policy. Do not use `--ignore-scripts` to claim the ordinary install was verified.

The lock adds a reachable service graph while preserving the existing graph. It
passed frozen validation, but differs from pnpm's previous nonfrozen resolution.
A later dependency edit may reproduce that resolution's unrelated peer/snapshot
changes. Review those changes explicitly rather than treating them as required
service upgrades.

Tests bundle the actual service with a clearly synthetic NON-MEDIA index and
fixture R2 bytes, then drive local workerd HTTP with the real core Xtream client.
They do not mock Provider methods/parsers/renderers. Raw local HTTP tests inspect
full/range lengths, HEAD separately, and gzip decoded exactly once. Explicit R2
failure ports cover missing/short/long/errored sources. Synthetic bytes are never
M01 media certification or a production index. A separate catalogue-only HTTP
smoke invokes the default production entry with the committed measured index,
including index parsing/provenance checks. It reads no prepared media objects and
needs no private preparation stage. Its fixture configuration stays in the test
entry; production has no test header or clock capability. This is not deployed
or native media proof.

Local workerd success proves local workerd only. Actual Cloudflare HTTP H01/H02,
account/runtime budgets/logging H03/H04, native playback/downloads and physical
PiP/AirPlay system scrubbing are unrun until separately verified. App Live seek
acceptance is specifically its Back/Forward 10-second controls within the window;
no speculative I-frame routes, quality UI or new system scrubber is added.

Workers rewrites Accept-Encoding. Playlist negotiation reads the original
clientAcceptEncoding from request.cf, falling back to the header outside that
platform boundary. Actual local HTTP verifies gzip decodes exactly once and that
an identity request remains plain. Deployed HTTP and native acceptance remain unrun.
