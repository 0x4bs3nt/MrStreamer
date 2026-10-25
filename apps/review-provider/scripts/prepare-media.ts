import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import {
  ARTWORK,
  ORIGINALS,
  SOURCE_COMMIT,
  validateMedia,
  type MediaIndex,
  type MediaId,
  type ObjectFact,
  type ProgrammeMedia,
  type RenditionId,
  type Segment,
} from "../src/catalogue.ts";

// Offline preparation only. No fetch, Cloudflare client, installation or deployment.
// Existing stages/indexes are never overwritten; a failure keeps its evidence.
process.umask(0o077);
const root = fileURLToPath(new NodeURL("../../../", import.meta.url));
const originalRoot = join(root, "apps/ios/demo-media");
const generated = join(root, "apps/review-provider/generated/media.json");
const stageArg = process.argv[2];
if (
  process.argv.length !== 3 ||
  !stageArg ||
  !isAbsolute(stageArg) ||
  existsSync(stageArg) ||
  existsSync(generated)
) {
  throw new Error(
    "Give one new absolute private stage path; neither it nor generated/media.json may exist",
  );
}
const stage = join(realpathSync(dirname(stageArg)), stageArg.slice(dirname(stageArg).length + 1));
mkdirSync(stage, { mode: 0o700 });
const provenance = join(stage, "provenance");
mkdirSync(provenance, { mode: 0o700 });
const commands: {
  command: string;
  args: readonly string[];
  exit: number | null;
  signal: string | null;
}[] = [];
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
let sequence = 0;

function save(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
}

/** One synchronous child at a time, hard timeout, bounded output, no shell. */
function run(command: "ffmpeg" | "ffprobe", args: readonly string[], label: string): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, AV_LOG_FORCE_NOCOLOR: "1" },
  });
  const name = `${String(++sequence).padStart(4, "0")}-${label}`;
  save(join(provenance, `${name}.stdout`), result.stdout ?? "");
  save(join(provenance, `${name}.stderr`), result.stderr ?? "");
  commands.push({ command, args, exit: result.status, signal: result.signal });
  writeFileSync(join(provenance, "commands.json"), JSON.stringify(commands, null, 2) + "\n", {
    mode: 0o600,
  });
  if (
    result.error ||
    result.status !== 0 ||
    (command === "ffprobe" && (result.stderr ?? "").trim())
  ) {
    throw new Error(`Preparation command failed; see ${name} evidence`);
  }
  return result.stdout;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Invalid probe object");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Missing probe list");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing probe text");
  return value;
}
function numeric(value: unknown): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) throw new Error("Missing probe number");
  return n;
}
const ticks = (value: unknown) => Math.round(numeric(value) * 90000);

function probe(path: string, label: string) {
  const raw: unknown = JSON.parse(
    run(
      "ffprobe",
      [
        "-v",
        "error",
        "-threads",
        "1",
        "-count_frames",
        "-show_streams",
        "-show_packets",
        "-show_data_hash",
        "sha256",
        "-of",
        "json",
        path,
      ],
      label,
    ),
  );
  const result = object(raw);
  const streams = list(result.streams).map(object);
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video || !audio || streams.length !== 2)
    throw new Error("Expected one video and one audio stream");
  const packets = list(result.packets).map((p) => {
    const row = object(p);
    return {
      stream: numeric(row.stream_index),
      pts: ticks(row.pts_time),
      duration: ticks(row.duration_time),
      hash: text(row.data_hash),
      flags: text(row.flags),
    };
  });
  return {
    video: {
      codec: text(video.codec_name),
      width: numeric(video.width),
      height: numeric(video.height),
      frameRate: text(video.r_frame_rate),
      frames: numeric(video.nb_read_frames),
      packets: packets.filter((p) => p.stream === numeric(video.index)),
    },
    audio: {
      codec: text(audio.codec_name),
      rate: numeric(audio.sample_rate),
      channels: numeric(audio.channels),
      packets: packets.filter((p) => p.stream === numeric(audio.index)),
    },
  };
}

