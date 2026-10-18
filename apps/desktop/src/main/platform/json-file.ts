import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import { ArkErrors } from "arktype";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
/**
 * zlib hands work back and forth in chunks of this size. Its default, 16 KB, made unpacking the
 * movie and series cache take 250 to 450 ms instead of 30 to 70.
 */
const ZLIB = { chunkSize: 1024 * 1024 };

/**
 * Reads and validates a JSON file against an ArkType schema, unpacking it first when its name
 * ends in .gz. Returns null when the file is missing, unreadable or no longer matches, so callers
 * treat stale formats like a first run.
 */
export async function readJsonFile<T>(
  path: string,
  schema: (data: unknown) => T | ArkErrors,
): Promise<T | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  let data: unknown;
  try {
    data = JSON.parse((path.endsWith(".gz") ? await gunzip(bytes, ZLIB) : bytes).toString("utf8"));
  } catch {
    console.warn(`[storage] ignoring unreadable ${path}`);
    return null;
  }
  const parsed = schema(data);
  if (parsed instanceof ArkErrors) {
    console.warn(`[storage] ignoring ${path}: ${parsed.summary}`);
    return null;
  }
  return parsed;
}

/**
 * Writes JSON atomically, packed when the name ends in .gz: a crash mid-write leaves the previous
 * file intact. Windows replacement retries keep the same temp and bytes, with at most 70 ms of
 * intentional delay. Callers must await each write settling before starting a newer same-path write.
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const text = JSON.stringify(value);
  await writeFile(temp, path.endsWith(".gz") ? await gzip(text, ZLIB) : text);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (cause) {
      const wait = [10, 20, 40][attempt];
      if (
        process.platform !== "win32" ||
        wait === undefined ||
        !(cause instanceof Error) ||
        !("code" in cause) ||
        typeof cause.code !== "string" ||
        !["EPERM", "EACCES", "EBUSY"].includes(cause.code)
      )
        throw cause;
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** Deletes what writes interrupted by a crash or power loss left behind in `dir`. */
export async function removeUnfinishedWrites(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => []);
  const unfinished = names.filter((name) => /\.(json|xml|gz)\.[0-9a-f-]{36}\.tmp$/.test(name));
  await Promise.all(unfinished.map((name) => rm(join(dir, name), { force: true })));
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
