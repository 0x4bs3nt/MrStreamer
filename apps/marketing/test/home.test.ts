// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPage, writePackages } from "../scripts/pages.ts";
import { LATEST, installers, writeDownloads, type Downloads } from "../src/downloads.ts";
import type { System } from "../src/system.ts";

// The home and download pages as a visitor gets them: the HTML under styles.css, with <html>
// marked as the script in the head marks it. What shows is what the stylesheet leaves on display.

const root = join(import.meta.dirname, "..");
const home = writePackages(readFileSync(join(root, "index.html"), "utf8"));
const css = readFileSync(join(root, "src/styles.css"), "utf8");

const STORE = "https://apps.microsoft.com/detail/9N45GG76ZP4T?referrer=appbadge";
const HOMEBREW = [
  "Homebrew · macOS, Apple silicon",
  "https://github.com/Mr-Streamer-OSS/homebrew-tap",
];
const BREW_UPDATES = [
  "Homebrew updates and reinstalling",
  "/docs/updates#installed-through-homebrew",
];
const AUR = ["AUR · Arch Linux, x86_64", "https://aur.archlinux.org/packages/mrstreamer-bin"];
const AUR_UPDATES = ["Install and update on Arch Linux", "/docs/updates#installed-through-the-aur"];
const FILES = "https://github.com/Mr-Streamer-OSS/MrStreamer/releases/download";
const RELEASED: Downloads = { version: "0.0.7", installers };

/**
 * Opens a page for a visitor on `system`, undefined for one whose system the script couldn't
 * name. The build wrote `downloads` into it, or nothing when it found no release.
 */
function open(html: string, system?: System, downloads?: Downloads): void {
  const page = downloads ? writeDownloads(html, downloads) : html;
  document.documentElement.innerHTML = page.replace(
    /<link rel="stylesheet"[^>]*>/,
    `<style>${css}</style>`,
  );
  if (system) document.documentElement.dataset["os"] = system;
  else document.documentElement.removeAttribute("data-os");
}
const openDownload = (system?: System, downloads?: Downloads) =>
  open(renderPage("download/index.html", downloads ?? null, null), system, downloads);

const displayed = (node: Node): boolean =>
  !(node instanceof HTMLElement) || getComputedStyle(node).display !== "none";

/** The elements matching `selector` that show. */
const shown = (selector: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>(selector)].filter(displayed);

/** What an element says, without the parts of it that don't show. */
const said = (element: Element): string =>
  [...element.childNodes]
    .filter(displayed)
    .map((node) => node.textContent)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** The links that show under `selector`, as [words, address]. */
const links = (selector: string) =>
  shown(selector).map((link) => [
    said(link) || link.querySelector("img")?.alt,
    link.getAttribute("href"),
  ]);

describe("the home page", () => {
  it("sends a visitor to the download page, and holds no installer", () => {
    open(home, undefined, RELEASED);

    expect(document.querySelectorAll("header")).toHaveLength(1);
    expect(links("header nav a")).toEqual([
      ["Guides", "/docs"],
      ["FAQ", "/faq"],
      ["Download", "/download"],
    ]);
    expect(links(".hero .actions a")).toEqual([["Download", "/download"]]);
    expect(links("#downloads a")).toEqual([["Download", "/download"], HOMEBREW, AUR]);
    expect(
      document.querySelector('[data-installer], [data-release-version], a[href^="https://apps."]'),
    ).toBeNull();
  });
});

