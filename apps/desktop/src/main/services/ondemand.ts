import { listedFileKey } from "@mrstreamer/core/ondemand/files";
// Movies and series: the catalogue lives in a worker thread (see ../ondemand/catalogue-worker.ts),
// details come from the provider and TMDB when a title opens, never before, TMDB's episodes when
// their season opens, and playback asks here which file to stream. A title's details don't wait
// for TMDB: what it says joins them once it arrives, and `detailsChanged` says so.
// A title, version or episode a call names says which subscription lists it, and one of a
// subscription that isn't saved finds nothing. The lists are those of every saved subscription
// that has movies and series, shown as one catalogue: an unmapped playlist adds none.
// Each subscription's lists are fetched, kept and reported on their own, so one that can't be
// reached keeps what it loaded and holds no other back.
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  CollectionId,
  CollectionPage,
  CollectionRow,
  CollectionSort,
  CollectionTile,
  Episode,
  EpisodeDetails,
  MetadataProgress,
  OnDemandStatus,
  RelatedTitles,
  HomeRecommendation,
  HomeSeed,
  RowTab,
  Season,
  Title,
  TitleDetails,
  TitleKind,
  TitleListsStatus,
  TitleMatches,
  TitleRef,
} from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { hasTitles, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistPage } from "@mrstreamer/contracts/watchlist";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { currentLanguage, t } from "@mrstreamer/core/i18n";
import {
  tmdb,
  GENRES,
  TmdbError,
  type EpisodeAbout,
  type TitleAbout,
  type Tmdb,
} from "@mrstreamer/core/metadata/tmdb";
import { movieDetails, seasonEpisodes, seriesDetails } from "@mrstreamer/core/ondemand/details";
import { DEFAULT_TITLE_LANGUAGE } from "@mrstreamer/core/ondemand/languages";
import { titleName } from "@mrstreamer/core/ondemand/names";
import { qualityHint } from "@mrstreamer/core/ondemand/filters";
import type { FilterOptions, TitleFilters } from "@mrstreamer/contracts/title-filters";
import type { SavedTitle, TitleFacts } from "@mrstreamer/core/ondemand/watchlist";
import type { ProviderDetails } from "@mrstreamer/core/provider";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type {
  CatalogueOwner,
  KnownFile,
  SavedQuery,
  WorkerCalls,
  WorkerEvent,
  WorkerMethod,
  WorkerReply,
  WorkerSetup,
  WorkerStatus,
} from "../ondemand/protocol.ts";
import { VerifiedFiles } from "../platform/verified-files.ts";
import { Settings } from "./preferences.ts";
import {
  Subscriptions,
  sameSource,
  type SavedSubscription,
  type Source,
  type PlaylistRefresh,
} from "./subscription.ts";

/** How many titles' details stay in memory. Opening one again then asks no one. */
const DETAILS_KEPT = 200;
/** How many seasons TMDB described stay in memory, each in one language. */
const SEASONS_KEPT = 100;
/** How long TMDB gets to describe a title, or a season; the provider's details stand after that. */
const ABOUT_TIMEOUT_MS = 4000;
/** Search results a Movies or Series page shows; a longer list needs more words. */
const SEARCH_PAGE = 300;

/**
 * How long after a failed first fetch a list asked for fails with it rather than fetching again.
 * Every list the UI shows asks again when the status changes, and the failure changes it.
 */
const RETRY_AFTER_MS = 60_000;
/** How many subscriptions' lists are fetched at a time. */
const FETCHES_AT_ONCE = 2;
/** How long a worker that is stopping gets to write what it still holds. */
const STOP_WITHIN_MS = 2000;
/** A subscription whose lists aren't loaded. */
const NOTHING: WorkerStatus = { movies: 0, series: 0, fetchedAt: null };

export interface OnDemandDeps {
  readonly dataDir: string;
  readonly userAgent: string;
  /** Starts the catalogue worker: the bundled one in the app, the source file in tests. */
  readonly worker: (setup: WorkerSetup) => Worker;
  /** The app's TMDB key, built in; the viewer's own, from the settings, comes first. */
  readonly tmdbKey: string | null;
  /** ISO 3166-1 country whose streaming services to follow: "NL". */
  readonly region: string;
  /** Another TMDB API, for tests. */
  readonly tmdbApi?: string;
}

/** Which page of which collection. */
export interface CollectionQuery {
  readonly kind: TitleKind;
  readonly id: CollectionId;
  readonly sort?: CollectionSort | undefined;
  readonly offset: number;
  readonly limit: number;
  readonly filters?: TitleFilters;
}

/** Where a movie or episode streams from. Contains the login, so it stays in the main process. */
export interface TitleFile {
  readonly url: string;
  readonly container: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The login the address was made under: `SavedSubscription.revision`. */
  readonly revision: number;
  /** The cached provider row this exact file was resolved from. */
  readonly listingKey: string;
}

