// Controlled Windows error semantics on real temporary files/timers, not native Windows proof.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonFile } from "../src/main/platform/json-file.ts";
import { tempDir } from "./support.ts";

const disk = vi.hoisted(() => ({
  failures: 0,
  code: "EPERM",
  attempts: [] as { from: string; to: string; previous: string; bytes: Buffer }[],
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    if (typeof from !== "string" || typeof to !== "string")
      throw new Error("This probe requires ordinary file paths");
    disk.attempts.push({
      from,
      to,
      previous: await actual.readFile(to, "utf8"),
      bytes: await actual.readFile(from),
    });
    if (disk.failures > 0) {
      disk.failures--;
      throw Object.assign(new Error("Controlled rename rejection"), { code: disk.code });
    }
    await actual.rename(from, to);
  };
  return { ...actual, rename };
});
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  disk.attempts = [];
  disk.failures = 0;
});

async function destination() {
  const path = join(await tempDir(), "record.json");
  const previous = '{"revision":"old"}\n';
  await writeFile(path, previous);
  return { path, previous };
}

describe("atomic JSON replacement", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "recovers Windows %s twice using the same completed temporary bytes",
    async (code) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const { path, previous } = await destination();
      disk.failures = 2;
      disk.code = code;
      let serializations = 0;
      const next = { revision: "new", count: 1 };
      await writeJsonFile(path, {
        toJSON() {
          serializations++;
          return next;
        },
      });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(next);
      expect(serializations).toBe(1);
      expect(disk.attempts).toHaveLength(3);
      expect(new Set(disk.attempts.map((attempt) => attempt.from)).size).toBe(1);
      for (const attempt of disk.attempts) {
        expect(attempt.to).toBe(path);
        expect(attempt.previous).toBe(previous);
        expect(attempt.bytes.toString()).toBe(JSON.stringify(next));
      }
      expect(await readdir(dirname(path))).toEqual([basename(path)]);
    },
  );

  it("bounds permanent Windows denial and retains both the old destination and one new temp", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { path, previous } = await destination();
    disk.failures = Infinity;
    disk.code = "EBUSY";
    await expect(writeJsonFile(path, { revision: "new" })).rejects.toMatchObject({ code: "EBUSY" });
    expect(disk.attempts).toHaveLength(4);
    expect(await readFile(path, "utf8")).toBe(previous);
    const temporary = disk.attempts[0]!.from;
    expect(
      disk.attempts.every((attempt) => attempt.from === temporary && attempt.previous === previous),
    ).toBe(true);
    expect(JSON.parse(await readFile(temporary, "utf8"))).toEqual({ revision: "new" });
    expect((await readdir(dirname(path))).sort()).toEqual(
      [basename(path), basename(temporary)].sort(),
    );
  });

  it.each([
    ["win32", "ENOENT"],
    ["linux", "EPERM"],
  ])("propagates %s %s on the first attempt", async (os, code) => {
    Object.defineProperty(process, "platform", { value: os });
    const { path, previous } = await destination();
    disk.failures = Infinity;
    disk.code = code;
    await expect(writeJsonFile(path, { revision: "new" })).rejects.toMatchObject({ code });
    expect(disk.attempts).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(previous);
  });
});
