import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { announceRelease } from "../scripts/discord-release.ts";

const release = {
  CHANNEL: "stable",
  VERSION: "0.0.21",
  TAG: "v0.0.21",
  GITHUB_REPOSITORY: "Mr-Streamer-OSS/MrStreamer",
};

async function discord(status = 200) {
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ path: request.url!, body: JSON.parse(body) });
    if (status) response.writeHead(status).end("private response must not be logged");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url, requests };
}

afterEach(() => vi.restoreAllMocks());

describe("Discord release announcements", () => {
  it.each([
    ["stable", "0.0.21", "Stable", "/stable"],
    ["nightly", "0.0.21-nightly.20261026.400", "Nightly preview", "/nightly"],
  ])(
    "delivers %s to its channel with notes/downloads and no mentions",
    async (channel, version, label, path) => {
      const target = await discord();
      await announceRelease({
        ...release,
        CHANNEL: channel,
        VERSION: version,
        TAG: `v${version}`,
        DISCORD_STABLE_WEBHOOK_URL: `${target.url}/stable`,
        DISCORD_NIGHTLY_WEBHOOK_URL: `${target.url}/nightly`,
      });
      expect(target.requests).toEqual([
        {
          path: `${path}?wait=true`,
          body: {
            content: `Mr. Streamer ${label} ${version}\nNotes and downloads: https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v${version}`,
            allowed_mentions: { parse: [] },
          },
        },
      ]);
    },
  );

  it("clearly labels a setup test without changing mention suppression", async () => {
    const target = await discord();
    await announceRelease({ ...release, DISCORD_STABLE_WEBHOOK_URL: target.url }, { test: true });
    expect(target.requests[0]?.body).toMatchObject({
      content: expect.stringContaining("[Setup test] Mr. Streamer Stable"),
      allowed_mentions: { parse: [] },
    });
  });

  it("warns for missing stable configuration without falling back to nightly", async () => {
    const target = await discord();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await announceRelease({ ...release, DISCORD_NIGHTLY_WEBHOOK_URL: target.url });
    expect(target.requests).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^::warning::.*DISCORD_STABLE/));
  });

  it.each([429, 0])(
    "warns without failing or retrying HTTP %i (0 is an ambiguous timeout)",
    async (status) => {
      const target = await discord(status);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(
        announceRelease(
          { ...release, DISCORD_STABLE_WEBHOOK_URL: `${target.url}/private-token` },
          { timeoutMs: 100 },
        ),
      ).resolves.toBeUndefined();
      expect(target.requests).toHaveLength(1);
      const output = log.mock.calls.flat().join("\n");
      expect(output).toMatch(/^::warning::Discord:/);
      expect(output).not.toContain("private");
      expect(output).not.toContain(target.url);
    },
  );

  it("warns privately for a malformed webhook secret", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      announceRelease({ ...release, DISCORD_STABLE_WEBHOOK_URL: "not a URL with private-token" }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^::warning::Discord:/));
    expect(log.mock.calls.flat().join("\n")).not.toContain("private-token");
  });
});