export class OnDemand extends Context.Service<
  OnDemand,
  {
    readonly status: Effect.Effect<OnDemandStatus>;
    /**
     * Current exact-file identity for subtitle search, or null once the catalogue no longer lists
     * that file as `listingKey`. Reads the loaded lists and the details kept from opening the
     * title. An episode's still listed series is asked of the provider again, once, after its
     * lists were refreshed or its details were no longer kept: the same listing keeps its
     * identity, another one or no answer gives null.
     */
    subtitleQuery(
      title: TitleRef,
      listingKey: string,
    ): Effect.Effect<
      {
        readonly tmdbId: string | null;
        readonly title: string;
        readonly year: number | null;
        readonly season?: number;
        readonly episode?: number;
      } | null,
      Failed
    >;
    /**
     * Fetches a subscription's two lists. Concurrent calls for one subscription share a fetch,
     * and a few subscriptions fetch at a time. Lists that arrive after the subscription's login
     * changed are dropped: it fails, and those from before stay. A supplied playlist snapshot
     * waits for an earlier refresh to finish, so its lists are accepted separately.
     */
    refresh(
      subscriptionId: string,
      playlist?: PlaylistRefresh,
    ): Effect.Effect<OnDemandStatus, Failed>;
    /**
     * Whether a subscription's lists should be fetched again: missing, or older than `maxAge`.
     * Never for an unmapped playlist, which has Live TV only.
     */
    isStale(subscriptionId: string, maxAge: Duration.Input): Effect.Effect<boolean>;
    search(
      query: string,
    ): Effect.Effect<
      { readonly movies: readonly Title[]; readonly series: readonly Title[] },
      Failed
    >;
    /** Movies or series matching `query`: the best SEARCH_PAGE, and how many match. */
    searchKind(
      kind: TitleKind,
      query: string,
      filters?: TitleFilters,
    ): Effect.Effect<TitleMatches, Failed>;
    filterOptions(kind: TitleKind): Effect.Effect<FilterOptions, Failed>;
    /**
     * A version's details, for when the viewer opens it: the provider's, with TMDB's once it has
     * answered. They come as soon as the provider answers; `detailsChanged` says when TMDB's
     * arrive later. Fails with `no-subscription` when the version's subscription isn't saved.
     */
    details(kind: TitleKind, version: OwnedId): Effect.Effect<TitleDetails, Failed>;
    /** Related titles from lists already in memory. Never opens another library or file. */
    related(kind: TitleKind, version: OwnedId): Effect.Effect<RelatedTitles, Failed>;
    recommendations(
      seeds: readonly HomeSeed[],
    ): Effect.Effect<readonly HomeRecommendation[], Failed>;
    /**
     * The episodes of season `season` of a series version, for when the viewer opens it: the
     * provider's, with TMDB's details.
     */
    season(series: OwnedId, season: number): Effect.Effect<readonly EpisodeDetails[], Failed>;
    /** Titles by any of their versions, from the lists alone. */
    titles(kind: TitleKind, versions: readonly OwnedId[]): Effect.Effect<readonly Title[], Failed>;
    /** A tab's rows; For you starts with titles like `like`, a version of one watched lately. */
    rows(
      kind: TitleKind,
      tab: RowTab,
      like?: OwnedId,
    ): Effect.Effect<readonly CollectionRow[], Failed>;
    /** Genres or streaming services as tiles. */
    tiles(
      kind: TitleKind,
      of: "genres" | "services",
    ): Effect.Effect<readonly CollectionTile[], Failed>;
    /** One page of a collection. */
    collection(query: CollectionQuery): Effect.Effect<CollectionPage, Failed>;
    /**
     * A page of the watchlist that what `subscriptions` saved makes together: each entry with
     * the title it is in their lists now, without titles for adults unless the viewer shows them.
     * From the lists as they are: nothing is fetched, and a subscription without lists gives its
     * entries no title.
     */
    saved(
      subscriptions: readonly SavedSubscription[],
      query: SavedQuery,
    ): Effect.Effect<WatchlistPage, Failed>;
    /**
     * What the lists say now about the titles `entries`, saved by `of`, are: each once, as `of`
     * lists it; null while none of its lists are loaded. Asks the provider nothing.
     */
    savedFacts(
      subscriptions: readonly SavedSubscription[],
      of: SavedSubscription,
      entries: readonly SavedTitle[],
    ): Effect.Effect<readonly TitleFacts[] | null, Failed>;
    /** The file a movie or episode streams from, at the provider of the subscription it names. */
    file(title: TitleRef): Effect.Effect<TitleFile, Failed>;
    /** Forgets a subscription's lists and details, for when it goes. */
    forget(subscription: SavedSubscription): Effect.Effect<void>;
    /** Applies a changed TMDB key from the settings: the worker starts again with it. */
    readonly reconfigure: Effect.Effect<void>;
    /** The status after every refresh, successful or not. */
    readonly changes: Stream.Stream<OnDemandStatus>;
    /** TMDB's progress when only it moved, which leaves the lists as they were. */
    readonly progressChanges: Stream.Stream<OnDemandStatus["metadata"]>;
    /** A title whose details were given before TMDB's arrived, now that they have. */
    readonly detailsChanged: Stream.Stream<TitleKey>;
  }
>()("mrstreamer/OnDemand") {
  static readonly layer = (deps: OnDemandDeps) => Layer.effect(OnDemand, make(deps));
}

/** A movie or series version. */
interface TitleKey extends OwnedId {
  readonly kind: TitleKind;
}

/**
 * What opening a title downloaded from the provider, as of the refresh of the lists that `lists`
 * counts, with the title as the lists showed it then, for when they no longer list it.
 */
interface Downloaded {
  readonly raw: ProviderDetails;
  readonly lists: number;
  readonly title: Title;
  readonly version: OwnedId;
  readonly sourceRevision: number;
}

