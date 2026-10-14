// Notices for Settings > About: what the installers ship, the app itself included, and under which
// licences. The build writes the list to out/licences/third-party.json (scripts/licences.ts).
// Chromium's credits page, which also holds Node.js's licence, comes with Electron itself: about
// 20 MB of HTML, read and turned into plain text only when the UI asks for one of the two.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { NoticeManifest, type ThirdPartyNotice } from "@mrstreamer/contracts/licences";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface NoticeFiles {
  /** third-party.json, as the build wrote it. */
  readonly manifest: string;
  /** Where Chromium's credits page may be. The first that exists is read. */
  readonly credits: readonly string[];
  /** The running Electron's versions, for `{chrome}` and `{node}` in the manifest. */
  readonly versions: Readonly<Record<string, string | undefined>>;
}

const CREDITS = "LICENSES.chromium.html";

/**
 * This app's notices: the manifest next to out/main, in development and inside app.asar, and the
 * credits page from Electron's download. On Linux and Windows electron-builder keeps it next to
 * the executable; on macOS scripts/mac-credits.ts moves it into the app's Resources.
 */
export function appNotices(): NoticeFiles {
  const executable = process.execPath;
  return {
    manifest: join(import.meta.dirname, "../licences/third-party.json"),
    credits: [
      join(dirname(executable), CREDITS),
      // Contents/MacOS/<executable> to Contents/Resources.
      join(executable, "../../Resources", CREDITS),
      // Development on macOS: the executable is inside Electron.app, the page next to it.
      join(executable, "../../../..", CREDITS),
    ],
    versions: process.versions,
  };
}

export class Licences extends Context.Service<
  Licences,
  {
    /** Every component the app ships, itself included, sorted by name, without the texts. */
    readonly list: Effect.Effect<readonly ThirdPartyNotice[], Failed>;
    /** The full notice of a component from `list`, as plain text. */
    text(id: string): Effect.Effect<string, Failed>;
  }
>()("mrstreamer/Licences") {
  static readonly layer = (files: NoticeFiles) => Layer.succeed(Licences, make(files));
}

function make(files: NoticeFiles) {
  const fill = (text: string) =>
    text.replace(
      /\{(chrome|node)\}/g,
      (placeholder, name: string) => files.versions[name] ?? placeholder,
    );

  // Read on every call: the UI asks rarely, and a rebuild in development shows at once.
  const notices = Effect.tryPromise({
    try: async () => {
      const manifest = NoticeManifest()(JSON.parse(await readFile(files.manifest, "utf8")));
      if (manifest instanceof type.errors) {
        throw new Error(`${files.manifest}: ${manifest.summary}`);
      }
      return manifest.notices.map((notice) => ({
        ...notice,
        id: fill(notice.id),
        version: fill(notice.version),
        source: fill(notice.source),
        homepage: notice.homepage === null ? null : fill(notice.homepage),
      }));
    },
    catch: (cause) =>
      isMissing(cause)
        ? unexpected(`This build has no third-party notices; pnpm build writes ${files.manifest}.`)
        : failedWith(cause),
  });

  const credits = (project: string) =>
    Effect.tryPromise({
      try: async () => {
        const path = files.credits.find((candidate) => existsSync(candidate));
        if (!path) throw new Error(`Chromium's credits page (${CREDITS}) is missing.`);
        return creditsText(await readFile(path, "utf8"), project);
      },
      catch: failedWith,
    });

  return {
    list: Effect.map(notices, (all) => all.map(({ text: _text, ...notice }) => notice)),
    text: (id: string) =>
      Effect.flatMap(notices, (all) => {
        const notice = all.find((candidate) => candidate.id === id);
        if (!notice) return Effect.fail(unexpected(`No third-party notice is called ${id}.`));
        return typeof notice.text === "string"
          ? Effect.succeed(notice.text)
          : credits(notice.text.credits);
      }),
  };
}

// One project on the credits page: its name, its homepage and its licence, as licenses.py in
// Chromium's tools writes them.
const PROJECT =
  /<span class="title">([^<]*)<\/span>\s*<span class="homepage"><a href="([^"]*)">[^<]*<\/a><\/span>[\s\S]*?<pre>([\s\S]*?)<\/pre>/g;

/**
 * The credits page as plain text: one project's licence, or with `*` every project with its
 * homepage and licence. The whole page takes a few hundred milliseconds.
 */
function creditsText(html: string, project: string): string {
  const projects = [...html.matchAll(PROJECT)].map(
    ([, title = "", homepage = "", licence = ""]) => ({
      title: decoded(title),
      homepage: decoded(homepage),
      licence,
    }),
  );
  const text = (licence: string) => decoded(licence.replace(/\r\n?/g, "\n")).trim();
  if (project === "*") {
    if (projects.length === 0) throw new Error(`${CREDITS} lists no projects.`);
    return projects
      .map(({ title, homepage, licence }) => `${title}\n${homepage}\n\n${text(licence)}`)
      .join("\n\n---\n\n");
  }
  const found = projects.find(({ title }) => title === project);
  if (!found) throw new Error(`${CREDITS} has no section for ${project}.`);
  return text(found.licence);
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** HTML text with its character references, `&quot;` and `&#x27;` for instance, decoded. */
function decoded(html: string): string {
  if (!html.includes("&")) return html;
  return html.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-z]+));/g,
    (entity: string, hex?: string, decimal?: string, name?: string) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(Number(decimal));
      return (name && ENTITIES[name]) ?? entity;
    },
  );
}

function unexpected(detail: string): Failed {
  return new Failed({ error: { kind: "unexpected", detail } });
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
