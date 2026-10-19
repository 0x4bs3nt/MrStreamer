import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installedMedia, readTarget } from "./e2e/installed-media.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pins = {
  executable: "1".repeat(64),
  asar: "2".repeat(64),
  main: "3".repeat(64),
  ffmpeg: "4".repeat(64),
  ffprobe: "5".repeat(64),
};
const target = () => ({
  platform: process.platform,
  executable: process.execPath,
  resources: tmpdir(),
  version: "0.0.16-nightly.20261018.387",
  source: "a".repeat(40),
  pins,
});

describe("installed media public preflight", () => {
  it("accepts only an explicit current-platform identity and complete SHA-256 pins", () => {
    expect(readTarget(target())).toEqual(target());
    for (const invalid of [
      { ...target(), command: "anything" },
      { ...target(), platform: process.platform === "linux" ? "darwin" : "linux" },
      { ...target(), executable: "relative-app" },
      { ...target(), source: "short" },
      { ...target(), pins: { ...pins, main: "short" } },
      { ...target(), pins: { ...pins, extra: "0".repeat(64) } },
    ])
      expect(() => readTarget(invalid)).toThrow();
  });

  it("retains a failed receipt with zero spawns for untrusted installed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "installed media preflight "));
    try {
      const resources = join(root, "Resources");
      await mkdir(resources);
      await mkdir(join(resources, "ffmpeg"));
      // A tiny ASAR exercises the actual packed-main reader, without a fake app/engine.
      const main = Buffer.from("export {};\n");
      const manifest = Buffer.from(
        JSON.stringify({
          files: {
            out: {
              files: {
                main: {
                  files: {
                    "index.js": {
                      offset: "0",
                      size: main.length,
                      integrity: { algorithm: "SHA256", hash: sha256(main) },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      const headerSize = 8 + Math.ceil(manifest.length / 4) * 4;
      const header = Buffer.alloc(8 + headerSize);
      header.writeUInt32LE(4, 0);
      header.writeUInt32LE(headerSize, 4);
      header.writeUInt32LE(headerSize - 4, 8);
      header.writeUInt32LE(manifest.length, 12);
      manifest.copy(header, 16);
      const asar = Buffer.concat([header, main]);
      await writeFile(join(resources, "app.asar"), asar);
      for (const tool of ["ffmpeg", "ffprobe"])
        await writeFile(join(resources, "ffmpeg", tool), "fixture tool");
      const file = join(root, "target.json");
      await writeFile(
        file,
        JSON.stringify({
          ...target(),
          executable: await realpath(process.execPath),
          resources: await realpath(resources),
        }),
      );
      const out = join(root, "evidence-run");
      // Windows rejects manual targets before touching any installed program.
      const previous = process.env["RUNNER_TEMP"];
      if (process.platform === "win32") process.env["RUNNER_TEMP"] = root;
      try {
        expect(await installedMedia(["--target", file, "--out", out])).toBe(1);
        const receipt = JSON.parse(await readFile(join(out, "evidence", "proof.json"), "utf8")) as {
          outcome: string;
          spawns: number;
          details: { error: string };
        };
        expect(receipt.outcome).toBe("failed");
        expect(receipt.spawns).toBe(0);
        expect(receipt.details.error).toContain(
          process.platform === "win32" ? "POSIX-only" : "pins differ",
        );
        const before = await readFile(join(out, "evidence", "proof.json"), "utf8");
        await expect(installedMedia(["--target", file, "--out", out])).rejects.toThrow();
        expect(await readFile(join(out, "evidence", "proof.json"), "utf8")).toBe(before);
      } finally {
        if (previous === undefined) delete process.env["RUNNER_TEMP"];
        else process.env["RUNNER_TEMP"] = previous;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a failure receipt for crossed platform modes without a spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "installed media mode "));
    const previous = process.env["RUNNER_TEMP"];
    if (process.platform === "win32") process.env["RUNNER_TEMP"] = root;
    try {
      const out = join(root, "out");
      expect(
        await installedMedia([
          process.platform === "win32" ? "--target" : "--packages",
          root,
          "--out",
          out,
        ]),
      ).toBe(1);
      const receipt = JSON.parse(await readFile(join(out, "evidence", "proof.json"), "utf8")) as {
        outcome: string;
        spawns: number;
      };
      expect(receipt).toMatchObject({ outcome: "failed", spawns: 0 });
    } finally {
      if (previous === undefined) delete process.env["RUNNER_TEMP"];
      else process.env["RUNNER_TEMP"] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
