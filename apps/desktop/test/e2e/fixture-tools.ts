// Host-side fixture tools. The installed app keeps resolving its own packaged binaries.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

function sha256(path: string) {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/** An external smoke process lacks MSIX identity. Run exact verified copies outside WindowsApps. */
export function fixtureTools(ffmpeg: string, scratch: string) {
  const source = {
    ffmpeg,
    ffprobe: join(
      dirname(ffmpeg),
      ffmpeg.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe",
    ),
  };
  const hashes = { ffmpeg: sha256(source.ffmpeg), ffprobe: sha256(source.ffprobe) };
  const copied = /[\\/]WindowsApps[\\/]/i.test(ffmpeg);
  const directory = join(scratch, "fixture-tools");
  const tools = copied
    ? {
        ffmpeg: join(directory, basename(source.ffmpeg)),
        ffprobe: join(directory, basename(source.ffprobe)),
      }
    : source;
  if (copied) {
    mkdirSync(directory, { recursive: true });
    for (const name of ["ffmpeg", "ffprobe"] as const) {
      if (!hashes[name]) throw new Error(`Cannot read installed fixture tool: ${source[name]}`);
      // Fresh owned files inherit the profile's access, not package filesystem attributes.
      writeFileSync(tools[name], readFileSync(source[name]), { mode: 0o700 });
      if (sha256(tools[name]) !== hashes[name])
        throw new Error(`Copied fixture tool hash differs: ${name}`);
    }
  }
  return { ...tools, source, sha256: hashes, copiedFromWindowsApps: copied };
}
