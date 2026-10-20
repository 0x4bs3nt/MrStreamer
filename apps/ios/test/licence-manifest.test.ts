import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinProblems, readManifest } from "../scripts/licence-manifest.ts";

// licences/manifest.json's version contract, as scripts/licences.ts and the native gate read it:
// a component's version is written once and must be what the file that really pins it holds.
// FFmpeg is the component whose pins are all in this repository, so CI can check them without
// the iOS install.

const app = join(import.meta.dirname, "..");
const MANIFEST = join(app, "licences/manifest.json");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The manifest with FFmpeg's raw entry changed by `edit`, read back as the generator reads it. */
function withFfmpeg(edit: (entry: { version: string; pins: { text: string }[] }) => void) {
  const raw = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    components: { name: string; version: string; pins: { text: string }[] }[];
  };
  const ffmpeg = raw.components.find((entry) => entry.name === "FFmpeg");
  if (!ffmpeg) throw new Error("No FFmpeg");
  edit(ffmpeg);
  const dir = mkdtempSync(join(tmpdir(), "licence-manifest-"));
  dirs.push(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(raw));
  return () => readManifest(join(dir, "manifest.json"));
}

const ffmpegOf = (manifest: ReturnType<typeof readManifest>) => {
  const entry = manifest.components.find((each) => each.name === "FFmpeg");
  if (!entry) throw new Error("No FFmpeg");
  return entry;
};

describe("the manifest's versions", () => {
  it("hold every component's version in a pin, and FFmpeg's pins hold today", () => {
    const manifest = readManifest();
    for (const entry of manifest.components) {
      expect(
        entry.pins.some((pin) => pin.text.includes(entry.version)),
        entry.name,
      ).toBe(true);
    }
    const ffmpeg = ffmpegOf(manifest);
    expect(ffmpeg.source).toContain(`ffmpeg-${ffmpeg.version}.tar.xz`);
    expect(new Set(ffmpeg.texts.map((text) => text.ref))).toEqual(new Set([`n${ffmpeg.version}`]));
    expect(pinProblems(ffmpeg.name, ffmpeg.pins)).toEqual([]);
  });

  it("refuse a version the file that pins it doesn't hold, its source and texts following it", () => {
    const ffmpeg = ffmpegOf(
      withFfmpeg((entry) => {
        entry.version = "9.0.3";
      })(),
    );
    expect(ffmpeg.source).toContain("ffmpeg-9.0.3.tar.xz");
    expect(new Set(ffmpeg.texts.map((text) => text.ref))).toEqual(new Set(["n9.0.3"]));
    expect(pinProblems(ffmpeg.name, ffmpeg.pins)).toEqual([
      'scripts/build-ffmpeg.sh no longer has "FFMPEG_VERSION=9.0.3": FFmpeg changed. Update licences/manifest.json.',
    ]);
  });

  it("refuse a component that pins no version", () => {
    const read = withFfmpeg((entry) => {
      entry.pins = entry.pins.filter((pin) => !pin.text.includes("{version}"));
    });
    expect(read).toThrow(/FFmpeg in .* pin no version/);
  });
});
