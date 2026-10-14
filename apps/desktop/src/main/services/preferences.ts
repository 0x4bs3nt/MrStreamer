import { homeRows } from "@mrstreamer/core/home/rows";
import { isDeepStrictEqual } from "node:util";
import type { UsageObservers } from "../analytics/observers.ts";
import { DEFAULT_LIVE_QUALITY, DEFAULT_SUBTITLE_LOOK } from "@mrstreamer/contracts/preferences";
// Viewing settings in preferences.json. Two kinds share the file, as they always have, so the
// newest stable release reads and writes it too. Preferences hold whichever subscription plays:
// volume, mute, languages, the quality live channels start in. What the viewer left a subscription
// at is that subscription's alone, because every id in it is its provider's own: the last channel
// and category, and the versions and streams picked. The file keeps those of the original
// subscription, the one older releases know; a subscription added beside it keeps its own in a
// preferences.json in its folder, which holds nothing else. Those are read and changed by naming
// the subscription, and one that isn't saved has none. Reads and changes take turns at the files,
// and one that names a subscription checks that it is saved when its turn comes: the subscription
// may have gone while it waited. The interface language is kept beside them, and changed only
// through `setInterfaceLanguage`.
import { join } from "node:path";
import type { LanguageChoice } from "@mrstreamer/contracts/language";
import {
  defaultPreferences,
  defaultSubscriptionPreferences,
  Preferences,
  SubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";
import { Subscriptions, type SavedSubscription } from "./subscription.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

/**
 * preferences.json as stored: the preferences, and what the viewer left the original subscription
 * at. Files from before the viewing record also carry its two lists; they stay in the file until
 * the record has imported them. Keys of newer versions are kept.
 */
const Stored = lazy(() =>
  Preferences().merge(SubscriptionPreferences()).merge({
    "favouriteChannelIds?": "string[]",
    "recentChannelIds?": "string[]",
    /**
     * The interface language picked in Settings: a `Locale`, or "system". Any string, so a language
     * a later release adds doesn't make this one drop the file. System default when absent.
     */
    "interfaceLanguage?": "string",
  }),
);
type Stored = Infer<typeof Stored>;

export class Settings extends Context.Service<
  Settings,
  {
    readonly get: Effect.Effect<Preferences>;
    update(patch: Partial<Preferences>): Effect.Effect<Preferences>;
    /** The interface language as saved, which may be one this release doesn't know. */
    readonly interfaceLanguage: Effect.Effect<string | undefined>;
    setInterfaceLanguage(choice: LanguageChoice): Effect.Effect<void>;
    /**
     * What the viewer left the subscription at. Fails with `no-subscription`, as changing it
     * does, when that subscription isn't saved.
     */
    ofSubscription(subscriptionId: string): Effect.Effect<SubscriptionPreferences, Failed>;
    updateSubscription(
      subscriptionId: string,
      patch: Partial<SubscriptionPreferences>,
    ): Effect.Effect<SubscriptionPreferences, Failed>;
    /**
     * Forgets what the viewer left `subscription` at, for when it goes: what was watched last and
     * the versions and channel streams picked. For the original, lists not yet imported go too:
     * they belong to its account.
     */
    forget(subscription: SavedSubscription): Effect.Effect<void>;
    /** The favourites and recent channels of a file from before the viewing record, or null. */
    readonly legacyLists: Effect.Effect<{
      readonly favourites: readonly string[];
      readonly recent: readonly string[];
    } | null>;
    /** Takes the lists out of the file, once the viewing record has them. */
    readonly dropLegacyLists: Effect.Effect<void>;
  }
>()("mrstreamer/Settings") {
  /** Settings in `dataDir`. */
  static readonly layer = (dataDir: string, usage?: UsageObservers) =>
    Layer.effect(Settings, make(dataDir, usage));
}

function make(dataDir: string, usage?: UsageObservers) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const path = join(dataDir, "preferences.json");
    const one = yield* Semaphore.make(1);
    let current: Stored | null = null;
    /** What the viewer left each added subscription at, by its id, as last read or written. */
    const added = new Map<string, SubscriptionPreferences>();

    /** The file as last read or written. Only runs while holding `one`. */
    const stored = Effect.promise(async () => {
      current ??= (await readJsonFile(path, Stored())) ?? {
        ...defaultPreferences,
        ...defaultSubscriptionPreferences,
      };
      return current;
    });

    /** Applies a change to the file and writes it. Only runs while holding `one`. */
    const applied = (apply: (previous: Stored) => Stored) =>
      Effect.gen(function* () {
        const previous = yield* stored;
        const next = apply(previous);
        const changed = preferenceChanges(previous, next).map((key) => usage?.setting(key));
        yield* Effect.promise(() => writeJsonFile(path, next));
        current = next;
        for (const note of changed) note?.();
        return next;
      });

    const change = (apply: (previous: Stored) => Stored) => one.withPermits(1)(applied(apply));

    /** The saved subscription `subscriptionId` names, also while its secret can't be read. */
    const saved = (subscriptionId: string) =>
      Effect.flatMap(subscriptions.saved, (all) => {
        const found = all.find((each) => each.id === subscriptionId);
        return found
          ? Effect.succeed(found)
          : Effect.fail(new Failed({ error: { kind: "no-subscription" } }));
      });

    /**
     * Runs `run` for the subscription `subscriptionId` names while it is saved. It is looked up
     * with the files in hand, not before: a call can wait behind others, and by its turn the
     * subscription may have gone.
     */
    const whileSaved = <A>(
      subscriptionId: string,
      run: (subscription: SavedSubscription) => Effect.Effect<A>,
    ) => one.withPermits(1)(Effect.flatMap(saved(subscriptionId), run));

    const addedPath = (subscription: SavedSubscription) =>
      join(subscription.dir, "preferences.json");

    /** What the viewer left an added subscription at. Only runs while holding `one`. */
    const ofAdded = (subscription: SavedSubscription) =>
      Effect.promise(async () => {
        const kept =
          added.get(subscription.id) ??
          (await readJsonFile(addedPath(subscription), SubscriptionPreferences())) ??
          defaultSubscriptionPreferences;
        added.set(subscription.id, kept);
        return kept;
      });

    return {
      get: one.withPermits(1)(Effect.map(stored, general)),
      update: (patch: Partial<Preferences>) =>
        Effect.map(
          change((previous) => ({ ...previous, ...patch })),
          general,
        ),
      interfaceLanguage: one.withPermits(1)(Effect.map(stored, (file) => file.interfaceLanguage)),
      setInterfaceLanguage: (choice: LanguageChoice) =>
        Effect.asVoid(change((previous) => ({ ...previous, interfaceLanguage: choice }))),
      ofSubscription: (subscriptionId: string) =>
        whileSaved(subscriptionId, (subscription) =>
          subscription.original ? Effect.map(stored, ofOriginal) : ofAdded(subscription),
        ),
      updateSubscription: (subscriptionId: string, patch: Partial<SubscriptionPreferences>) =>
        whileSaved(subscriptionId, (subscription) =>
          subscription.original
            ? Effect.map(
                applied((previous) => ({ ...previous, ...patch })),
                ofOriginal,
              )
            : Effect.gen(function* () {
                const next = { ...(yield* ofAdded(subscription)), ...patch };
                yield* Effect.promise(() => writeJsonFile(addedPath(subscription), next));
                added.set(subscription.id, next);
                return next;
              }),
        ),
      forget: (subscription: SavedSubscription) =>
        subscription.original
          ? Effect.asVoid(
              // The interface language is the viewer's, not the subscription's: it stays.
              change(({ interfaceLanguage, ...previous }) => ({
                ...general(previous),
                ...defaultSubscriptionPreferences,
                ...(interfaceLanguage === undefined ? {} : { interfaceLanguage }),
              })),
            )
          : // Its folder went with it: only what was read of it is left to forget.
            one.withPermits(1)(Effect.sync(() => void added.delete(subscription.id))),
      legacyLists: one.withPermits(1)(
        Effect.map(stored, ({ favouriteChannelIds, recentChannelIds }) =>
          favouriteChannelIds || recentChannelIds
            ? { favourites: favouriteChannelIds ?? [], recent: recentChannelIds ?? [] }
            : null,
        ),
      ),
      dropLegacyLists: Effect.gen(function* () {
        const { favouriteChannelIds, recentChannelIds } = yield* one.withPermits(1)(stored);
        if (favouriteChannelIds || recentChannelIds) {
          yield* change(({ favouriteChannelIds: _f, recentChannelIds: _r, ...kept }) => kept);
        }
      }),
    };
  });
}

