// Six-second clear muxed epochs with different video/audio/PCR PIDs and codec parameters.
// The generated picture, two sounds, DVB subtitles, teletext and captions come from the existing
// synthetic subtitle clip. No provider media is used.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const root = join(import.meta.dirname, "../test/fixtures");
for (const epoch of [0, 1]) {
  execFileSync(process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg", [
    "-v",
    "error",
    "-y",
    "-stream_loop",
    "2",
    "-i",
    join(root, "h264-subtitles.mpegts"),
    "-t",
    "6",
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-map",
    "0:a:1",
    "-map",
    "0:s?",
    "-c:v",
    epoch ? "libx264" : "mpeg2video",
    "-g",
    "25",
    "-bf",
    "0",
    "-vf",
    epoch ? "scale=320:180" : "scale=256:144",
    ...(epoch ? ["-preset", "veryfast", "-tune", "zerolatency"] : []),
    "-c:a",
    "ac3",
    "-ac",
    "2",
    "-ar",
    epoch ? "48000" : "44100",
    "-c:s",
    "copy",
    ...[0, 1, 2, 3, 4].flatMap((index) => ["-streamid", `${index}:${(epoch ? 512 : 256) + index}`]),
    "-mpegts_pmt_start_pid",
    String(epoch ? 4097 : 4096),
    "-f",
    "mpegts",
    join(root, `hls-epoch-${epoch}.mpegts`),
  ]);
}
