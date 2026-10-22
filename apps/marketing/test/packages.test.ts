// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePackages } from "../scripts/pages.ts";
import { writeDownloads, installers } from "../src/downloads.ts";
import { PACKAGE_ROUTES, type PackageRoutes, type PackageName } from "../src/packages.ts";

const template = readFileSync(join(import.meta.dirname, "../src/download.html"), "utf8");
const home = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
const faq = readFileSync(join(import.meta.dirname, "../src/faq.html"), "utf8");
const unpublished: PackageRoutes = {
  homebrew: {
    ...PACKAGE_ROUTES.homebrew,
    publication: { state: "unpublished", lastVerifiedVersion: null },
  },
  aur: {
    ...PACKAGE_ROUTES.aur,
    publication: { state: "unpublished", lastVerifiedVersion: null },
  },
};

function open(routes: PackageRoutes = PACKAGE_ROUTES) {
  document.body.innerHTML = writeDownloads(writePackages(template, routes), {
    version: "0.0.19",
    installers,
  });
}

function published(name: PackageName): PackageRoutes {
  return {
    ...unpublished,
    [name]: {
      ...PACKAGE_ROUTES[name],
      publication: {
        state: "published",
        lastVerifiedVersion: "0.0.18",
        receipt: "https://github.com/orgs/Mr-Streamer-OSS/projects/1",
      },
    },
  };
}

describe("independently published download routes", () => {
  it("keeps unpublished package links and commands out of the built page", () => {
    open(unpublished);
    expect(document.querySelector("[data-package], pre")).toBeNull();
    expect(document.body.textContent).not.toContain("brew install");
    expect(document.body.textContent).not.toContain("makepkg");
    expect(document.querySelector('[data-installer="dmg"]')?.getAttribute("href")).toContain(
      "v0.0.19/",
    );
    expect(document.querySelector('a[href^="https://apps.microsoft.com/"]')).not.toBeNull();
  });

  it.each(["homebrew", "aur"] as const)(
    "shows only the checked %s route while direct releases advance",
    (name) => {
      open(published(name));
      const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-package]")];
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((link) => link.dataset["package"] === name)).toBe(true);
      expect(links.every((link) => link.href === PACKAGE_ROUTES[name].url)).toBe(true);
      expect(links[0]?.textContent).toContain(PACKAGE_ROUTES[name].architecture);
      expect(links[0]?.textContent).toContain(PACKAGE_ROUTES[name].platform);
      expect(document.querySelector(".package-route code")?.textContent).toBe(
        PACKAGE_ROUTES[name].install,
      );
      expect(document.querySelector(".package-route")?.textContent).toContain("Package 0.0.18.");
      expect(document.querySelector('[data-installer="dmg"]')?.getAttribute("href")).toContain(
        "v0.0.19/",
      );
    },
  );

  it("withdraws a package without removing direct installers or the Store", () => {
    const routes = published("homebrew");
    open({
      ...routes,
      homebrew: {
        ...routes.homebrew,
        publication: {
          state: "withdrawn",
          lastVerifiedVersion: "0.0.18",
          receipt: "https://github.com/orgs/Mr-Streamer-OSS/projects/1",
        },
      },
    });
    expect(document.querySelector("[data-package], pre")).toBeNull();
    expect(document.querySelectorAll("[data-installer]").length).toBeGreaterThan(0);
    expect(document.querySelector('a[href^="https://apps.microsoft.com/"]')).not.toBeNull();
  });

  it("does not publish a nightly package as a stable install route", () => {
    const routes = published("aur");
    open({
      ...routes,
      aur: {
        ...routes.aur,
        publication: {
          state: "published",
          lastVerifiedVersion: "0.0.18-nightly.20261020.1",
          receipt: "https://github.com/orgs/Mr-Streamer-OSS/projects/1",
        },
      },
    });
    expect(document.querySelector("[data-package], pre")).toBeNull();
  });

  it.each([home, faq])(
    "keeps availability copy in sync with publication and withdrawal",
    (html) => {
      for (const state of ["published", "withdrawn", "unpublished"] as const) {
        const routes = published("homebrew");
        const template = document.createElement("template");
        template.innerHTML = writePackages(html, {
          ...routes,
          homebrew: {
            ...routes.homebrew,
            publication:
              state === "unpublished"
                ? { state, lastVerifiedVersion: null }
                : {
                    state,
                    lastVerifiedVersion: "0.0.18",
                    receipt: "https://github.com/orgs/Mr-Streamer-OSS/projects/1",
                  },
          },
        });
        const link = template.content.querySelector<HTMLAnchorElement>("[data-package]");
        if (state === "published") {
          expect(link?.href).toBe(PACKAGE_ROUTES.homebrew.url);
          expect(link?.parentElement?.textContent).toBe("Also on Homebrew · macOS, Apple silicon.");
        } else {
          expect(link).toBeNull();
          expect(template.content.textContent).not.toContain("Also on");
        }
        expect(template.content.querySelector('a[href="/download"]')).not.toBeNull();
        expect(template.content.querySelector('[data-package="aur"]')).toBeNull();
      }
    },
  );
});