describe("the download page", () => {
  /** The visitor's own block: its heading, read with its parts apart, its line and its links. */
  const mine = () =>
    shown(".mine").map((block) => ({
      heading: [...(block.querySelector("h2")?.childNodes ?? [])]
        .map((node) => node.textContent?.trim())
        .join(" "),
      line: said(block.querySelector(".note") ?? block),
      links: [...block.querySelectorAll("a")].map((link) => [
        said(link) || link.querySelector("img")?.alt,
        link.getAttribute("href"),
      ]),
    }));

  it("shows no block for a visitor whose system is unknown", () => {
    openDownload(undefined, RELEASED);
    expect(mine()).toEqual([]);
  });

  it("puts the Microsoft Store first on Windows, with the setup .exe beside it", () => {
    openDownload("windows", RELEASED);
    expect(mine()).toEqual([
      {
        heading: "Windows your system",
        line: "Windows 11, 64-bit.",
        links: [
          ["Get it from Microsoft", STORE],
          ["Setup .exe", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-win-x64-setup.exe`],
        ],
      },
    ]);
  });

  it("puts the DMG first on a Mac", () => {
    openDownload("mac", RELEASED);
    expect(mine()).toEqual([
      {
        heading: "Mac your system",
        line: "macOS 13 or later, Apple silicon.",
        links: [["Download the DMG", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-mac-arm64.dmg`], HOMEBREW],
      },
    ]);
  });

  it("puts the AppImage first on Linux, with the .deb beside it", () => {
    openDownload("linux", RELEASED);
    expect(mine()).toEqual([
      {
        heading: "Linux your system",
        line: "64-bit Linux. The AppImage needs FUSE 2.",
        links: [
          ["Download the AppImage", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-linux-x86_64.AppImage`],
          [".deb", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-linux-amd64.deb`],
          AUR,
        ],
      },
    ]);
  });

  it("names no version, and sends the block's link to the Releases page, without a known installer", () => {
    openDownload("mac");
    expect(mine()).toEqual([
      {
        heading: "Mac your system",
        line: "macOS 13 or later, Apple silicon.",
        links: [["Download the DMG", LATEST], HOMEBREW],
      },
    ]);

    // The release is out, without its AppImage.
    openDownload("linux", { version: "0.0.8", installers: ["dmg", "exe", "deb"] });
    expect(mine()[0]?.line).toBe("64-bit Linux. The AppImage needs FUSE 2.");
    expect(mine()[0]?.links).toEqual([
      ["Download the AppImage", LATEST],
      [".deb", `${FILES}/v0.0.8/Mr-Streamer-0.0.8-linux-amd64.deb`],
      AUR,
    ]);
  });

  it("lists the Store and every installer in its rows", () => {
    openDownload(undefined, RELEASED);

    expect(links(".rows a")).toEqual([
      ["Download the DMG", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-mac-arm64.dmg`],
      HOMEBREW,
      BREW_UPDATES,
      ["Microsoft Store", STORE],
      ["Download the setup .exe", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-win-x64-setup.exe`],
      ["Download the AppImage", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-linux-x86_64.AppImage`],
      ["Download the .deb", `${FILES}/v0.0.7/Mr-Streamer-0.0.7-linux-amd64.deb`],
      AUR,
      AUR_UPDATES,
    ]);
    expect(said(document.querySelector("[data-release-version]") ?? document.body)).toBe(
      "Version 0.0.7.",
    );
  });

  it("sends every row to the Releases page, and says so, when no release is known", () => {
    openDownload();

    expect(links(".rows a")).toEqual([
      ["Download the DMG on GitHub Releases", LATEST],
      HOMEBREW,
      BREW_UPDATES,
      ["Microsoft Store", STORE],
      ["Download the setup .exe on GitHub Releases", LATEST],
      ["Download the AppImage on GitHub Releases", LATEST],
      ["Download the .deb on GitHub Releases", LATEST],
      AUR,
      AUR_UPDATES,
    ]);
    expect(said(document.querySelector("[data-release-version]") ?? document.body)).toBe(
      "Stable release on GitHub.",
    );
  });

  it("links the installers a release has, and the Releases page for the one it lacks", () => {
    openDownload(undefined, { version: "0.0.8", installers: ["dmg", "exe", "appImage"] });

    expect(links(".rows a")).toEqual([
      ["Download the DMG", `${FILES}/v0.0.8/Mr-Streamer-0.0.8-mac-arm64.dmg`],
      HOMEBREW,
      BREW_UPDATES,
      ["Microsoft Store", STORE],
      ["Download the setup .exe", `${FILES}/v0.0.8/Mr-Streamer-0.0.8-win-x64-setup.exe`],
      ["Download the AppImage", `${FILES}/v0.0.8/Mr-Streamer-0.0.8-linux-x86_64.AppImage`],
      ["Download the .deb on GitHub Releases", LATEST],
      AUR,
      AUR_UPDATES,
    ]);
  });
});