function make(deps: OnDemandDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const settings = yield* Settings;
    const verifiedFiles = Option.getOrNull(yield* Effect.serviceOption(VerifiedFiles));
    /** The language whose versions titles show and play first. */
    const language = Effect.map(
      settings.get,
      (preferences) => preferences.titleLanguage ?? DEFAULT_TITLE_LANGUAGE,
    );
    const updates = yield* PubSub.unbounded<OnDemandStatus>();
    const progress = yield* PubSub.unbounded<OnDemandStatus["metadata"]>();
    const detailed = yield* PubSub.unbounded<TitleKey>();
    const scope = yield* Effect.scope;
    /** The TMDB key the worker runs with: the viewer's own, or the app's. */
    const keyOf = (preferences: { readonly tmdbKey?: string }) =>
      preferences.tmdbKey?.trim() || deps.tmdbKey;
    let tmdbKey = keyOf(yield* settings.get);
    let metadataProgress: MetadataProgress = {
      known: 0,
      wanted: 0,
      refused: false,
      fetching: false,
    };
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() =>
        workerClient(
          () =>
            deps.worker({
              metadataPath: join(deps.dataDir, "metadata.json.gz"),
              userAgent: deps.userAgent,
              tmdb: tmdbKey
                ? {
                    key: tmdbKey,
                    region: deps.region,
                    ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}),
                  }
                : null,
            }),
          (event) => {
            metadataProgress = event.status;
            // New content has the UI refetch what it shows, with the lists' status. Without, the
            // UI only takes TMDB's progress, and reads nothing again.
            Effect.runFork(event.content ? publishStatus : publishProgress);
          },
        ),
      ),
      (client) => Effect.promise(() => client.stop()),
    );
    /** Why each subscription's latest refresh failed, by its id, until one succeeds. */
    const failures = new Map<string, { readonly error: AppError; readonly at: number }>();
    /** Owns a refresh through acceptance, including the wait for a title-fetch slot. */
    const refreshing = new Map<
      string,
      {
        readonly source: Source;
        readonly token: object;
        readonly fiber: Fiber.Fiber<void, Failed>;
      }
    >();
    /** Counts restarts of the worker. */
    let generation = 0;
    /**
     * Rises, per subscription, with each refresh of its lists. Details downloaded before ask the
     * provider again, as it may list new episodes.
     */
    const listsVersions = new Map<string, number>();
    const listsOf = (subscriptionId: string) => listsVersions.get(subscriptionId) ?? 0;
    /** What opening a title downloaded, by subscription, language, kind and id, oldest first. */
    const details = new Map<string, Downloaded>();
    /**
     * What TMDB said about the titles opened, by the same keys; null where TMDB doesn't have the
     * title. One it didn't answer about, or had no key for, isn't kept, so opening it asks again.
     */
    const abouts = new Map<string, TitleAbout | null>();
    /** The questions to TMDB about titles on their way, by the same keys. */
    const asking = new Map<string, Fiber.Fiber<void>>();
    /** Of those, the ones whose details were given without TMDB's. */
    const late = new Set<string>();
    /**
     * What TMDB said about the seasons opened, by TMDB id, season and language, oldest first;
     * null where TMDB doesn't have the season.
     */
    const seasons = new Map<string, readonly EpisodeAbout[] | null>();
    const fetchOne = (yield* Semaphore.make(FETCHES_AT_ONCE)).withPermits(1);
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });

    const call = <M extends WorkerMethod>(method: M, args: WorkerCalls[M]["args"]) =>
      Effect.tryPromise({
        try: () => worker.call(method, args),
        catch: (cause) => (cause instanceof Failed ? cause : failedWith(cause)),
      });

    /** Whose lists a call to the worker is about. */
    const ownerOf = ({ id, key, dir, importRevision }: SavedSubscription): CatalogueOwner => ({
      subscriptionId: id,
      key,
      dir,
      ...(importRevision ? { importRevision } : {}),
    });

    /** The saved subscriptions with movies and series, in their order: Xtream and explicitly mapped playlists. */
    const listed = Effect.map(subscriptions.saved, (saved) => saved.filter(hasTitles));

    /**
     * Each of those with what the worker holds of its lists, telling the worker whether the
     * viewer shows titles for adults.
     */
    const held = Effect.gen(function* () {
      const saved = yield* listed;
      if (saved.length === 0) return [];
      const adults = (yield* settings.get).adultTitles ?? false;
      const worked = yield* call("status", { owners: saved.map(ownerOf), adults });
      return saved.map((subscription, at) => ({ subscription, worked: worked[at] ?? NOTHING }));
    });

    const statusOf = (subscriptionId: string, worked: WorkerStatus): TitleListsStatus => ({
      subscriptionId,
      ...worked,
      failure: failures.get(subscriptionId)?.error ?? null,
    });

    const status = Effect.gen(function* () {
      const found = yield* held.pipe(
        // A worker that doesn't answer says nothing of the lists: they count as not loaded.
        Effect.catchTag("Failed", () =>
          Effect.map(listed, (saved) =>
            saved.map((subscription) => ({ subscription, worked: NOTHING })),
          ),
        ),
      );
      return {
        lists: found.map(({ subscription, worked }) => statusOf(subscription.id, worked)),
        metadata: tmdbKey ? metadataProgress : null,
      } satisfies OnDemandStatus;
    });
    const publishStatus = Effect.flatMap(status, (current) => PubSub.publish(updates, current));
    /** Tells the UI TMDB's progress alone, with no word from the worker about the lists. */
    const publishProgress = Effect.suspend(() =>
      PubSub.publish(progress, tmdbKey ? metadataProgress : null),
    );

    /** Fetches `source`'s lists, and tells the UI how it ended. */
    const fetchAndStore = (source: Source, playlist?: PlaylistRefresh) =>
      Effect.gen(function* () {
        // A refresh cut short by restarting the worker, as for a new key, isn't a failure to show.
        const started = generation;
        const { revision, account } = source;
        const owner = { ...ownerOf(source), revision };
        /**
         * Whether the login the lists were asked under is still the saved one. What the provider
         * answered under one that isn't, lists or a refusal, is neither kept nor told.
         */
        const stands = subscriptions.stands(source);
        // The worker fetches the lists and sets them aside; it keeps them only once told to.
        const fetched = Effect.gen(function* () {
          const catalogue = playlist
            ? (yield* playlist.read).catalogue
            : source.kind === "m3u"
              ? yield* Effect.tryPromise({
                  try: (signal) => source.provider.onDemandCatalogue(signal),
                  catch: failedWith,
                })
              : undefined;
          yield* call("refresh", { ...owner, account, ...(catalogue ? { catalogue } : {}) });
          const keep = yield* stands;
          yield* call("finishRefresh", { ...owner, keep });
          if (!keep) return yield* switched;
        });
        yield* fetched.pipe(
          fetchOne,
          diagnosed("titles"),
          Effect.tap(() =>
            Effect.gen(function* () {
              failures.delete(source.id);
              listsVersions.set(source.id, listsOf(source.id) + 1);
              yield* publishStatus;
            }),
          ),
          Effect.tapError((failed) =>
            Effect.gen(function* () {
              if (started !== generation || !(yield* stands)) return;
              failures.set(source.id, { error: failed.error, at: Date.now() });
              yield* publishStatus;
            }),
          ),
        );
      });

    /** Queries join the active refresh; a distinct supplied snapshot waits for its own acceptance. */
    const refreshOf = (source: Source, playlist?: PlaylistRefresh): Effect.Effect<void, Failed> =>
      Effect.gen(function* () {
        const under = refreshing.get(source.id);
        if (playlist && under && sameSource(source, under.source)) {
          yield* Fiber.await(under.fiber);
          if (!(yield* subscriptions.stands(source))) return yield* switched;
          return yield* refreshOf(source, playlist);
        }
        let running = under && sameSource(source, under.source) ? under : null;
        if (!running) {
          const token = {};
          const fiber = yield* Effect.forkIn(
            fetchAndStore(source, playlist).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (refreshing.get(source.id)?.token === token) refreshing.delete(source.id);
                }),
              ),
            ),
            scope,
          );
          running = { source, token, fiber };
          refreshing.set(source.id, running);
        }
        return yield* Fiber.join(running.fiber);
      });

    /**
     * The subscriptions whose lists make the catalogue, once there is something of it to show. A
     * subscription without lists yet fetches its own beside what shows, and the lists say when
     * it is in. With nothing to show at all, this waits for the first fetches and fails as they
     * did when none came; one that failed a moment ago fails with that rather than asking again.
     */
    const owners = Effect.gen(function* () {
      if ((yield* subscriptions.saved).length === 0) return yield* noSubscription;
      const found = yield* held;
      const all = found.map(({ subscription }) => ownerOf(subscription));
      const sources = new Map((yield* subscriptions.sources).map((each) => [each.id, each]));
      const missing = found.flatMap(({ subscription, worked }) =>
        worked.fetchedAt === null ? [subscription] : [],
      );
      // Refresh asks the provider again whenever the viewer does.
      const due = missing.flatMap((subscription) => {
        const failed = failures.get(subscription.id);
        const source = sources.get(subscription.id);
        return source && !(failed && Date.now() - failed.at < RETRY_AFTER_MS) ? [source] : [];
      });
      if (missing.length < found.length) {
        for (const source of due) {
          // One that failed waits for its own refresh, or the next start.
          if (!failures.has(source.id))
            yield* Effect.forkIn(Effect.ignore(refreshOf(source)), scope);
        }
        return all;
      }
      const failed = yield* Effect.forEach(
        due,
        (source) =>
          Effect.match(refreshOf(source), { onFailure: (cause) => cause, onSuccess: () => null }),
        { concurrency: "unbounded" },
      );
      if (failed.length === 0 ? missing.length === 0 : failed.includes(null)) return all;
      const [first] = missing;
      return yield* failed.find((each) => each !== null) ??
        new Failed({
          error: (first && failures.get(first.id)?.error) ?? {
            kind: "needs-secret",
            subscriptionId: first?.id ?? "",
          },
        });
    });

    /** Runs a call on the catalogue in the viewer's language, once it has something to show. */
    const loaded = <A>(
      run: (owners: readonly CatalogueOwner[], language: string) => Effect.Effect<A, Failed>,
    ) =>
      Effect.gen(function* () {
        const made = yield* owners;
        return yield* run(made, yield* language);
      });

    /** Details and lazy TMDB facts share the exact source revision and viewer language. */
    const aboutKey = (
      source: Pick<SavedSubscription, "id" | "revision">,
      viewer: string,
      kind: TitleKind,
      id: string,
    ) => `${source.id}|${source.revision}|${viewer}|${kind}|${id}`;

    /**
     * A version's details: downloaded when it first opens, then kept, and put together each time
     * with the title as the lists show it now, so its name and original language follow TMDB's
     * metadata as it arrives without downloading anything again. TMDB is asked at the same time,
     * and what it said by the time the provider answered is in them.
     */
    const detailsOf = (kind: TitleKind, { subscriptionId, id }: OwnedId) =>
      Effect.gen(function* () {
        const source = yield* subscriptions.sourceOf(subscriptionId);
        const viewer = yield* language;
        const cacheKey = aboutKey(source, viewer, kind, id);
        const [listed] = yield* loaded((owners, language) =>
          call("byIds", { owners, language, kind, versions: [{ subscriptionId, id }] }),
        );
        const kept = details.get(cacheKey);
        const title = listed ?? (source.kind === "m3u" ? undefined : kept?.title);
        if (!title) return yield* new Failed({ error: { kind: "title-not-found", titleId: id } });
        yield* askAbout(source, cacheKey, { subscriptionId, kind, id }, title);
        const downloaded = kept
          ? yield* renewed(source, kind, id, { ...kept, title })
          : yield* download(source, kind, id, title);
        details.delete(cacheKey);
        // Kept again only for the subscription it was asked for, with the login it had.
        if (!(yield* subscriptions.stands(source))) return yield* switched;
        keep(details, cacheKey, downloaded, DETAILS_KEPT);
        if (asking.has(cacheKey)) late.add(cacheKey);
        const about = abouts.get(cacheKey) ?? null;
        const { raw } = downloaded;
        // The title as this version: its episodes and its file belong to `id`, in its subscription.
        const version = {
          ...title,
          subscriptionId,
          id,
          tags:
            title.versions.find((each) => each.subscriptionId === subscriptionId && each.id === id)
              ?.tags ?? title.tags,
        };
        return {
          raw,
          /** What TMDB said about the title, once the question on its way is answered. */
          about: Effect.gen(function* () {
            const asked = asking.get(cacheKey);
            if (asked) yield* Fiber.join(asked);
            return abouts.get(cacheKey) ?? null;
          }),
          shown:
            kind === "movie"
              ? movieDetails(version, raw, about)
              : seriesDetails(version, raw, about, viewer),
        };
      });

    /** The provider's details of a movie or series. */
    const providerDetails = (source: Source, kind: TitleKind, id: string) =>
      Effect.tryPromise({
        try: (signal) =>
          kind === "movie"
            ? source.provider.movieDetails(id, signal)
            : source.provider.seriesDetails(id, signal),
        catch: failedWith,
      }).pipe(diagnosed("details"));

    /**
     * Asks TMDB about a title in the background, for its overview, artwork and credits, unless it
     * answered already or is being asked. Its answer is kept for the subscription it was asked
     * for, and announced when the title's details were given without it.
     */
    const askAbout = (source: Source, cacheKey: string, ref: TitleKey, title: Title) =>
      Effect.gen(function* () {
        if (abouts.has(cacheKey) || asking.has(cacheKey)) return;
        if (!title.tmdbId) return keep(abouts, cacheKey, null, DETAILS_KEPT);
        if (!tmdbKey) return;
        const { tmdbId } = title;
        const client = tmdb({ key: tmdbKey, ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}) });
        const viewer = yield* language;
        const answered = (about: TitleAbout | null | undefined) =>
          Effect.gen(function* () {
            asking.delete(cacheKey);
            const given = late.delete(cacheKey);
            if (about === undefined || !(yield* subscriptions.stands(source))) return;
            keep(abouts, cacheKey, about, DETAILS_KEPT);
            if (given && about) yield* PubSub.publish(detailed, ref);
          });
        // Listed once forked: its answer takes a round trip to TMDB, so it never comes first.
        const asked = yield* Effect.forkIn(
          Effect.tryPromise((signal) =>
            client
              .about(
                ref.kind === "movie" ? "movie" : "tv",
                tmdbId,
                viewer,
                AbortSignal.any([signal, AbortSignal.timeout(ABOUT_TIMEOUT_MS)]),
              )
              .catch((cause: unknown) => {
                if (cause instanceof TmdbError && cause.failure.kind === "missing") return null;
                throw cause;
              }),
          ).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap(answered),
          ),
          scope,
        );
        asking.set(cacheKey, asked);
      });

    /** Asks the provider about a title the lists show. */
    const download = (source: Source, kind: TitleKind, id: string, title: Title) => {
      const lists = listsOf(source.id);
      return Effect.map(providerDetails(source, kind, id), (raw) => ({
        raw,
        lists,
        title,
        version: { subscriptionId: source.id, id },
        sourceRevision: source.revision,
      }));
    };

    /** No provider reads: cached episode listings must still belong to the saved source and lists. */
    const knownFiles = (kind: TitleKind, onlyRead = false) =>
      Effect.gen(function* () {
        if (!verifiedFiles) return [];
        const files: KnownFile[] = [];
        for (const source of yield* listed) {
          const known = yield* verifiedFiles
            .read(source.key, source.fileRevision)
            .pipe(Effect.orElseSucceed(() => []));
          if (kind === "movie") {
            for (const file of known)
              if (file.kind === "movie")
                files.push({
                  subscriptionId: source.id,
                  kind: "movie",
                  id: file.id,
                  listingKey: file.listingKey,
                  tracks: { audio: file.audio, subtitles: file.subtitles },
                });
            continue;
          }
          const episodes = new Map(
            known.filter((file) => file.kind === "episode").map((file) => [file.id, file]),
          );
          if (onlyRead && episodes.size === 0) continue;
          const seen = new Set<string>();
          for (const held of details.values()) {
            if (
              held.title.kind !== "series" ||
              held.version.subscriptionId !== source.id ||
              held.sourceRevision !== source.revision ||
              held.lists !== listsOf(source.id)
            )
              continue;
            const tags = onlyRead
              ? []
              : (held.title.versions.find(
                  (version) =>
                    version.subscriptionId === source.id && version.id === held.version.id,
                )?.tags ?? []);
            for (const episode of held.raw.episodes) {
              const found = episodes.get(episode.id);
              if (onlyRead && found?.seriesId !== held.version.id) continue;
              if (seen.has(episode.id)) continue;
              seen.add(episode.id);
              const listingKey = listedFileKey("episode", episode);
              const tracks =
                found?.seriesId === held.version.id && found.listingKey === listingKey
                  ? { audio: found.audio, subtitles: found.subtitles }
                  : undefined;
              if (onlyRead && !tracks) continue;
              const named = onlyRead ? [] : titleName(episode.name).tags;
              // Read-only facts need no listing hints. Explicit episode quality otherwise wins.
              const hints = onlyRead
                ? []
                : qualityHint(named) === "unknown"
                  ? [...tags, ...named]
                  : [...tags.filter((tag) => qualityHint([tag]) === "unknown"), ...named];
              files.push({
                subscriptionId: source.id,
                kind: "episode",
                id: episode.id,
                seriesId: held.version.id,
                listingKey,
                tags: hints,
                ...(tracks ? { tracks } : {}),
              });
            }
          }
        }
        return files;
      });

    /** One read of validated observations decorates each season without joining rows by id. */
    const episodeObserver = Effect.map(knownFiles("series", true), (known) => {
      const files = new Map(known.map((file) => [ownedKey(file), file.tracks]));
      return <E extends Episode>(episode: E) => ({
        ...episode,
        ...(episode.versions
          ? {
              versions: episode.versions.map((version) => {
                const tracks = files.get(
                  ownedKey({ subscriptionId: episode.subscriptionId, id: version.id }),
                );
                return tracks ? { ...version, observed: { files: 1, ...tracks } } : version;
              }),
            }
          : {}),
      });
    });

    /** Decorates exact alternate files only from already validated local episode observations. */
    const observedEpisodes = <E extends Episode>(episodes: readonly E[]) =>
      episodes.some((episode) => episode.versions)
        ? Effect.map(episodeObserver, (observe) => episodes.map(observe))
        : Effect.succeed(episodes);

    /**
     * Details kept from an earlier open, asked again after the lists were refreshed, as the
     * provider may list new episodes; if that fails, the old ones stand.
     */
    const renewed = (source: Source, kind: TitleKind, id: string, kept: Downloaded) => {
      const lists = listsOf(source.id);
      return kept.lists === lists
        ? Effect.succeed(kept)
        : providerDetails(source, kind, id).pipe(
            Effect.map((raw) => ({ ...kept, raw, lists })),
            Effect.orElseSucceed(() => kept),
          );
    };

    /**
     * TMDB's season in one language: kept once TMDB answered, so opening it again asks no one.
     * Null when TMDB doesn't have it, or didn't answer in time; that isn't kept, so opening the
     * season again asks again.
     */
    const seasonIn = (client: Tmdb, tmdbId: string, season: number, asked: string) =>
      Effect.gen(function* () {
        const cacheKey = `${tmdbId}|${season}|${asked}`;
        // A season TMDB doesn't have is kept as null.
        const kept = seasons.get(cacheKey);
        const answer =
          kept !== undefined
            ? kept
            : yield* Effect.tryPromise((signal) =>
                client
                  .season(
                    tmdbId,
                    season,
                    asked,
                    AbortSignal.any([signal, AbortSignal.timeout(ABOUT_TIMEOUT_MS)]),
                  )
                  .catch((cause: unknown) => {
                    if (cause instanceof TmdbError && cause.failure.kind === "missing") return null;
                    throw cause;
                  }),
              ).pipe(Effect.orElseSucceed(() => undefined));
        if (answer === undefined) return null;
        keep(seasons, cacheKey, answer, SEASONS_KEPT);
        return answer;
      });

    return {
      status,

      refresh: (subscriptionId: string, playlist?: PlaylistRefresh) =>
        Effect.gen(function* () {
          const source = playlist?.source ?? (yield* subscriptions.sourceOf(subscriptionId));
          // Unmapped playlists retain Live-only behavior.
          if (hasTitles(source)) yield* refreshOf(source, playlist);
          return yield* status;
        }),

      isStale: (subscriptionId: string, maxAge: Duration.Input) =>
        Effect.gen(function* () {
          const found = yield* held.pipe(Effect.orElseSucceed(() => []));
          const worked = found.find(({ subscription }) => subscription.id === subscriptionId);
          if (!worked) return false;
          const { fetchedAt } = worked.worked;
          const now = yield* Clock.currentTimeMillis;
          return (
            fetchedAt === null ||
            worked.worked.importRevision !== worked.subscription.importRevision ||
            now - fetchedAt > Duration.toMillis(maxAge)
          );
        }),

      rows: (kind: TitleKind, tab: RowTab, like?: OwnedId) =>
        loaded((owners, language) =>
          call("rows", { owners, language, kind, tab, ...(like ? { like } : {}) }),
        ),
      recommendations: (seeds: readonly HomeSeed[]) =>
        Effect.gen(function* () {
          const saved = yield* listed;
          return yield* call("recommendations", {
            owners: saved.map(ownerOf),
            language: yield* language,
            seeds: seeds.slice(0, 32),
          });
        }),
      related: (kind: TitleKind, version: OwnedId) =>
        Effect.gen(function* () {
          const saved = yield* listed;
          const source = saved.find((each) => each.id === version.subscriptionId);
          if (!source) return { basis: null, titles: [] };
          const viewer = yield* language;
          const about = abouts.get(aboutKey(source, viewer, kind, version.id));
          return yield* call("related", {
            owners: saved.map(ownerOf),
            language: viewer,
            kind,
            version,
            ...(about
              ? {
                  metadata: {
                    genres: [...new Set(about.genres.flatMap((id) => GENRES[id] ?? []))],
                    language: about.language,
                  },
                }
              : {}),
          });
        }),
      tiles: (kind: TitleKind, of: "genres" | "services") =>
        loaded((owners, language) => call("tiles", { owners, language, kind, of })),
      collection: ({ kind, id, sort, offset, limit, filters }: CollectionQuery) =>
        loaded((owners, language) =>
          Effect.gen(function* () {
            // Titles for adults only once the viewer asked for them.
            if (id === "adult" && !(yield* settings.get).adultTitles) {
              return { name: "For adults", total: 0, titles: [] };
            }
            return yield* call("collection", {
              owners,
              language,
              kind,
              id,
              offset,
              limit,
              ...(sort ? { sort } : {}),
              ...(filters ? { filters, files: yield* knownFiles(kind) } : {}),
            });
          }),
        ),
      search: (query: string) =>
        loaded((owners, language) => call("search", { owners, language, query })),
      searchKind: (kind: TitleKind, query: string, filters?: TitleFilters) =>
        loaded((owners, language) =>
          Effect.gen(function* () {
            return yield* call("searchKind", {
              owners,
              language,
              kind,
              query,
              limit: SEARCH_PAGE,
              ...(filters ? { filters, files: yield* knownFiles(kind) } : {}),
            });
          }),
        ),
      filterOptions: (kind: TitleKind) =>
        Effect.gen(function* () {
          const saved = yield* listed;
          return yield* call("filterOptions", {
            owners: saved.map(ownerOf),
            language: yield* language,
            kind,
            files: yield* knownFiles(kind),
            adults: (yield* settings.get).adultTitles ?? false,
          });
        }),

      details: (kind: TitleKind, version: OwnedId) =>
        Effect.gen(function* () {
          const { shown } = yield* detailsOf(kind, version);
          if (
            shown.kind !== "series" ||
            !shown.seasons.some((season) => season.episodes.some((episode) => episode.versions))
          )
            return shown;
          const observe = yield* episodeObserver;
          return {
            ...shown,
            seasons: shown.seasons.map((season) => ({
              ...season,
              episodes: season.episodes.map(observe),
            })),
          };
        }),

      season: (series: OwnedId, number: number) =>
        Effect.gen(function* () {
          const { shown, about } = yield* detailsOf("series", series);
          const season =
            shown.kind === "series"
              ? shown.seasons.find((each) => each.number === number)
              : undefined;
          if (!season) {
            return yield* new Failed({ error: { kind: "title-not-found", titleId: series.id } });
          }
          const { tmdbId, originalLanguage } = shown.title;
          const answers: (readonly EpisodeAbout[])[] = [];
          if (tmdbKey && tmdbId) {
            const client = tmdb({ key: tmdbKey, ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}) });
            // Names fall back as titles' do: the viewer's language, English, the series' own,
            // which TMDB says as the details open if the lists don't know it yet. Each is asked
            // for only while an episode TMDB lists still has no name.
            const madeIn = originalLanguage
              ? Effect.succeed(originalLanguage)
              : Effect.map(about, (said) => said?.language ?? null);
            const asked = new Set<string>();
            for (const next of [language, Effect.succeed("en"), madeIn]) {
              const wanted = yield* next;
              if (!wanted || asked.has(wanted)) continue;
              asked.add(wanted);
              const answer = yield* seasonIn(client, tmdbId, number, wanted);
              if (!answer) break;
              answers.push(answer);
              if (named(season, answers)) break;
            }
          }
          return yield* observedEpisodes(seasonEpisodes(season, answers));
        }),

      titles: (kind: TitleKind, versions: readonly OwnedId[]) =>
        versions.length === 0
          ? Effect.succeed([])
          : // Versions of a subscription that isn't saved are in no lists, whatever their ids.
            loaded((owners, language) =>
              Effect.gen(function* () {
                return yield* call("byIds", {
                  owners,
                  language,
                  kind,
                  versions,
                  files: yield* knownFiles(kind, true),
                });
              }),
            ),

      saved: (saved: readonly SavedSubscription[], query: SavedQuery) =>
        Effect.gen(function* () {
          return yield* call("saved", {
            ...query,
            owners: saved.map(ownerOf),
            language: yield* language,
            adults: query.home ? false : ((yield* settings.get).adultTitles ?? false),
          });
        }),

      savedFacts: (
        saved: readonly SavedSubscription[],
        of: SavedSubscription,
        entries: readonly SavedTitle[],
      ) =>
        Effect.gen(function* () {
          return yield* call("savedFacts", {
            owners: saved.map(ownerOf),
            language: yield* language,
            subscriptionId: of.id,
            entries,
          });
        }),

      subtitleQuery: (ref: TitleRef, listingKey: string) =>
        Effect.gen(function* () {
          const source = yield* subscriptions.sourceOf(ref.subscriptionId);
          const kind = ref.kind === "movie" ? "movie" : "series";
          const version = {
            subscriptionId: ref.subscriptionId,
            id: ref.kind === "movie" ? ref.id : ref.seriesId,
          };
          const [title] = yield* loaded((owners, language) =>
            call("byIds", { owners, language, kind, versions: [version] }),
          );
          if (!title) return null;
          if (ref.kind === "movie") {
            const current = yield* call("container", { ...ownerOf(source), id: ref.id });
            return current?.listingKey === listingKey
              ? { tmdbId: title.tmdbId, title: title.title, year: title.year }
              : null;
          }
          const cached = [...details].filter(
            ([, entry]) =>
              entry.title.kind === "series" &&
              entry.version.subscriptionId === source.id &&
              entry.version.id === ref.seriesId &&
              entry.sourceRevision === source.revision,
          );
          const found = cached.find(([, entry]) => entry.lists === listsOf(source.id)) ?? cached[0];
          const cacheKey = found?.[0] ?? aboutKey(source, yield* language, "series", ref.seriesId);
          const kept = found?.[1];
          // The lists were refreshed since these details were read, or other titles' details took
          // their place: the provider says whether it still lists this file. Without its answer no
          // listing is taken for current.
          const held = kept
            ? yield* renewed(source, "series", ref.seriesId, kept)
            : yield* download(source, "series", ref.seriesId, title).pipe(
                Effect.orElseSucceed(() => null),
              );
          if (!held || held.lists !== listsOf(source.id)) return null;
          if (held !== kept) {
            if (!(yield* subscriptions.stands(source))) return null;
            keep(details, cacheKey, held, DETAILS_KEPT);
          }
          const episode = held.raw.episodes.find((entry) => entry.id === ref.id);
          if (!episode || listedFileKey("episode", episode) !== listingKey) return null;
          return {
            tmdbId: title.tmdbId,
            title: title.title,
            year: title.year,
            season: episode.season,
            episode: episode.number,
          };
        }),

      file: (title: TitleRef) =>
        Effect.gen(function* () {
          const source = yield* subscriptions.sourceOf(title.subscriptionId);
          const missing = new Failed({ error: { kind: "title-not-found", titleId: title.id } });
          if (title.kind === "movie") {
            const listed = yield* call("container", { ...ownerOf(source), id: title.id });
            if (!listed) return yield* missing;
            const file = yield* Effect.tryPromise({
              try: (signal) =>
                source.provider.titleFile("movie", title.id, listed.container, signal),
              catch: failedWith,
            });
            if (!(yield* subscriptions.stands(source))) return yield* switched;
            return { ...file, revision: source.revision, listingKey: listed.listingKey };
          }
          const series = yield* detailsOf("series", {
            subscriptionId: title.subscriptionId,
            id: title.seriesId,
          });
          const episode = series.raw.episodes.find((each) => each.id === title.id);
          if (!episode) return yield* missing;
          const file = yield* Effect.tryPromise({
            try: (signal) =>
              source.provider.titleFile("episode", title.id, episode.container, signal),
            catch: failedWith,
          });
          if (!(yield* subscriptions.stands(source))) return yield* switched;
          return {
            ...file,
            revision: source.revision,
            listingKey: listedFileKey("episode", episode),
          };
        }),

      forget: (subscription: SavedSubscription) =>
        Effect.gen(function* () {
          const { id } = subscription;
          failures.delete(id);
          listsVersions.delete(id);
          // What was kept of its titles goes; what TMDB said of a season is no subscription's.
          for (const kept of [details, abouts, asking]) {
            for (const key of kept.keys()) if (key.startsWith(`${id}|`)) kept.delete(key);
          }
          for (const key of late) if (key.startsWith(`${id}|`)) late.delete(key);
          // Mapped playlists keep title lists too.

          yield* call("forget", ownerOf(subscription)).pipe(Effect.ignore);
          yield* publishStatus;
        }),

      reconfigure: Effect.gen(function* () {
        const next = keyOf(yield* settings.get);
        if (next === tmdbKey) return;
        tmdbKey = next;
        generation++;
        failures.clear();
        metadataProgress = { known: 0, wanted: 0, refused: false, fetching: false };
        // The next call starts the worker again, with the new key.
        yield* Effect.promise(() => worker.stop());
        yield* publishStatus;
      }),

      changes: Stream.fromPubSub(updates),

      progressChanges: Stream.fromPubSub(progress),

      detailsChanged: Stream.fromPubSub(detailed),
    };
  });
}

