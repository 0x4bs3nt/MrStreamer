// Export is a public privacy contract: foreign fields and records must never leave the profile,
// and saving an inspected preview must not reread a later log.
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diagnosticsExporter,
  type DiagnosticsContext,
} from "../src/main/platform/diagnostics-export.ts";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
const context: DiagnosticsContext = {
  version: "0.0.9",
  commit: "a".repeat(40),
  channel: "stable",
  platform: "linux",
  arch: "x64",
  distribution: "direct",
  subscriptions: { xtream: 1, m3u: 2 },
  acceleratedVideoDecodeDisabled: false,
  checked: { at: 1791378000000, failure: "busy" },
};
const entry = (extra: object = {}) =>
  JSON.stringify({ at: "2026-10-07T12:00:00.000Z", op: "start", ms: 30, outcome: "ok", ...extra }) +
  "\n";
async function setup(build = context) {
  const folder = await mkdtemp(join(tmpdir(), "mrstreamer-export-"));
  folders.push(folder);
  return { folder, exporter: diagnosticsExporter(folder, async () => build) };
}

describe("a local diagnostics export", () => {
  it("keeps only known fields and values, including on damaged and older logs", async () => {
    const { folder, exporter } = await setup({
      ...context,
      version: "/private/viewer/provider-password",
      commit: "secret-token",
      platform: "secret-host",
    });
    await writeFile(
      join(folder, "diagnostics.1.log"),
      entry({
        login: "provider-password",
        url: "https://private-provider/secret-token",
        path: "/private/viewer",
        name: "Private film",
      }),
    );
    await writeFile(
      join(folder, "diagnostics.log"),
      "not JSON\n" +
        entry({ outcome: "provider-password" }) +
        entry({ ms: "secret-token" }) +
        entry({ at: "/private/viewer" }) +
        entry({ op: "call", method: "https://private-provider" }) +
        entry({ op: "call", method: "updates.status", url: "https://private-provider" }) +
        entry({
          op: "update-source",
          source: "github",
          status: 403,
          remaining: 0,
          reset: 1791379000,
          retryAfter: null,
          response: "secret-token",
        }),
    );
    const report = await exporter.preview();
    expect(report.entries).toBe(3);
    for (const secret of [
      "provider-password",
      "secret-token",
      "https://private-provider",
      "/private/viewer",
      "Private film",
    ])
      expect(report.text).not.toContain(secret);
    expect(report.text).toContain('"method":"updates.status"');
    expect(report.text).toContain('"status":403');
    expect(report.text).toContain("Last update check:");
    expect(report.version).toBe("unknown");
  });

  it("bounds reads and entries, and saves the inspected snapshot until a new one replaces it", async () => {
    const { folder, exporter } = await setup();
    await writeFile(
      join(folder, "diagnostics.log"),
      "x".repeat(2 * 1024 * 1024) +
        "\n" +
        Array.from({ length: 700 }, (_, ms) => entry({ ms })).join(""),
    );
    const report = await exporter.preview();
    expect(report.entries).toBe(500);
    expect(report.text).not.toContain('"ms":199,');
    expect(report.text).toContain('"ms":200,');
    await appendFile(join(folder, "diagnostics.log"), entry({ ms: 900 }));
    expect(exporter.textOf(report.id)).toBe(report.text);
    expect(report.text).not.toContain('"ms":900,');
    const next = await exporter.preview();
    expect(exporter.textOf(report.id)).toBeNull();
    expect(exporter.textOf(next.id)).toContain('"ms":900,');
    expect(exporter.textOf("unknown")).toBeNull();
  });

  it("exports build and safe counts when no diagnostics exist", async () => {
    const { exporter } = await setup();
    const report = await exporter.preview();
    expect(report.entries).toBe(0);
    expect(report.subscriptions).toEqual({ xtream: 1, m3u: 2 });
    expect(report.text).toContain("Mr. Streamer 0.0.9");
    expect(report.text).toContain("Accelerated video decode disabled: false");
  });

  it("keeps valid recent operations when the log ends with unsupported records", async () => {
    const { folder, exporter } = await setup();
    await writeFile(
      join(folder, "diagnostics.log"),
      Array.from({ length: 600 }, (_, ms) => entry({ ms })).join("") +
        Array.from({ length: 500 }, () => entry({ op: "call", method: "old.removedMethod" })).join(
          "",
        ),
    );
    const report = await exporter.preview();
    expect(report.entries).toBe(500);
    expect(report.text).toContain('"ms":100,');
    expect(report.text).toContain('"ms":599,');
    expect(report.text).not.toContain("old.removedMethod");
  });
});

it("names pacman as the owner in an Arch diagnostics export", async () => {
  const { exporter } = await setup({ ...context, distribution: "pacman" });
  const preview = await exporter.preview();
  expect(preview.distribution).toBe("pacman");
  expect(preview.text).toContain("AUR (pacman)");
  expect(preview.text).not.toContain("Direct install");
});
