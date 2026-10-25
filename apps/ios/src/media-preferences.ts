import { QUALITIES, type LiveChannel, type Quality } from "@mrstreamer/contracts/library";
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

/** Each subscription's chosen stream per channel, by channel id: what core's chosenVariant reads. */
type ChannelPicks = Readonly<Record<string, Readonly<Record<string, string>>>>;
const channelPicksShape = (value: unknown): value is ChannelPicks =>
  record(value) &&
  Object.values(value).every(
    (channels) =>
      record(channels) && Object.values(channels).every((stream) => typeof stream === "string"),
  );

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

/**
 * Only accepted, durable choices. Opaque subscription, channel and stream ids appear solely as
 * per-channel quality keys (`channelPicks`); no source, login, address, file or native track
 * identity belongs here.
 */
export const getMediaPreferences = (): MediaPreferences => saved().get();
export const useMediaPreferences = (): MediaPreferences => useStore(saved());
export const onMediaPreferences = (listener: () => void): (() => void) =>
  saved().subscribe(listener);

/** The device's language, as the title owner reads it, kept when it isn't an offered choice. */
const deviceLanguage = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language;

/** The language titles and follow-title sound use: the saved choice, else the device's. */
export const effectiveTitleLanguage = (): string =>
  getMediaPreferences().titleLanguage ?? deviceLanguage;

/**
 * Makes `next` the accepted contents, for every writer of this file. True once the primary holds
 * it. False when the file is read-only or the disk refuses: the accepted contents and published
 * values stay as they were, and the next launch prefers the accepted backup to the refused
 * proposal. That is not a promise the files are untouched: a checkpoint that succeeded stays
 * committed when the primary write then fails, and the primary may already be deleted.
 */
function propose(next: Record<string, unknown>): boolean {
  if (!writable) return false;
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
  return true;
}

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
  if (!propose({ ...contents, version: 1, [field]: value })) return false;
  source.set(accepted({ ...current, [field]: value }));
  return true;
}

/** The accepted picks to change: none saved reads as empty, a shape this build doesn't know as null. */
function changeablePicks(): ChannelPicks | null {
  saved();
  const picks = contents["channelVariants"];
  if (picks === undefined) return {};
  return channelPicksShape(picks) ? picks : null;
}

/** Proposes `subscriptionId`'s picks, leaving every other subscription's and field as accepted. */
function proposePicks(
  picks: ChannelPicks,
  subscriptionId: string,
  channels: Readonly<Record<string, string>>,
): boolean {
  const { [subscriptionId]: _replaced, ...others } = picks;
  const next =
    Object.keys(channels).length > 0 ? { ...others, [subscriptionId]: channels } : others;
  return propose({ ...contents, version: 1, channelVariants: next });
}

const samePicks = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([channel, stream]) => b[channel] === stream);

/**
 * One subscription's chosen stream per channel, by channel id, as accepted: what core's
 * chosenVariant reads. Empty for Automatic everywhere, and while the saved picks are in a shape
 * this build doesn't know.
 */
export function channelPicks(subscriptionId: string): Readonly<Record<string, string>> {
  return changeablePicks()?.[subscriptionId] ?? {};
}

/**
 * Saves `streamId` as the channel's stream, or Automatic for null. Picks kept under the
 * channel's other stream ids go, as chosenVariant would read any of them. True once accepted,
 * or when that is already the accepted choice. False saves nothing, for a stream the channel
 * doesn't list, picks in a shape this build doesn't know, a read-only file or a refused write:
 * the accepted picks stay, now and at the next launch.
 */
export function updateChannelPick(
  channel: Pick<LiveChannel, "subscriptionId" | "id" | "variants">,
  streamId: string | null,
): boolean {
  if (streamId !== null && !channel.variants.some(({ id }) => id === streamId)) return false;
  const picks = changeablePicks();
  if (!picks) return false;
  const aliases = new Set([channel.id, ...channel.variants.map(({ id }) => id)]);
  const before = picks[channel.subscriptionId] ?? {};
  const others = Object.fromEntries(Object.entries(before).filter(([id]) => !aliases.has(id)));
  const after = streamId === null ? others : { ...others, [channel.id]: streamId };
  if (samePicks(before, after)) return true;
  return proposePicks(picks, channel.subscriptionId, after);
}

/**
 * Forgets every pick of one subscription, as erasing its history does. True once none is left,
 * at once when there were none. False keeps them: picks in a shape this build doesn't know, a
 * read-only file or a refused write.
 */
export function forgetChannelPicks(subscriptionId: string): boolean {
  const picks = changeablePicks();
  if (!picks) return false;
  if (!Object.hasOwn(picks, subscriptionId)) return true;
  return proposePicks(picks, subscriptionId, {});
}
