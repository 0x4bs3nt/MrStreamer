import { type } from "arktype";
import { LiveDiscovery, RememberedLiveBrowse } from "@mrstreamer/contracts/live-browse";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { homeRows } from "@mrstreamer/core/home/rows";
import { isDeepStrictEqual } from "node:util";
import type { UsageObservers } from "../analytics/observers.ts";
import {
  DEFAULT_LIVE_QUALITY,
  DEFAULT_NEXT_EPISODE_DELAY,
  DEFAULT_SUBTITLE_LOOK,
} from "@mrstreamer/contracts/preferences";
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
    /** Preserve malformed and future values until the viewer explicitly replaces this leaf. */
    "nextEpisodeDelaySeconds?": "unknown",
    "favouriteChannelIds?": "string[]",
    "recentChannelIds?": "string[]",
    /**
     * The interface language picked in Settings: a `Locale`, or "system". Any string, so a language
     * a later release adds doesn't make this one drop the file. System default when absent.
     */
    "interfaceLanguage?": "string",
    "rememberedLiveBrowse?": "unknown",
  }),
);
type Stored = Infer<typeof Stored>;

export class Settings extends Context.Service<
  Settings,
  {
    readonly get: Effect.Effect<Preferences>;
    /** Discovery only. Personal lists and session filters never reach this file. */
    readonly liveBrowse: Effect.Effect<LiveDiscovery>;
    rememberLiveBrowse(selection: LiveDiscovery): Effect.Effect<LiveDiscovery, Failed>;
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
     * they belong to its account. Snapshot effective discovery before the folder is removed, so
     * a prior stable category edit keeps precedence while the surviving baseline changes. The
     * returned effect settles admitted writes after logical removal and before folder deletion.
     * A newer explicit choice wins over the captured one.
     */
    prepareForget(subscription: SavedSubscription): Effect.Effect<Effect.Effect<void>>;

    /** The favourites and recent channels of a file from before the viewing record, or null. */
    readonly legacyLists: Effect.Effect<{
      readonly favourites: readonly string[];
      readonly recent: readonly string[];
    } | null>;
    /** Takes the lists out of the file, once the viewing record has them. */
    readonly dropLegacyLists: Effect.Effect<void>;
  }