// Made when it fails, so it says so in the interface language of the moment.
const switched = Effect.failSync(
  () =>
    new Failed({
      error: { kind: "unexpected", detail: t("The subscription changed while loading titles.") },
    }),
);

/** Keeps `value` as the most recently used, dropping the least recently used beyond `limit`. */
function keep<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value ?? "");
}

/** Whether every episode of `season` that TMDB lists has a name in one of its answers. */
function named(season: Season, answers: readonly (readonly EpisodeAbout[])[]): boolean {
  const [first = []] = answers;
  return season.episodes.every(
    (episode) =>
      !first.some((each) => each.number === episode.number) ||
      answers.some((answer) =>
        answer.some((each) => each.number === episode.number && each.name !== null),
      ),
  );
}

/**
 * Calls into the catalogue worker. The worker starts on the first call, and again after it
 * stops unexpectedly; calls in flight when it stops fail.
 */
function workerClient(start: () => Worker, onEvent: (event: WorkerEvent) => void) {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void; worker: Worker }
  >();

  /** Fails the calls `from` was given, and only those: another may have started meanwhile. */
  const failAll = (from: Worker, cause: unknown) => {
    for (const [id, entry] of pending) {
      if (entry.worker !== from) continue;
      pending.delete(id);
      entry.reject(cause);
    }
  };

  const running = (): Worker => {
    if (worker) return worker;
    const started = start();
    started.on("message", (reply: WorkerReply | WorkerEvent) => {
      if ("event" in reply) return onEvent(reply);
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.value);
      else entry.reject(new Failed({ error: reply.error }));
    });
    started.on("error", (cause) => failAll(started, cause));
    started.on("exit", () => {
      if (worker === started) worker = null;
      failAll(started, new Error("The catalogue worker stopped."));
    });
    worker = started;
    return started;
  };

  const call = <M extends WorkerMethod>(
    method: M,
    args: WorkerCalls[M]["args"],
  ): Promise<WorkerCalls[M]["result"]> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const to = running();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, worker: to });
      // The worker writes names, such as "New this week", in the language of the call.
      to.postMessage({ id, method, args, interfaceLanguage: currentLanguage() });
    });
  };

  return {
    call,
    async stop(): Promise<void> {
      const current = worker;
      if (!current) return;
      // The worker writes what it still holds, each subscription's lists and TMDB's metadata, so
      // the next start reads them. It gets a moment for that and no longer: a quit never waits
      // on a worker that doesn't answer, and what isn't written by then stays as the disk had it.
      const flushed = call("flush", {}).catch(() => null);
      await Promise.race([flushed, new Promise((done) => setTimeout(done, STOP_WITHIN_MS))]);
      if (worker === current) worker = null;
      await current.terminate();
    },
  };
}
