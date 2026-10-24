import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { File, native } from "./native-files.ts";

// File's public native boundary, including pinned Expo's non-atomic overwrite semantics.
const folder = join(native.root, "move-port");
beforeEach(() => {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder);
  native.sync = null;
  native.undeletable = null;
});
afterEach(() => {
  native.sync = null;
  native.undeletable = null;
});
function pair() {
  const source = new File(folder, "source.json");
  const destination = new File(folder, "destination.json");
  source.create();
  source.writeSync("source");
  destination.create();
  destination.writeSync("destination");
  return { source, destination };
}
it("refuses an existing destination without overwrite, retaining both files and identity", () => {
  const { source, destination } = pair();
  const identity = source.path;
  expect(() => source.moveSync(destination)).toThrow();
  expect(source.path).toBe(identity);
  expect(source.textSync()).toBe("source");
  expect(destination.textSync()).toBe("destination");
});
it("moves with overwrite and updates the source object's path and URI", () => {
  const { source, destination } = pair();
  const prior = source.path;
  source.moveSync(destination, { overwrite: true });
  expect(source.path).toBe(destination.path);
  expect(source.uri).toBe(destination.uri);
  expect(source.textSync()).toBe("source");
  expect(new File(prior).exists).toBe(false);
});
it("can refuse the move after deleting the destination without changing source identity", () => {
  const { source, destination } = pair();
  const prior = source.path;
  native.sync = (step) => {
    if (step === "move-after-delete") throw new Error("move refused");
  };
  expect(() => source.moveSync(destination, { overwrite: true })).toThrow("move refused");
  expect(destination.exists).toBe(false);
  expect(source.path).toBe(prior);
  expect(source.textSync()).toBe("source");
});