/**
 * The file's preferences, without what belongs to its subscription or to the viewing record, or
 * the interface language.
 */
function general({
  lastChannelId: _channel,
  lastCategoryId: _category,
  titleVersions: _versions,
  channelVariants: _variants,
  favouriteChannelIds: _favourites,
  recentChannelIds: _recent,
  interfaceLanguage: _language,
  ...preferences
}: Stored): Preferences {
  return preferences;
}

/** What the file keeps for the original subscription. */
function ofOriginal({
  lastChannelId,
  lastCategoryId,
  titleVersions,
  channelVariants,
}: Stored): SubscriptionPreferences {
  return {
    lastChannelId,
    lastCategoryId,
    ...(titleVersions ? { titleVersions } : {}),
    ...(channelVariants ? { channelVariants } : {}),
  };
}

/** Compare effective defaults inside the file serializer. Values never leave Settings. */
function preferenceChanges(before: Stored, after: Stored) {
  const keys = [
    [
      "interface_language",
      before.interfaceLanguage ?? "system",
      after.interfaceLanguage ?? "system",
    ],
    ["audio_language", before.audioLanguage ?? null, after.audioLanguage ?? null],
    ["subtitle_language", before.subtitleLanguage ?? null, after.subtitleLanguage ?? null],
    ["title_language", before.titleLanguage ?? "en", after.titleLanguage ?? "en"],
    [
      "live_quality",
      before.liveQuality ?? DEFAULT_LIVE_QUALITY,
      after.liveQuality ?? DEFAULT_LIVE_QUALITY,
    ],
    ["autoplay_next", before.autoplayNext ?? true, after.autoplayNext ?? true],
    [
      "subtitle_look",
      before.subtitleLook ?? DEFAULT_SUBTITLE_LOOK,
      after.subtitleLook ?? DEFAULT_SUBTITLE_LOOK,
    ],
    ["home_rows", homeRows(before.homeRows), homeRows(after.homeRows)],
  ] as const;
  return keys
    .filter(([, previous, next]) => !isDeepStrictEqual(previous, next))
    .map(([key]) => key);
}