function firstVideoNals(path: string, label: string): Uint8Array[] {
  const raw: unknown = JSON.parse(
    run(
      "ffprobe",
      [
        "-v",
        "error",
        "-threads",
        "1",
        "-select_streams",
        "v:0",
        "-read_intervals",
        "%+#1",
        "-show_packets",
        "-show_data",
        "-of",
        "json",
        path,
      ],
      label,
    ),
  );
  const packet = list(object(raw).packets)[0];
  const dump = text(object(packet).data);
  const hex = dump
    .split("\n")
    .flatMap((line) => {
      const part = /^[0-9a-f]+:\s(.+)$/.exec(line)?.[1];
      if (!part) return [];
      return part.split(/\s{2,}/)[0]?.replace(/\s/g, "") ?? [];
    })
    .join("");
  const data = Buffer.from(hex, "hex");
  const starts: { offset: number; payload: number }[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push({ offset: i, payload: i + 3 });
      i += 2;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      starts.push({ offset: i, payload: i + 4 });
      i += 3;
    }
  }
  return starts.map((s, i) => data.subarray(s.payload, starts[i + 1]?.offset ?? data.length));
}

function objectFile(path: string, key: string, mime: ObjectFact["mime"]): ObjectFact {
  return { key, bytes: statSync(path).size, sha256: sha(readFileSync(path)), mime };
}

function copiedOriginal(filename: string, expected: string, mime: ObjectFact["mime"]): ObjectFact {
  const input = join(originalRoot, filename);
  if (sha(readFileSync(input)) !== expected)
    throw new Error(`Frozen R107 input changed: ${filename}`);
  const key = `original/${expected}/${filename}`;
  const target = join(stage, "objects", key);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(input, target);
  return objectFile(target, key, mime);
}

function certifyPackets(
  packets: readonly { pts: number; duration: number }[],
  step: number,
  name: string,
): void {
  if (!packets.length) throw new Error(`No packets: ${name}`);
  for (const [at, packet] of packets.entries()) {
    const previous = packets[at - 1];
    if (
      packet.duration !== step ||
      (previous && Math.abs(packet.pts - previous.pts - previous.duration) > 1)
    ) {
      throw new Error(`Discontinuous ${name}`);
    }
  }
}

