import { QUALITIES, type Quality } from "@mrstreamer/contracts/library";
import { DEFAULT_LIVE_QUALITY } from "@mrstreamer/contracts/preferences";
import { TITLE_LANGUAGES, type TitleLanguage } from "@mrstreamer/core/ondemand/languages";
import { File, Paths } from "expo-file-system";
import { readJson, writeJson } from "./files.ts";
import { store, useStore, type Store } from "./store.ts";

type Audio =
  | { readonly kind: "default" }
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
  /** Default follows the file; original uses the title's original language when available. */
  readonly audio: Audio;
  /** Forced-only needs actual native track facts, never provider name hints. */
  readonly subtitles: Subtitles;
  readonly liveQuality: Quality;
}

const FILE = "media-preferences.json";
let contents: Record<string, unknown> = { version: 1 };
let writable = true;
let checkpoint = false;
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
  return { kind: "default" };
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
  try {
    const raw = readJson(FILE);
    checkpoint = raw === null;
    if (record(raw)) contents = raw;
    // readJson can recover a complete interrupted write. Establish it as the last complete
    // file before a later write reuses .next, so a refusal cannot lose that accepted value.
    if (raw !== null) {
      const complete = new File(Paths.document, FILE);
      const pending = new File(Paths.document, `${FILE}.next`);
      if (pending.exists) {
        let readable = false;
        try {
          JSON.parse(complete.textSync());
          readable = true;
        } catch {
          // The accepted read came from .next instead.
        }
        if (!readable) pending.moveSync(complete, { overwrite: true });
      }
    }
  } catch {
    // An inaccessible file must not be replaced with defaults.
    writable = false;
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
  try {
    // Give a first edit a complete prior file too. If the proposal's move and cleanup both
    // fail, readJson must recover the accepted defaults rather than the refused proposal.
    if (checkpoint) {
      writeJson(FILE, contents);
      checkpoint = false;
    }
    writeJson(FILE, next);
  } catch {
    // A refused first move must not become an accepted choice on restart via readJson's
    // interrupted-write recovery. Existing complete bytes remain authoritative.
    try {
      const pending = new File(Paths.document, `${FILE}.next`);
      if (pending.exists) pending.delete();
    } catch {
      // The disk can refuse cleanup too; keep the running accepted snapshot.
    }
    return false;
  }
  contents = next;
  source.set(accepted({ ...current, [field]: value }));
  return true;
}