>()("mrstreamer/Settings") {
  /** Reads the saved choice before the runtime exists, so startup errors use its language. */
  static async readInterfaceLanguage(dataDir: string): Promise<string | undefined> {
    const saved = await readJsonFile(join(dataDir, "preferences.json"), Stored());
    return saved?.interfaceLanguage;
  }

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

    /**
     * Applies a change while holding `one`. The native write and in-memory publication finish
     * in that same turn even if the caller cancels.
     */
    const applied = (apply: (previous: Stored) => Stored) =>
      Effect.gen(function* () {
        const previous = yield* stored;
        const next = apply(previous);
        const changed = preferenceChanges(previous, next).map((key) => usage?.setting(key));
        yield* Effect.promise(() => writeJsonFile(path, next));
        current = next;
        for (const note of changed) note?.();
        return next;
      }).pipe(Effect.uninterruptible);

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

    /** Commits the added source's file and cached value together while holding `one`. */
    const saveAdded = (subscription: SavedSubscription, next: SubscriptionPreferences) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeJsonFile(addedPath(subscription), next));
        added.set(subscription.id, next);
        return next;
      }).pipe(Effect.uninterruptible);

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

    const leftAt = (subscription: SavedSubscription) =>
      subscription.original ? Effect.map(stored, ofOriginal) : ofAdded(subscription);

    /** The one pair startup in prior stable would restore, not every subscription's history. */
    const legacy = (saved: readonly SavedSubscription[]) =>
      Effect.gen(function* () {
        for (const subscription of saved) {
          const { lastCategoryId } = yield* leftAt(subscription);
          if (lastCategoryId !== null)
            return { subscriptionId: subscription.id, id: lastCategoryId };
        }
        return null;
      });
    const readBrowse = Effect.gen(function* () {
      const saved = yield* subscriptions.saved;
      const baseline = yield* legacy(saved);
      const raw = RememberedLiveBrowse()((yield* stored).rememberedLiveBrowse);
      if (!(raw instanceof type.errors) && sameBaseline(raw.legacy, baseline)) {
        if (raw.selection.kind === "topic" && saved.length > 0)
          return discoverySelection(raw.selection);
        const selection = raw.selection;
        if (
          selection.kind === "category" &&
          saved.some((each) => each.id === selection.category.subscriptionId)
        )
          return discoverySelection(selection);
      }
      return baseline
        ? { kind: "category" as const, category: baseline }
        : { kind: "all" as const };
    });
    const writeLeft = (subscription: SavedSubscription, lastCategoryId: string | null) =>
      Effect.gen(function* () {
        const previous = yield* leftAt(subscription);
        if (previous.lastCategoryId === lastCategoryId) return;
        if (subscription.original) yield* applied((file) => ({ ...file, lastCategoryId }));
        else {
          yield* saveAdded(subscription, { ...previous, lastCategoryId });
        }
      });

    return {
      get: one.withPermits(1)(Effect.map(stored, effective)),
      liveBrowse: one.withPermits(1)(readBrowse),
      rememberLiveBrowse: (input: LiveDiscovery) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const selection = discoverySelection(input);
            const all = yield* subscriptions.saved;
            if (all.length === 0 && selection.kind !== "all")
              return yield* new Failed({ error: { kind: "no-subscription" } });
            if (selection.kind === "category") yield* saved(selection.category.subscriptionId);
            if (selection.kind !== "topic") {
              for (const subscription of all)
                yield* writeLeft(
                  subscription,
                  selection.kind === "category" &&
                    selection.category.subscriptionId === subscription.id
                    ? selection.category.id
                    : null,
                );
            }
            const baseline = yield* legacy(all);
            yield* applied(({ rememberedLiveBrowse: _old, ...file }) =>
              selection.kind === "all"
                ? file
                : {
                    ...file,
                    rememberedLiveBrowse: { version: 1, selection, legacy: baseline },
                  },
            );
            return discoverySelection(selection);
          }),
        ),
      update: (patch: Partial<Preferences>) =>
        Effect.map(
          change((previous) => ({ ...previous, ...patch })),
          effective,
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
                return yield* saveAdded(subscription, next);
              }),
        ),
      prepareForget: (subscription: SavedSubscription) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const before = (yield* stored).rememberedLiveBrowse;
            const selectionBeforeRemoval = yield* readBrowse;
            return one.withPermits(1)(
              Effect.gen(function* () {
                const previous = yield* stored;
                const raw = previous.rememberedLiveBrowse;
                const record = RememberedLiveBrowse()(raw);
                const remaining = (yield* subscriptions.saved).filter(
                  (each) => each.id !== subscription.id,
                );
                // Unknown future records survive both removal paths verbatim.
                let rememberedLiveBrowse = raw;
                if (!(record instanceof type.errors)) {
                  const selection = raw === before ? selectionBeforeRemoval : record.selection;
                  const valid =
                    remaining.length > 0 &&
                    (selection.kind === "topic" ||
                      remaining.some(
                        (each) =>
                          selection.kind === "category" &&
                          each.id === selection.category.subscriptionId,
                      ));
                  rememberedLiveBrowse = valid
                    ? { ...record, selection, legacy: yield* legacy(remaining) }
                    : undefined;
                }
                if (subscription.original || !(record instanceof type.errors)) {
                  yield* applied((file) => {
                    const { rememberedLiveBrowse: _remembered, ...kept } = subscription.original
                      ? {
                          ...general(file),
                          ...defaultSubscriptionPreferences,
                          ...(file.interfaceLanguage === undefined
                            ? {}
                            : { interfaceLanguage: file.interfaceLanguage }),
                        }
                      : file;
                    return {
                      ...kept,
                      ...(rememberedLiveBrowse === undefined ? {} : { rememberedLiveBrowse }),
                    };
                  });
                }
                added.delete(subscription.id);
              }),
            );
          }),
        ),
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
 * the interface language or remembered discovery.
 */
function general({
  lastChannelId: _channel,
  lastCategoryId: _category,
  titleVersions: _versions,
  channelVariants: _variants,
  favouriteChannelIds: _favourites,
  recentChannelIds: _recent,
  interfaceLanguage: _language,
  rememberedLiveBrowse: _browse,
  ...preferences
}: Stored) {
  return preferences;
}

/** Normalize replies only. File reconstruction must keep unsupported raw values intact. */
function effective(file: Stored): Preferences {
  const { nextEpisodeDelaySeconds, ...preferences } = general(file);
  return {
    ...preferences,
    nextEpisodeDelaySeconds:
      typeof nextEpisodeDelaySeconds === "number" &&
      Number.isInteger(nextEpisodeDelaySeconds) &&
      nextEpisodeDelaySeconds >= 0 &&
      nextEpisodeDelaySeconds <= 60
        ? nextEpisodeDelaySeconds
        : DEFAULT_NEXT_EPISODE_DELAY,
  };
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

function sameBaseline(a: OwnedId | null, b: OwnedId | null): boolean {
  return a === null ? b === null : b !== null && sameOwned(a, b);
}

/** Only supported discovery fields are effective; raw future extras stay in the stored leaf. */
function discoverySelection(selection: LiveDiscovery): LiveDiscovery {
  return selection.kind === "topic"
    ? { kind: "topic", topic: selection.topic }
    : selection.kind === "category"
      ? { kind: "category", category: ownedId(selection.category) }
      : { kind: "all" };
}