try {
  run("ffmpeg", ["-version"], "ffmpeg-version");
  run("ffprobe", ["-version"], "ffprobe-version");
  const originals = {
    movie: copiedOriginal(ORIGINALS[0].filename, ORIGINALS[0].sha256, "video/mp4"),
    "episode-1": copiedOriginal(ORIGINALS[1].filename, ORIGINALS[1].sha256, "video/mp4"),
    "episode-2": copiedOriginal(ORIGINALS[2].filename, ORIGINALS[2].sha256, "video/mp4"),
  };
  const artwork = {
    "movie-cover": copiedOriginal("movie-cover.png", ARTWORK[0].sha256, "image/png"),
    "movie-backdrop": copiedOriginal("movie-backdrop.png", ARTWORK[1].sha256, "image/png"),
    "series-cover": copiedOriginal("series-cover.png", ARTWORK[2].sha256, "image/png"),
    "series-backdrop": copiedOriginal("series-backdrop.png", ARTWORK[3].sha256, "image/png"),
  };
  const segments: Segment[] = [];
  const programmes: ProgrammeMedia[] = [];
  const codecs = new Map<RenditionId, string>();
  const outputPaths = new Map<string, string>();
  const audioEvidence: {
    id: MediaId;
    rendition: RenditionId;
    firstEdgeTicks: number;
    lastEdgeTicks: number;
    accessUnitsSha256: string;
    packets: number;
    videoTimelineSha256: string;
    firstVideoPtsTicks: number;
    lastVideoEndTicks: number;
  }[] = [];

  for (const original of ORIGINALS) {
    const input = join(originalRoot, original.filename);
    const source = probe(input, `${original.id}-original`);
    if (
      source.video.codec !== "h264" ||
      source.video.frameRate !== "24/1" ||
      source.video.frames !== original.frames ||
      source.video.width !== 960 ||
      source.video.height !== 540 ||
      source.audio.codec !== "aac" ||
      source.audio.rate !== 48000 ||
      source.audio.channels !== 2
    )
      throw new Error("Original track facts do not match R107");
    const work = join(stage, "prepared", original.id);
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const audio = join(work, "shared.aac");
    // Copy the original AAC once. Its actual packet presentation edges, not MP4
    // edit-list/container duration, are certified after muxing into TS below.
    run(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-threads",
        "1",
        "-i",
        input,
        "-map",
        "0:a:0",
        "-c:a",
        "copy",
        "-map_metadata",
        "-1",
        "-f",
        "adts",
        audio,
      ],
      `${original.id}-shared-aac`,
    );
    const perRendition = new Map<RenditionId, ObjectFact[]>();
    let sharedAudioHash: string | undefined;
    let sharedVideoTimeline: string | undefined;
    let programmeEdges: { first: number; last: number } | undefined;
    for (const rendition of ["540p", "180p"] as const) {
      const folder = join(work, rendition);
      mkdirSync(folder, { mode: 0o700 });
      const videoArgs =
        rendition === "540p"
          ? ["-c:v", "copy"]
          : [
              "-vf",
              "scale=320:180:flags=bicubic",
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-tune",
              "zerolatency",
              "-profile:v",
              "baseline",
              "-level:v",
              "3.1",
              "-pix_fmt",
              "yuv420p",
              "-r",
              "24",
              "-fps_mode",
              "cfr",
              "-b:v",
              "48k",
              "-maxrate",
              "56k",
              "-bufsize",
              "112k",
              "-g",
              "48",
              "-keyint_min",
              "48",
              "-sc_threshold",
              "0",
              "-threads:v",
              "1",
              "-x264-params",
              "threads=1:lookahead_threads=1:rc-lookahead=0:sync-lookahead=0",
            ];
      run(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-filter_complex_threads",
          "1",
          "-i",
          input,
          "-threads",
          "1",
          "-i",
          audio,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          ...videoArgs,
          "-c:a",
          "copy",
          "-map_metadata",
          "-1",
          "-metadata:s:a:0",
          "language=und",
          "-muxdelay",
          "0",
          "-muxpreload",
          "0",
          "-hls_time",
          "6",
          "-hls_list_size",
          "0",
          "-hls_playlist_type",
          "vod",
          "-hls_flags",
          "independent_segments+temp_file",
          "-hls_segment_type",
          "mpegts",
          "-hls_segment_filename",
          join(folder, "%03d.ts"),
          join(folder, "prepared.m3u8"),
        ],
        `${original.id}-${rendition}-mux`,
      );
      const manifest = readFileSync(join(folder, "prepared.m3u8"), "utf8");
      const entries = manifest.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
      const extinf = [...manifest.matchAll(/^#EXTINF:([\d.]+),/gm)].map((m) => Number(m[1]));
      if (
        entries.length !== original.frames / 144 ||
        extinf.length !== entries.length ||
        extinf.some((s) => s !== 6)
      ) {
        throw new Error("Prepared HLS video EXTINF/count changed; do not alter programme clock");
      }
      const facts: ObjectFact[] = [];
      const videoPackets: { pts: number; duration: number }[] = [];
      const audioPackets: { pts: number; duration: number; hash: string }[] = [];
      for (const [i, filename] of entries.entries()) {
        if (!/^\d{3}\.ts$/.test(filename)) throw new Error("Unexpected prepared segment path");
        const path = join(folder, filename);
        const proof = probe(path, `${original.id}-${rendition}-${i}-decode-packets`);
        const expectedWidth = rendition === "540p" ? 960 : 320;
        const expectedHeight = rendition === "540p" ? 540 : 180;
        if (
          proof.video.codec !== "h264" ||
          proof.video.frames !== 144 ||
          proof.video.frameRate !== "24/1" ||
          proof.video.width !== expectedWidth ||
          proof.video.height !== expectedHeight ||
          proof.audio.codec !== "aac" ||
          proof.audio.rate !== 48000 ||
          proof.audio.channels !== 2
        ) {
          throw new Error("Prepared segment track/frame certification failed");
        }
        const nals = firstVideoNals(path, `${original.id}-${rendition}-${i}-idr`);
        const firstVcl = nals.find(
          (n) => n[0] !== undefined && (n[0] & 31) >= 1 && (n[0] & 31) <= 5,
        );
        const sps = nals.find((n) => n[0] !== undefined && (n[0] & 31) === 7);
        if (!firstVcl || (firstVcl[0]! & 31) !== 5 || !sps || sps.length < 4)
          throw new Error("Segment does not begin with certified IDR/SPS");
        const codec = `avc1.${Buffer.from(sps.subarray(1, 4)).toString("hex")},mp4a.40.2`;
        if (codecs.has(rendition) && codecs.get(rendition) !== codec)
          throw new Error("Codec changes within cycle");
        codecs.set(rendition, codec);
        certifyPackets(proof.video.packets, 3750, "segment video");
        videoPackets.push(...proof.video.packets);
        audioPackets.push(...proof.audio.packets);
        const provisionalKey = `${original.id}/${rendition}/${filename}`;
        facts.push(objectFile(path, provisionalKey, "video/mp2t"));
        outputPaths.set(provisionalKey, path);
      }
      certifyPackets(videoPackets, 3750, "programme video");
      certifyPackets(audioPackets, 1920, "programme audio");
      const videoTimeline = sha(JSON.stringify(videoPackets.map((p) => [p.pts, p.duration])));
      if (sharedVideoTimeline && sharedVideoTimeline !== videoTimeline)
        throw new Error("Actual video PTS differ between renditions");
      sharedVideoTimeline = videoTimeline;
      const firstVideo = videoPackets[0]!;
      const lastVideo = videoPackets.at(-1)!;
      const firstAudio = audioPackets[0]!;
      const lastAudio = audioPackets.at(-1)!;
      if (
        videoPackets.length !== original.frames ||
        lastVideo.pts + lastVideo.duration - firstVideo.pts !== original.frames * 3750
      ) {
        throw new Error("Video programme clock failed");
      }
      const edges = {
        first: firstAudio.pts - firstVideo.pts,
        last: lastAudio.pts + lastAudio.duration - lastVideo.pts - lastVideo.duration,
      };
      if (Math.abs(edges.first) > 3840 || Math.abs(edges.last) > 3840) {
        save(
          join(provenance, `${original.id}-${rendition}-audio-edge-failure.json`),
          JSON.stringify(edges, null, 2),
        );
        throw new Error(
          "AAC edge exceeds 2048-sample bound; return measured facts, do not change clock",
        );
      }
      const audioHash = sha(JSON.stringify(audioPackets.map((p) => [p.hash, p.pts, p.duration])));
      if (
        sharedAudioHash &&
        (sharedAudioHash !== audioHash ||
          programmeEdges?.first !== edges.first ||
          programmeEdges?.last !== edges.last)
      ) {
        throw new Error("Renditions do not mux identical shared AAC access units/timestamps");
      }
      sharedAudioHash = audioHash;
      programmeEdges = edges;
      audioEvidence.push({
        id: original.id,
        rendition,
        firstEdgeTicks: edges.first,
        lastEdgeTicks: edges.last,
        accessUnitsSha256: audioHash,
        packets: audioPackets.length,
        videoTimelineSha256: videoTimeline,
        firstVideoPtsTicks: firstVideo.pts,
        lastVideoEndTicks: lastVideo.pts + lastVideo.duration,
      });
      perRendition.set(rendition, facts);
    }
    if (!sharedAudioHash || !programmeEdges) throw new Error("Missing shared audio certification");
    programmes.push({
      id: original.id,
      videoFrames: original.frames,
      audio: {
        accessUnitsSha256: sharedAudioHash,
        firstEdgeTicks: programmeEdges.first,
        lastEdgeTicks: programmeEdges.last,
        continuous: true,
      },
    });
    const high = perRendition.get("540p")!;
    const low = perRendition.get("180p")!;
    for (const [i, fact] of high.entries()) {
      const other = low[i];
      if (!other) throw new Error("Rendition segment counts differ");
      segments.push({
        programme: original.id,
        frames: 144,
        videoDurationTicks: 540000,
        files: { "540p": fact, "180p": other },
      });
    }
  }
  const release = `r107-${sha(JSON.stringify(segments.map((s) => [s.files["540p"].sha256, s.files["180p"].sha256]))).slice(0, 20)}`;
  const finalSegments = segments.map((s) => {
    function materialize(fact: ObjectFact): ObjectFact {
      const source = outputPaths.get(fact.key);
      if (!source) throw new Error("Missing prepared path");
      const key = `hls/${release}/${fact.key}`;
      const target = join(stage, "objects", key);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      return { ...fact, key };
    }
    return {
      ...s,
      files: { "540p": materialize(s.files["540p"]), "180p": materialize(s.files["180p"]) },
    };
  });
  const renditions = (["540p", "180p"] as const).map((id) => {
    const bytes = finalSegments.map((s) => s.files[id].bytes);
    const codec = codecs.get(id);
    if (!codec) throw new Error("Missing measured codec");
    return {
      id,
      width: id === "540p" ? 960 : 320,
      height: id === "540p" ? 540 : 180,
      frameRate: 24,
      codecs: codec,
      bandwidth: Math.ceil((Math.max(...bytes) * 8) / 6),
      averageBandwidth: Math.ceil((bytes.reduce((sum, n) => sum + n, 0) * 8) / 330),
    };
  });
  const media: MediaIndex = {
    version: 1,
    sourceCommit: SOURCE_COMMIT,
    release,
    originals,
    artwork,
    programmes,
    renditions,
    segments: finalSegments,
  };
  save(join(stage, "measured-candidate.json"), JSON.stringify(media, null, 2) + "\n");
  save(join(stage, "audio-certification.json"), JSON.stringify(audioEvidence, null, 2) + "\n");
  validateMedia(media);
  const objects = [
    ...Object.values(originals),
    ...Object.values(artwork),
    ...finalSegments.flatMap((s) => Object.values(s.files)),
  ];
  for (const fact of objects) {
    if (sha(readFileSync(join(stage, "objects", fact.key))) !== fact.sha256)
      throw new Error("Stage copy hash changed");
  }
  const json = JSON.stringify(media, null, 2) + "\n";
  save(join(stage, "media.json"), json);
  save(
    join(stage, "SHA256SUMS"),
    objects.map((f) => `${f.sha256}  objects/${f.key}`).join("\n") + "\n",
  );
  save(
    join(stage, "receipt.json"),
    JSON.stringify(
      {
        sourceCommit: SOURCE_COMMIT,
        release,
        mediaIndexSha256: sha(json),
        objects: objects.length,
        programmeSeconds: ORIGINALS.map((o) => o.frames / 24),
        videoClockTicks: 29700000,
        targetDuration: 6,
        audioEdgeBoundTicks: 3840,
        renditions,
        commands: commands.length,
        sourceRoot: relative(stage, originalRoot),
        licence: "GPL-3.0-only; source/provenance apps/ios/demo-media at sourceCommit",
        runtimeAcceptance: "local preparation only; no deployed or native acceptance",
      },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(dirname(generated), { recursive: true });
  writeFileSync(generated, json, { flag: "wx" });
  console.log(
    `Prepared ${release}; index and ${objects.length} immutable objects retained in the owned stage.`,
  );
} catch (cause) {
  const message = cause instanceof Error ? cause.message : "Unknown preparation failure";
  save(
    join(stage, "FAILED.txt"),
    message +
      "\nPartial outputs/provenance retained. No index committed or remote write performed.\n",
  );
  throw new Error(message);
}
