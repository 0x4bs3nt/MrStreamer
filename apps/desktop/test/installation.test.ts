import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLanguage, setLanguage } from "@mrstreamer/core/i18n";
import { INSTALLATION_MARKER, PACMAN_INSTALLATION } from "@mrstreamer/contracts/updates";
import { installedDistribution } from "../src/main/platform/installation.ts";
import { tempDir } from "./support.ts";

afterEach(() => setLanguage(resolveLanguage("en-US", ["en-US"])));

describe("installation-owned updates", () => {
  it("explains marker recovery in the chosen interface language", async () => {
    const resources = await tempDir();
    await writeFile(join(resources, INSTALLATION_MARKER), "broken");
    setLanguage(resolveLanguage("nl-NL", ["en-US"]));
    await expect(
      installedDistribution({ resources, platform: "linux", packaged: true, store: false }),
    ).rejects.toThrow("Installeer Mr. Streamer opnieuw met je pakketbeheerder.");
  });
  it("keeps an ordinary packaged Linux install direct, including electron-builder's package-type", async () => {
    const resources = await tempDir();
    await writeFile(join(resources, "package-type"), "deb");
    expect(
      await installedDistribution({ resources, platform: "linux", packaged: true, store: false }),
    ).toBe("direct");
    await writeFile(join(resources, INSTALLATION_MARKER), JSON.stringify(PACMAN_INSTALLATION));
    expect(
      await installedDistribution({ resources, platform: "linux", packaged: true, store: false }),
    ).toBe("pacman");
  });

  it.each([
    { platform: "linux", packaged: false, store: false, expected: "direct" },
    { platform: "darwin", packaged: true, store: false, expected: "direct" },
    { platform: "win32", packaged: true, store: false, expected: "direct" },
    { platform: "win32", packaged: true, store: true, expected: "store" },
  ])(
    "keeps $platform packaged=$packaged store=$store ownership",
    async ({ expected, ...options }) => {
      const resources = await tempDir();
      await writeFile(join(resources, INSTALLATION_MARKER), "damaged");
      expect(await installedDistribution({ resources, ...options })).toBe(expected);
    },
  );

  it.each([
    "broken",
    "null",
    "{}",
    '{"schema":2,"updates":"pacman"}',
    '{"schema":1,"updates":"direct"}',
  ])("refuses a present invalid marker: %s", async (contents) => {
    const resources = await tempDir();
    await writeFile(join(resources, INSTALLATION_MARKER), contents);
    await expect(
      installedDistribution({ resources, platform: "linux", packaged: true, store: false }),
    ).rejects.toThrow("Reinstall Mr. Streamer with your package manager.");
  });

  it("refuses an unreadable marker rather than enabling a direct updater", async () => {
    const resources = await tempDir();
    await mkdir(join(resources, INSTALLATION_MARKER));
    await expect(
      installedDistribution({ resources, platform: "linux", packaged: true, store: false }),
    ).rejects.toThrow("Cannot read");
  });
});

it("treats a dangling installation marker as present and unreadable", async () => {
  const resources = await tempDir();
  await symlink(
    join(resources, "missing-target"),
    join(resources, INSTALLATION_MARKER),
    "junction",
  );
  await expect(
    installedDistribution({ resources, platform: "linux", packaged: true, store: false }),
  ).rejects.toThrow("Cannot read");
});
