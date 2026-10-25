// A partial capture run records each new master without replacing unrelated provenance.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordCapture,
  type CaptureEntry,
  type CaptureName,
} from "../scripts/marketing-captures.ts";

describe("recording a master", () => {
  let folder = "";
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  const entry = (name: CaptureName, sha256: string): CaptureEntry => ({
    name,
    file: `marketing-${name}.png`,
    width: 2560,
    height: 1600,
    bytes: 100,
    sha256,
    videoBox: null,
  });

  it("replaces only the selected captures' entries, each as soon as it is written", () => {
    folder = mkdtempSync(join(tmpdir(), "marketing-captures-"));
    const file = join(folder, "marketing-capture.json");
    const before = {
      capturedAt: "2026-10-11T09:28:01.610Z",
      appSource: "7b54b526",
      captures: [entry("library", "old-library"), entry("live-tv", "old-live-tv")],
    };
    writeFileSync(file, JSON.stringify(before, null, 2) + "\n");
    const read = () => JSON.parse(readFileSync(file, "utf8"));

    recordCapture(file, entry("tv-guide", "new-guide"), { appSource: "401072a1" });
    // A later stage failing here leaves the new master's hash already recorded.
    expect(read()).toEqual({
      ...before,
      captures: [
        ...before.captures,
        { ...entry("tv-guide", "new-guide"), provenance: { appSource: "401072a1" } },
      ],
    });

    recordCapture(file, entry("live-tv", "new-live-tv"), { appSource: "401072a1" });
    expect(read()).toEqual({
      ...before,
      captures: [
        entry("library", "old-library"),
        { ...entry("live-tv", "new-live-tv"), provenance: { appSource: "401072a1" } },
        { ...entry("tv-guide", "new-guide"), provenance: { appSource: "401072a1" } },
      ],
    });
  });
});
