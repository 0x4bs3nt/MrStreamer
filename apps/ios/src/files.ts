import { File, Paths } from "expo-file-system";

// Whole JSON files in the app's Documents folder, which iOS deletes with the app. A write goes to
// a file beside it first, then takes its place, so a write cut short by the app being killed
// leaves the last whole file; one cut short before the move finishes leaves the new file there
// under the temporary name, which a read takes instead.

const fileOf = (name: string) => new File(Paths.document, name);
const pendingOf = (name: string) => new File(Paths.document, `${name}.next`);

/** The file's contents, or null when there is none or it doesn't read as JSON. */
export function readJson(name: string): unknown {
  for (const file of [fileOf(name), pendingOf(name)]) {
    if (!file.exists) continue;
    try {
      return JSON.parse(file.textSync()) as unknown;
    } catch {
      // Unreadable: try the other, then start again.
    }
  }
  return null;
}

/** Replaces the file with `value`, whole. Throws when the folder won't take it. */
export function writeJson(name: string, value: unknown): void {
  const pending = pendingOf(name);
  if (!pending.exists) pending.create();
  pending.writeSync(JSON.stringify(value));
  pending.moveSync(fileOf(name), { overwrite: true });
}

/** Removes the file, and any write of it left halfway. */
export function removeJson(name: string): void {
  for (const file of [fileOf(name), pendingOf(name)]) {
    if (file.exists) file.delete();
  }
}
