import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseAst } from "vite";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid ASAR manifest object");
  return value as Record<string, unknown>;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Reads only packed, integrity-checked static ESM imports of the unique actual worker entry. */
export async function catalogueWorkerScripts(resources: string, expectedAsarSha256: string) {
  if (!isAbsolute(resources) || !/^[a-f0-9]{64}$/.test(expectedAsarSha256))
    throw new Error("Exact resources path and verified ASAR hash required");
  const archive = join(resources, "app.asar");
  const bytes = await readFile(archive);
  if (digest(bytes) !== expectedAsarSha256) throw new Error("Actual worker ASAR hash changed");
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw new Error("Invalid ASAR header");
  const dataStart = 8 + bytes.readUInt32LE(4);
  const headerEnd = 16 + bytes.readUInt32LE(12);
  if (headerEnd > dataStart || dataStart > bytes.length)
    throw new Error("Invalid ASAR header bounds");
  const header: unknown = JSON.parse(bytes.subarray(16, headerEnd).toString());
  let files = object(object(header).files);
  for (const directory of ["out", "main"]) files = object(object(files[directory]).files);
  const names = Object.keys(files).filter((name) =>
    /^catalogue-worker-[A-Za-z0-9_-]+\.js$/.test(name),
  );
  if (names.length !== 1) throw new Error("No unique actual packaged catalogue worker");
  const entry = names[0]!;
  const scripts: { name: string; url: string; bytes: number; sha256: string; imports: string[] }[] =
    [];
  const queue = [entry];
  const seen = new Set(queue);
  for (const name of queue) {
    const record = object(files[name]);
    if (
      record.unpacked ||
      record.link ||
      typeof record.offset !== "string" ||
      !/^\d+$/.test(record.offset) ||
      typeof record.size !== "number" ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0
    )
      throw new Error("Expected packed script bytes in verified ASAR");
    const offset = Number(record.offset);
    const begin = dataStart + offset;
    const end = begin + record.size;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end > bytes.length)
      throw new Error("Invalid ASAR script bounds");
    const source = bytes.subarray(begin, end);
    const sha256 = digest(source);
    const integrity = object(record.integrity);
    if (integrity.algorithm !== "SHA256" || integrity.hash !== sha256)
      throw new Error("Actual ASAR script integrity mismatch");
    const imports: string[] = [];
    for (const statement of parseAst(source.toString()).body) {
      if (
        statement.type !== "ImportDeclaration" &&
        statement.type !== "ExportNamedDeclaration" &&
        statement.type !== "ExportAllDeclaration"
      )
        continue;
      const literal = statement.source?.value;
      if (typeof literal !== "string") continue;
      if (!literal.startsWith(".")) continue;
      if (!/^\.\/[A-Za-z0-9_.-]+\.js$/.test(literal))
        throw new Error("Worker startup dependency must be an explicit sibling JS file");
      const dependency = literal.slice(2);
      if (!imports.includes(dependency)) imports.push(dependency);
      if (!seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
    scripts.push({
      name,
      url: pathToFileURL(join(archive, "out", "main", name)).href,
      bytes: source.length,
      sha256,
      imports,
    });
  }
  return {
    archive: { path: archive, sha256: expectedAsarSha256 },
    expectedWorker: scripts[0]!.url,
    startupScriptURLs: scripts.slice(1).map((script) => script.url),
    scripts,
  };
}
