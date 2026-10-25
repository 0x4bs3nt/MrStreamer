// reminders.json in the data folder: the programme reminders, which only services/reminders.ts
// reads and writes. Version 1 keeps each saved subscription's reminders under its id:
//
//   { "version": 1, "subscriptions": { "<subscription id>": [ { "id": …, "start": …, … } ] } }
//
// Releases before 0.0.20 never look for it. A file this build can't make sense of is never
// written over: one that isn't JSON or names no version counts as unreadable, and one a later
// version wrote as newer, and nothing of either is used. Within version 1, keys this build
// doesn't know stay with their reminder through every write, and an entry it can't read stays as
// it is, under its subscription, until that subscription goes.
import { readFile } from "node:fs/promises";
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import type { KeptReminder } from "@mrstreamer/core/reminders/rules";
import { writeJsonFile } from "./json-file.ts";

/** The version this build writes, and the newest it reads. */
const VERSION = 1;

/** What reminders.json holds, as this build reads it. */
export interface RemindersFile {
  readonly reminders: readonly KeptReminder[];
  /** Entries this build can't read, as the file holds them, by their subscription's id. */
  readonly unread: ReadonlyMap<string, readonly unknown[]>;
}

/** reminders.json as read: what it holds, or why none of it can be used. */
export type ReadReminders =
  | { readonly kind: "read"; readonly file: RemindersFile }
  | { readonly kind: "refused"; readonly reason: "unreadable" | "newer" };

const Head = lazy(() =>
  type({ version: "number.integer", "subscriptions?": { "[string]": "unknown[]" } }),
);

/** One reminder as stored, without the subscription it is kept under. */
const Entry = lazy(() =>
  type({
    id: "string > 0",
    channel: "string",
    streams: "string[] > 0",
    channelName: "string",
    adult: "boolean",
    start: "number",
    stop: "number",
    set: "string",
    title: "string",
    state: type({ kind: "'pending' | 'gone' | 'missed'" }).or({ kind: "'told'", at: "number" }),
  }),
);

/** Reads reminders.json at `path`. A file that isn't there holds no reminders. */
export async function readReminders(path: string): Promise<ReadReminders> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { kind: "read", file: { reminders: [], unread: new Map() } };
    return { kind: "refused", reason: "unreadable" };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "refused", reason: "unreadable" };
  }
  const head = Head()(data);
  if (head instanceof type.errors || head.version < VERSION)
    return { kind: "refused", reason: "unreadable" };
  if (head.version > VERSION) return { kind: "refused", reason: "newer" };
  const reminders: KeptReminder[] = [];
  const unread = new Map<string, unknown[]>();
  for (const [subscriptionId, entries] of Object.entries(head.subscriptions ?? {})) {
    for (const entry of entries) {
      const parsed = Entry()(entry);
      if (parsed instanceof type.errors)
        unread.set(subscriptionId, [...(unread.get(subscriptionId) ?? []), entry]);
      else reminders.push({ ...parsed, subscriptionId });
    }
  }
  return { kind: "read", file: { reminders, unread } };
}

/** Writes `file` to `path` whole, or leaves the file before it as it was. */
export async function writeReminders(path: string, file: RemindersFile): Promise<void> {
  const subscriptions = new Map<string, unknown[]>();
  for (const { subscriptionId, ...entry } of file.reminders)
    subscriptions.set(subscriptionId, [...(subscriptions.get(subscriptionId) ?? []), entry]);
  for (const [subscriptionId, entries] of file.unread)
    subscriptions.set(subscriptionId, [...(subscriptions.get(subscriptionId) ?? []), ...entries]);
  await writeJsonFile(path, { version: VERSION, subscriptions: Object.fromEntries(subscriptions) });
}
