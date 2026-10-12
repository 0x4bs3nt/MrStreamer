// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGES, renderMarkdown, renderPage, SITE } from "../scripts/pages.ts";
import {
  installers,
  LATEST,
  showDownloads,
  showFeedDownloads,
  writeDownloads,
  type Downloads,
} from "../src/downloads.ts";

const home = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
const released: Downloads = { version: "0.0.8", installers };
const open = (html: string) => {
  // These contracts are the readable static HTML. Do not fetch styles or execute page scripts.
  document.documentElement.innerHTML = html
    .replace(/<link rel="stylesheet"[^>]*>/g, "")
    .replace(/<script type="module"[^>]*><\/script>/g, "");
};
const appData = (): Record<string, unknown> =>
  JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}");
const links = () =>
  Object.fromEntries(
    [...document.querySelectorAll<HTMLAnchorElement>("a[data-installer]")].map((link) => [
      link.dataset["installer"],
      link.getAttribute("href"),
    ]),
  );

describe("public document pages without JavaScript", () => {
  it.each(PAGES.filter((page) => page.address !== "/"))(
    "has its own content and metadata at $address",
    (page) => {
      open(renderPage(page.file, null, null));
      expect(document.title).toBe(page.title);
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        SITE + page.address,
      );
      expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
        page.description,
      );
      expect(document.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(
        SITE + page.address,
      );
      expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
        page.title,
      );
      expect(document.querySelector("main h1")?.textContent?.length).toBeGreaterThan(0);
      expect(document.querySelector('footer a[href="/download"]')).not.toBeNull();
    },
  );

  it("keeps guide links and their fragments on the public site, including links in index summaries", () => {
    open(renderPage("docs/updates/index.html", null, null));
    expect(
      document.querySelector('a[href="/docs/updates#installed-from-the-microsoft-store"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('a[href="/docs/troubleshooting#where-your-data-is"]'),
    ).not.toBeNull();
    expect(document.querySelector('main a[href="https://mrstreamer.app/download"]')).not.toBeNull();
    expect(document.querySelectorAll(".other-guides li")).toHaveLength(6);
    open(renderPage("docs/index.html", null, null));
    expect(document.querySelectorAll(".guide-list dt a")).toHaveLength(7);
    expect(document.querySelector('a[href="/docs#installed-from-the-microsoft-store"]')).toBeNull();
  });

  it("offers the grouped FAQ and its working guide links without JavaScript", () => {
    open(renderPage("faq/index.html", null, null));
    expect([...document.querySelectorAll("main h2")].map((heading) => heading.textContent)).toEqual(
      ["Getting started", "Watching", "Installing and updates", "Price and privacy"],
    );
    expect(document.querySelectorAll(".faq-rows > div[id]")).toHaveLength(13);
    expect(document.querySelector("#download")?.textContent).toContain(
      "Download a movie or an episode",
    );
    expect(document.querySelector("#record")?.textContent).toContain("Live TV can't be recorded");
    expect(document.querySelector('main a[href="/docs/downloads"]')).not.toBeNull();
    expect(
      document.querySelector('main a[href="/docs/subscriptions#mapping-mixed-playlists"]'),
    ).not.toBeNull();
    expect(document.querySelector('nav a[href="/faq"][aria-current="page"]')).not.toBeNull();
    expect(document.querySelector('footer a[href="/faq"][aria-current="page"]')).not.toBeNull();
  });

  it("sends non-public documentation to the repository and renders untrusted notes safely", () => {
    open(
      renderMarkdown(
        "[Signing](../maintainers/signing.md#checking-a-build) [Privacy](../privacy.md#deleting-your-data)\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1)) ![Remote](https://example.com/image.png)",
        "docs/user/playback.md",
      ),
    );
    expect(
      document.querySelector(
        'a[href="https://github.com/Mr-Streamer-OSS/MrStreamer/blob/main/docs/maintainers/signing.md#checking-a-build"]',
      ),
    ).not.toBeNull();
    expect(document.querySelector('a[href="/privacy#deleting-your-data"]')).not.toBeNull();
    expect(document.querySelector("script, img")).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it.each(["## Fixes", "Fixes\n-----"])(
    "renders sourced notes with %s and a truthful unavailable fallback",
    (heading) => {
      open(
        renderPage("releases/index.html", null, [
          {
            version: "1.2.3",
            published: "2026-02-03T20:00:00Z",
            notes: `${heading}\n\n- A published change\n- [Details](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/1)\n- [This section](#fixes)\n\n\`\`\`sh\n# A shell comment\n\`\`\``,
            assets: [],
          },
        ]),
      );
      expect(document.querySelector("time")?.textContent).toBe("3 February 2026");
      expect(document.querySelector(".release li")?.textContent).toBe("A published change");
      expect(document.querySelector("details")).toBeNull();
      expect(document.querySelector('h3[id="v1.2.3-fixes"]')).not.toBeNull();
      expect(document.querySelector('a[href="/releases#v1.2.3-fixes"]')).not.toBeNull();
      open(renderPage("releases/index.html", null, null));
      expect(document.querySelector("main")?.textContent).toContain(
        "Release history is unavailable here.",
      );
      expect(document.querySelector(".release")).toBeNull();
    },
  );
});

describe("one stable download contract across pages and metadata", () => {
  it("keeps a freshly built release through an older cached feed but accepts a fresh withdrawal", () => {
    const verified = "2026-10-07T18:00:00Z";
    open(
      writeDownloads(
        renderPage("download/index.html", released, null),
        released,
        Date.parse(verified),
      ),
    );
    const before = document.documentElement.innerHTML;
    const feed = (generated: string, version: string) => ({
      schema: 1,
      generated,
      stable: {
        version,
        files: `https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v${version}`,
        installers: [`Mr-Streamer-${version}-mac-arm64.dmg`],
      },
    });
    showFeedDownloads(document, feed("2026-10-07T17:59:00Z", "0.0.7"));
    expect(document.documentElement.innerHTML).toBe(before);
    showFeedDownloads(document, feed("2026-10-07T18:01:00Z", "0.0.7"));
    expect(document.title).toBe("Download Mr. Streamer 0.0.7 for Mac, Windows and Linux");
    expect(document.querySelector("[data-release-version]")?.textContent).toBe("Version 0.0.7.");
    expect(links()["exe"]).toBe(LATEST);
    expect(links()["dmg"]).toContain("/v0.0.7/");
    open(writeDownloads(renderPage("download/index.html", null, null), null, Date.parse(verified)));
    showFeedDownloads(document, feed("2026-10-07T17:59:00Z", "0.0.8"));
    expect(document.title).toBe("Download Mr. Streamer for Mac, Windows and Linux");
    expect(Object.values(links()).every((link) => link === LATEST)).toBe(true);
  });

  it.each([{ available: [] }, { available: ["dmg", "exe", "appImage"] }] as const)(
    "repairs failed build-time installer checks from an older feed for the selected release: $available",
    ({ available }) => {
      const found: Downloads = { version: "0.0.8", installers: available };
      open(
        writeDownloads(
          renderPage("download/index.html", found, null),
          found,
          Date.parse("2026-10-07T18:00:00Z"),
        ),
      );
      expect(links()["deb"]).toBe(LATEST);
      showFeedDownloads(document, {
        schema: 1,
        generated: "2026-10-07T11:00:00Z",
        stable: {
          version: "0.0.8",
          files: "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download/v0.0.8",
          installers: [
            "Mr-Streamer-0.0.8-mac-arm64.dmg",
            "Mr-Streamer-0.0.8-win-x64-setup.exe",
            "Mr-Streamer-0.0.8-linux-x86_64.AppImage",
            "Mr-Streamer-0.0.8-linux-amd64.deb",
          ],
        },
      });
      expect(
        Object.values(links()).every(
          (link) => typeof link === "string" && link.includes("/v0.0.8/"),
        ),
      ).toBe(true);
      expect(document.title).toBe("Download Mr. Streamer 0.0.8 for Mac, Windows and Linux");
    },
  );
  it("links the same verified installers and the same release's checksums, notes and sources", () => {
    open(writeDownloads(home, released));
    const homepageLinks = links();
    expect(appData()["softwareVersion"]).toBe("0.0.8");
    expect(appData()["alternateName"]).toBe("Mr. Streamer: IPTV Player");
    expect(appData()["screenshot"]).toHaveLength(4);
    open(writeDownloads(renderPage("download/index.html", released, null), released));
    expect(links()).toEqual(homepageLinks);
    expect(document.title).toBe("Download Mr. Streamer 0.0.8 for Mac, Windows and Linux");
    expect(document.querySelector('[data-release-link="checksums"]')?.getAttribute("href")).toBe(
      "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.8#assets",
    );
    expect(document.querySelector('[data-release-link="source"]')?.getAttribute("href")).toBe(
      "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.8#assets",
    );
  });

  it("uses a versionless fallback when the feed or every installer is unavailable", () => {
    open(home);
    expect(appData()).not.toHaveProperty("softwareVersion");
    open(renderPage("download/index.html", null, null));
    expect(document.title).toBe("Download Mr. Streamer for Mac, Windows and Linux");
    expect(Object.values(links()).every((link) => link === LATEST)).toBe(true);
    open(writeDownloads(home, { version: "0.0.8", installers: [] }));
    expect(appData()).not.toHaveProperty("softwareVersion");
    expect(document.querySelector("[data-release-version]")?.textContent).toBe(
      "Stable release on GitHub.",
    );
  });

  it("moves the version, metadata and auxiliary links with the installers after a release or withdrawal", () => {
    for (const later of [
      { version: "0.0.9", installers },
      { version: "0.0.7", installers: ["dmg"] as const },
      { version: "0.0.9", installers: [] },
    ]) {
      open(writeDownloads(renderPage("download/index.html", released, null), released));
      showDownloads(document, later);
      const refreshed = document.documentElement.innerHTML;
      open(writeDownloads(renderPage("download/index.html", later, null), later));
      expect(document.documentElement.innerHTML).toBe(refreshed);
      open(writeDownloads(home, released));
      showDownloads(document, later);
      expect(appData()["softwareVersion"]).toBe(
        later.installers.length ? later.version : undefined,
      );
    }
  });
});
