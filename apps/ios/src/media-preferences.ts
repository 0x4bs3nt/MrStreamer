import { QUALITIES, type Quality } from "@mrstreamer/contracts/library";
import { DEFAULT_LIVE_QUALITY } from "@mrstreamer/contracts/preferences";
import { TITLE_LANGUAGES, type TitleLanguage } from "@mrstreamer/core/ondemand/languages";
import { File, Paths } from "expo-file-system";
import { writeJson } from "./files.ts";
import { store, useStore, type Store } from "./store.ts";

type Audio =
  | { readonly kind: "follow-title" }
  | { readonly kind: "original" }
  | { readonly kind: "language"; readonly language: TitleLanguage };
type Subtitles =
  | { readonly kind: "forced-only" }
  | { readonly kind: "off" }
  | { readonly kind: "language"; readonly language: TitleLanguage };

/** Global media policies. Native track and Live variant consumers apply these on a later item. */
interface MediaPreferences {
  /** null keeps the device's language, including languages outside the offered choices. */
  readonly titleLanguage: TitleLanguage | null;
  /**
   * Follow-title targets effective title language; original targets originalLanguage.
   * The later consumer falls back to the native playable default when unavailable.
   */
  readonly audio: Audio;
  /** Forced-only needs actual native track facts, never provider name hints. */
  readonly subtitles: Subtitles;
  readonly liveQuality: Quality;
}

const FILE = "media-preferences.json";
const BACKUP = "media-preferences.accepted.json";
let contents: Record<string, unknown> = { version: 1 };
let writable = true;
let checkpointed = false;
let cached: Store<MediaPreferences> | undefined;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const knownLanguage = (value: unknown) => TITLE_LANGUAGES.find(({ code }) => code === value)?.code;

function audioOf(value: unknown): Audio {
  if (record(value)) {
    if (value["kind"] === "original") return { kind: "original" };
    const language = knownLanguage(value["language"]);
    if (value["kind"] === "language" && language) return { kind: "language", language };
  }
  return { kind: "follow-title" };
}

function subtitlesOf(value: unknown): Subtitles {
  if (record(value)) {
    if (value["kind"] === "off") return { kind: "off" };
    const language = knownLanguage(value["language"]);
    if (value["kind"] === "language" && language) return { kind: "language", language };
  }
  return { kind: "forced-only" };
}

function accepted(value: MediaPreferences): MediaPreferences {
  return Object.freeze({
    ...value,
    audio: Object.freeze({ ...value.audio }),
    subtitles: Object.freeze({ ...value.subtitles }),
  });
}

/** Read synchronously on first use, before the title owner starts any indexing. */
function saved(): Store<MediaPreferences> {
  if (cached) return cached;
  // The primary wins. Accepted backup contents precede a pending proposal, which a
  // refused native delete-then-move replacement may leave as the only primary candidate.
  for (const name of [FILE, BACKUP, `${BACKUP}.next`, `${FILE}.next`]) {
    try {
      const file = new File(Paths.document, name);
      if (!file.exists) continue;
      const raw: unknown = JSON.parse(file.textSync());
      if (!record(raw)) {
        writable = false;
        continue;
      }
      contents = raw;
      checkpointed = name === BACKUP || name === `${BACKUP}.next`;
      break;
    } catch {
      // Existence and readability differ. Preserve an unreadable candidate even if the
      // disk becomes readable later; a lower candidate may still supply display values.
      writable = false;
    }
  }
  writable &&= contents["version"] === undefined || contents["version"] === 1;
  cached = store(
    accepted({
      titleLanguage: knownLanguage(contents["titleLanguage"]) ?? null,
      audio: audioOf(contents["audio"]),
      subtitles: subtitlesOf(contents["subtitles"]),
      liveQuality:
        QUALITIES.find((quality) => quality === contents["liveQuality"]) ?? DEFAULT_LIVE_QUALITY,
    }),
  );
  return cached;
}

/** Only accepted, durable choices. No source, file or native track identities belong here. */
export const getMediaPreferences = (): MediaPreferences => saved().get();
export const useMediaPreferences = (): MediaPreferences => useStore(saved());
export const onMediaPreferences = (listener: () => void): (() => void) =>
  saved().subscribe(listener);

/**
 * Saves one field before publishing it. False leaves the accepted snapshot unchanged; Settings
 * reports a generic failure. Untouched future fields survive, and a future file version is read-only.
 */
export function updateMediaPreferences<K extends keyof MediaPreferences>(
  field: K,
  value: MediaPreferences[K],
): boolean {
  const source = saved();
  const current = source.get();
  if (JSON.stringify(current[field]) === JSON.stringify(value)) return true;
  if (!writable) return false;
  const next = { ...contents, version: 1, [field]: value };
  if (!checkpointed) {
    try {
      // Expo overwrites by deleting then moving. A checkpoint refusal must leave the
      // current primary untouched; only this owner writes accepted contents to BACKUP.
      writeJson(BACKUP, contents);
      checkpointed = true;
    } catch {
      return false;
    }
  }
  try {
    writeJson(FILE, next);
  } catch {
    // BACKUP still holds the accepted contents, ahead of this refused proposal at the
    // next launch, even when native replacement deleted the primary and cleanup fails.
    try {
      const pending = new File(Paths.document, `${FILE}.next`);
      if (pending.exists) pending.delete();
    } catch {
      // The disk can refuse cleanup too; keep the running accepted snapshot.
    }
    return false;
  }
  contents = next;
  checkpointed = false;
  source.set(accepted({ ...current, [field]: value }));
  return true;
}
