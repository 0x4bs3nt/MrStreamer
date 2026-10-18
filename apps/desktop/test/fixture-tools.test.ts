import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixtureTools } from "./e2e/fixture-tools.ts";
import { tempDir } from "./support.ts";

it("prepares byte-identical host fixture tools outside WindowsApps without modifying the package", async () => {
  const root = await tempDir();
  const installed = join(root, "WindowsApps", "Mr.Streamer", "app", "resources", "ffmpeg");
  const scratch = join(root, "profile");
  const videoTool = Buffer.from("installed static FFmpeg fixture tool");
  const probeTool = Buffer.from("installed static ffprobe fixture tool");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "ffmpeg.exe"), videoTool);
  await writeFile(join(installed, "ffprobe.exe"), probeTool);
  const tools = fixtureTools(join(installed, "ffmpeg.exe"), scratch);
  expect(tools.copiedFromWindowsApps).toBe(true);
  for (const [name, bytes] of [
    ["ffmpeg", videoTool],
    ["ffprobe", probeTool],
  ] as const) {
    expect(tools[name].startsWith(scratch)).toBe(true);
    expect(tools[name]).not.toContain("WindowsApps");
    expect(await readFile(tools[name])).toEqual(bytes);
    expect(await readFile(tools.source[name])).toEqual(bytes);
    expect(tools.sha256[name]).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  await rm(scratch, { recursive: true });
  expect(await readFile(tools.source.ffmpeg)).toEqual(videoTool);
  expect(await readFile(tools.source.ffprobe)).toEqual(probeTool);
});
