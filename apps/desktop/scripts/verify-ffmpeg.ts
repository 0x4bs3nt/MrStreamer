// Verifies the shipped tools, including warm caches, before a package is built. The tiny source
// fixtures exercise VP8/WebM, 10-bit VP9/MP4 and WebM, and 10-bit AV1/Matroska and MP4
// without a system encoder.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { h264ImageArguments } from "../src/main/playback/conversion-settings.ts";

const target = process.argv[2];
if (target !== "mac-arm64" && target !== "linux-x64" && target !== "win-x64") {
  throw new Error("Usage: node scripts/verify-ffmpeg.ts mac-arm64|linux-x64|win-x64");
}
const root = join(import.meta.dirname, "..");
const suffix = target === "win-x64" ? ".exe" : "";
const ffmpeg = join(root, "vendor", "ffmpeg", target, `ffmpeg${suffix}`);
const ffprobe = join(root, "vendor", "ffmpeg", target, `ffprobe${suffix}`);

function execute(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

const required = {
  decoders: ["h264", "hevc", "mpeg2video", "aac", "vp8", "vp9", "libdav1d"],
  parsers: ["h264", "hevc", "mpegvideo", "vp8", "vp9", "av1"],
  demuxers: ["mpegts", "matroska", "mov"],
  muxers: ["mpegts", "mp4", "segment"],
  bsfs: ["h264_mp4toannexb", "hevc_mp4toannexb", "aac_adtstoasc", "vp9_superframe_split"],
  filters: ["yadif", "scale", "pad", "setsar", "format"],
};
// FFmpeg has no parser-list command. Check its embedded configuration and exercise the new
// parsers below by decoding and converting their complete source fixtures.
const build = execute(ffmpeg, ["-hide_banner", "-buildconf"]);
const parsers = new Set(
  [...build.matchAll(/--enable-parser=(?:'([^']*)'|"([^"]*)"|(\S+))/g)].flatMap((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "").split(","),
  ),
);
for (const [group, names] of Object.entries(required)) {
  if (group === "parsers") {
    for (const name of names) assert.ok(parsers.has(name), `${target} is missing parser: ${name}`);
    continue;
  }
  const listing = execute(ffmpeg, ["-hide_banner", `-${group}`]);
  const available = new Set(
    listing.split("\n").flatMap((line) => {
      const columns = line.trim().split(/\s+/);
      return (group === "bsfs" ? columns[0] : columns[1])?.split(",") ?? [];
    }),
  );
  for (const name of names)
    assert.ok(available.has(name), `${target} is missing ${group}: ${name}`);
}

const Probe = type({
  streams: type({
    codec_name: "string",
    width: "number",
    height: "number",
    pix_fmt: "string",
    nb_read_frames: "string",
    sample_aspect_ratio: "string",
  }).array(),
});
function decoded(path: string, width: number, height: number) {
  const result = Probe.assert(
    JSON.parse(
      execute(ffprobe, [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,pix_fmt,nb_read_frames,sample_aspect_ratio",
        "-of",
        "json",
        path,
      ]),
    ),
  );
  assert.equal(result.streams.length, 1, "One decoded picture stream is required");
  const stream = result.streams[0];
  assert.ok(stream);
  assert.equal(stream.width, width);
  assert.equal(stream.height, height);
  assert.equal(stream.nb_read_frames, "12", "All twelve fixture frames must decode");
  return stream;
}

const fixtures = [
  { file: "vp8.webm", codec: "vp8", format: "yuv420p" },
  { file: "vp9-10bit.mp4", codec: "vp9", format: "yuv420p10le" },
  { file: "vp9-10bit.webm", codec: "vp9", format: "yuv420p10le" },
  { file: "av1-10bit.mkv", codec: "av1", format: "yuv420p10le" },
  { file: "av1-10bit.mp4", codec: "av1", format: "yuv420p10le" },
];
const scratch = mkdtempSync(join(tmpdir(), "mrstreamer-codecs-"));
// A different aspect ratio exercises padding as well as the same HLS scale and square-pixel graph.
const picture = { width: 128, height: 96 };
const image = h264ImageArguments(picture);
try {
  const results = fixtures.map(({ file, codec, format }) => {
    const input = join(root, "test", "fixtures", "codecs", file);
    const source = decoded(input, 96, 64);
    assert.equal(source.codec_name, codec);
    assert.equal(source.pix_fmt, format);
    const output = join(scratch, `${codec}.mp4`);
    execute(ffmpeg, [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      ...image,
      "-movflags",
      "frag_keyframe+empty_moov",
      "-y",
      output,
    ]);
    const converted = decoded(output, picture.width, picture.height);
    assert.equal(converted.codec_name, "h264");
    assert.equal(converted.pix_fmt, "yuv420p");
    assert.equal(converted.sample_aspect_ratio, "1:1");
    return {
      file,
      source,
      converted,
      outputSha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
    };
  });
  console.log(
    JSON.stringify(
      {
        target,
        ffmpegSha256: createHash("sha256").update(readFileSync(ffmpeg)).digest("hex"),
        ffprobeSha256: createHash("sha256").update(readFileSync(ffprobe)).digest("hex"),
        build,
        required,
        image,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
