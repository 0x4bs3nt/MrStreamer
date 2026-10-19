import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogueWorkerScripts, installedMainScript } from "./e2e/installed-worker-scripts.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Synthetic archive bytes at the same public manifest/data boundary as a packaged ASAR. */
async function archive(
  sources: Record<string, string>,
  change?: (files: Record<string, Record<string, unknown>>) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "owned worker scripts "));
  const resources = join(root, "Resources");
  await mkdir(resources);
  const files: Record<string, Record<string, unknown>> = {};
  const contents: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(sources)) {
    const bytes = Buffer.from(text);
    files[name] = {
      size: bytes.length,
      offset: String(offset),
      integrity: { algorithm: "SHA256", hash: sha256(bytes) },
    };
    offset += bytes.length;
    contents.push(bytes);
  }
  change?.(files);
  const json = Buffer.from(JSON.stringify({ files: { out: { files: { main: { files } } } } }));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerSize - 4, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  const bytes = Buffer.concat([header, ...contents]);
  await writeFile(join(resources, "app.asar"), bytes);
  return { root, resources, sha256: sha256(bytes) };
}
const entry = "catalogue-worker-test.js";

describe("packaged worker startup script provenance", () => {
  it("pins the actual archive and only its transitive static imports/reexports, once each", async () => {
    const fixture = await archive({
      [entry]: `import "./dependency.js"; import {x} from "./shared.js"; // from './unrelated.js'
        const text="import './unrelated.js'"; const later=()=>import('./unrelated.js');`,
      "dependency.js": `export {x} from './shared.js'; export * from './nested.js';`,
      "shared.js": "export const x=1;",
      "nested.js": "import './dependency.js';",
      "unrelated.js": "throw Error('never allowed');",
    });
    try {
      const proof = await catalogueWorkerScripts(fixture.resources, fixture.sha256);
      expect(proof.archive).toEqual({
        path: join(fixture.resources, "app.asar"),
        sha256: fixture.sha256,
      });
      expect(proof.scripts.map((s) => s.name)).toEqual([
        entry,
        "dependency.js",
        "shared.js",
        "nested.js",
      ]);
      expect(proof.scripts[0]?.imports).toEqual(["dependency.js", "shared.js"]);
      expect(proof.startupScriptURLs).toEqual(
        ["dependency.js", "shared.js", "nested.js"].map(
          (name) => pathToFileURL(join(fixture.resources, "app.asar", "out", "main", name)).href,
        ),
      );
      expect(proof.expectedWorker).toContain("owned%20worker%20scripts%20");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reads main bytes from the pinned archive and refuses changed manifest integrity", async () => {
    const source = "export const main = 'actual packed main';";
    for (const corrupt of [false, true]) {
      const fixture = await archive({ "index.js": source }, (files) => {
        if (corrupt) files["index.js"]!.integrity = { algorithm: "SHA256", hash: "0".repeat(64) };
      });
      try {
        if (corrupt)
          await expect(installedMainScript(fixture.resources, fixture.sha256)).rejects.toThrow(
            "integrity mismatch",
          );
        else {
          const actual = await installedMainScript(fixture.resources, fixture.sha256);
          expect(actual.source.toString()).toBe(source);
          expect(actual.sha256).toBe(sha256(Buffer.from(source)));
          await expect(installedMainScript(fixture.resources, "0".repeat(64))).rejects.toThrow(
            "hash changed",
          );
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it.each([
    "hash",
    "integrity",
    "unpacked",
    "offset",
    "ambiguous",
    "missing",
    "nested-path",
    "syntax",
  ])("rejects %s provenance before inspector commands", async (scenario) => {
    const sources: Record<string, string> = {
      [entry]: 'import "./dependency.js";',
      "dependency.js": "export const x=1;",
    };
    if (scenario === "ambiguous") sources["catalogue-worker-second.js"] = "export {};";
    if (scenario === "missing") delete sources["dependency.js"];
    if (scenario === "nested-path") sources[entry] = 'import "./nested/dependency.js";';
    if (scenario === "syntax") sources[entry] = "import {";
    const fixture = await archive(sources, (files) => {
      if (scenario === "integrity")
        files[entry]!.integrity = { algorithm: "SHA256", hash: "0".repeat(64) };
      if (scenario === "unpacked") files[entry]!.unpacked = true;
      if (scenario === "offset") files[entry]!.offset = "9007199254740992";
    });
    try {
      await expect(
        catalogueWorkerScripts(
          fixture.resources,
          scenario === "hash" ? "0".repeat(64) : fixture.sha256,
        ),
      ).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
