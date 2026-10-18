// The programme guide service. It keeps each saved subscription's own guide, and the global XMLTV
// sources the viewer adds in Settings > Guides, as indexes on disk (index-file.ts), opens them
// after a restart, downloads them again when they are six hours old, and forgets a subscription's
// when it goes. Browsing and playback never wait for a download: lookups answer from the guides
// there are, and empty until there is one.
//
// A subscription's channels read its guides in order: its own, its provider's or the one its
// playlist names, then each source in the viewer's order (programmes.ts). The first guide with
// programmes for a channel now supplies that whole channel, for every read, past and future
// alike, unless the viewer mapped it by hand to a guide channel of one of them. A source applies to every subscription, and is downloaded and
// indexed once for all of them.
//
// A download runs in the background in two steps, both told in the status as they go: the
// document is saved as it arrives, then indexed in a worker thread into a file of its own. The
// guide in use keeps answering throughout. The new one replaces it only once it is whole, in one
// write of what the store keeps. Each index keeps ended programmes for the archive window
// (`archive`), and the next download of the same source brings along the past that its document
// no longer lists. Searches read the indexes in a worker of their own (`GuideSearcher`), stopped
// with their subscription; what the main process reads itself, a schedule or a grid's stretch,
// it reads no further than asked, and a list's channels in slices (`slicer`).
//
// Two rules keep the files whole. Every file of a guide has holders (files.ts): the guide loaded
// from it, a read under way, a build reading the past from it, a use that opened one, the
// download or build writing it, and what is kept naming it. A file goes only once nothing holds
// it, a stopped build lets go of what it held only once its worker has ended, and a download
// lets go of what it wrote however it ends, once it handed that on. And whatever decides which
// guide is current, what is set for it and which files are kept, runs in a turn (`turn`): a
// subscription's own, or the one turn of the sources' list, one at a time, to its end once begun,
// checking there whether it still applies. The sweep of what a run before left runs in those
// turns too. A subscription's turn may wait for the sources' turn, never the other way.
//
// Channels are asked for with the subscription they belong to, and answers name them the same
// way (`ownedKey`): a guide id means something only within the subscription whose catalogue
// names it. So two subscriptions that use the same guide id never share an answer, also when a
// source supplies both. A search goes through every guide and is cut only once they are all in.
//
// A source is added at once: its address is sealed, as it can hold a key, and only its origin is
// ever told; its download follows in the background. The viewer can name it, at once or later,
// which the window shows in place of its host; a name is the viewer's own text, kept unsealed.
// One that fails keeps its last download that worked and its place in the order, and its status
// says why and since when. Removing one drops what it downloaded; a mapping made to it then leads
// nowhere and its channel goes back to automatic.
//
// A subscription can answer that it has no guide, as a playlist does whose first line names none.
// That is an answer like any other: a guide loaded before is dropped, the status says so, and the
// service doesn't ask again on its own until the app starts again. Only a refresh the viewer asks
// for does. Until a subscription has answered, whether it has a guide of its own is unknown.
//
// Releases before 0.0.13 kept the XMLTV documents themselves, and a subscription could take an
// XMLTV address of the viewer's own in place of its own guide. The first time a subscription's
// guide is read, such an address moves to the sources: its download is copied there and named,
// the same address of several subscriptions becoming one source that reads the newest of their
// downloads (`movedFrom`), and the address and the mappings made against it name that source. A
// move only adds: each subscription keeps the address and its file, unread, until the source's
// first download of its own, which lets go of them; a mapping to a guide channel only an older
// download listed waits for that download. Such a source downloads at the next refresh, the one
// the app asks for after its start too, whatever the age of what it has, once what it brought is
// indexed. An address that couldn't move this run is read where it is, and moves at the next
// start.
//
// A record of the guides that is there but can't be read, or a file that can't be looked at,
// keeps everything for the rest of the run: nothing is swept or let go of. The sweep of what a
// run before left runs once each run, after every record was read.
//
// The app supplies the ports: the subscriptions and their downloads, each catalogue's channels,
// a store for the documents and for what is set, the workers that index and search, and the
// addresses' keychain and network. Downloads run in the service's scope, so `forget`, removing a
// source and shutdown stop them. One a subscription asked for before `forget` doesn't start, and
// one begun under a login that changed since stops, so a removal waits for no download, however
// long its server or its indexing takes. Whatever work finishes late changes nothing: not after
// its subscription went, not under a login that changed since, and not once its source was
// removed. Each write is checked for that in its turn, so one that waited can't bring back what
// was removed meanwhile. A mapping reads the channels and the guides in that turn too, so it is
// made for none that either stopped listing while it waited. One guide failing leaves every other
// as it is.
import { randomUUID } from "node:crypto";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import {
  GUIDE_LABEL_MAX,
  type GuideChannelPage,
  type GuideFailure,
  type GuideProcessing,
  type GuideSlot,
  type GuideSourceStatus,
  type GuideStatus,
  type Listing,
  type ListingMatch,
  type MapChannel,
  type MapChannelPage,
  type MapFilter,
  type Programme,
  type ProgrammeMatch,
} from "@mrstreamer/contracts/guide";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { diagnosed } from "../diagnostics.ts";
import { Failed, failedWith } from "../failure.ts";
import type { LiveGuide } from "../provider.ts";
import { guideAddress } from "./address.ts";
import { guideFiles, type Reader, type Release } from "./files.ts";
import {
  type GuideBuild,
  type GuideIndex,
  type GuideIndexSummary,
  type GuideSearching,
} from "./index-file.ts";
import { GUIDE_LIMITS } from "./limits.ts";
import {
  coverage,
  guideChannelsAt,
  guidesOf,
  listingsAt,
  mapChannel,
  mapChannelsAt,
  mappedChannels,
  OWN_GUIDE,
  parseGuideRef,
  programmeAt,
  rangeAt,
  scheduleAt,
  searchAt,
  searchChannelsAt,
  SEARCH_LIMIT,
  slicer,
  unresolvedMappings,
  type CatalogueChannels,
  type GuideMapping,
  type GuidePart,
  type Guides,
  type MappedChannels,
  type Slice,
} from "./programmes.ts";

/** A guide older than this is downloaded again. Providers cover about a day ahead. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How often the service checks whether the guides are due. */
const CHECK_EVERY = "15 minutes";
/** How many guides download and index at a time. */
const DOWNLOADS_AT_ONCE = 2;
/** How often the time is checked against the guides: a grid follows a handover within it. */
const CHECK_TIME_EVERY_MS = 60_000;
/** A move of the clock between two checks that counts as a jump: a sleep, or a time set. */
const CLOCK_JUMP_MS = 2 * CHECK_TIME_EVERY_MS;

/** How often, at most, progress alone is told: each step of it is told at once. */
const PROGRESS_EVERY_MS = 250;
/** The turn of the sources' list, among the subscriptions' by their ids. */
const SOURCES = "sources";

/**
 * How long a guide keeps programmes after they end, until providers say how far back each
 * subscription's catch-up reaches: what `GuideSubscription.archive` is for now, and what a
 * source keeps.
 */
export const GUIDE_ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000;

/** A subscription whose guide to keep: its identity and its own XMLTV download. */
export interface GuideSubscription {
  /** What its channels name it by. */
  readonly id: string;
  /** Rises when its login or link changes: what began before doesn't count after. */
  readonly revision: number;
  /** The account its guide, and what is set for it, are kept for. */
  readonly key: string;
  /** Where the store keeps them, as the store names it: the app gives a folder. */
  readonly store: string;
  /** How long, in milliseconds, its guide keeps programmes after they end. */
  readonly archive: number;
  /**
   * Asks the subscription for its own guide now: the document, or that it has none. Null while
   * its password or link can't be read: the guide it loaded before still shows, and none
   * downloads.
   */
  readonly download: ((signal: AbortSignal) => Promise<LiveGuide>) | null;
}

/** Which subscriptions are saved, in their order, and where the global sources are kept. */
export class GuideSource extends Context.Service<
  GuideSource,
  {
    readonly saved: Effect.Effect<readonly GuideSubscription[]>;
    /** Where the store keeps the sources and their files, as it names a subscription's place. */
    readonly sources: string;
  }
>()("mrstreamer/GuideSource") {}

/** A subscription's catalogue: its channels as the lists show them, with their guide ids. */
export class GuideCatalogue extends Context.Service<
  GuideCatalogue,
  {
    /**
     * The same object while the catalogue and what the lists show of it are the same, so what
     * is worked out from it can be kept.
     */
    readonly channels: (subscriptionId: string) => Effect.Effect<CatalogueChannels, Failed>;
  }
>()("mrstreamer/GuideCatalogue") {}

/** A guide's programmes as the store keeps them, in a file of the guide's folder. */
export interface GuideDocument {
  /** What the store names the file by. */
  readonly file: string;
  /** Epoch milliseconds it was downloaded at. */
  readonly fetchedAt: number;
  /**
   * `index`: an index this release wrote. `xmltv`: the document itself, as a release before
   * kept it, which is indexed the first time it is wanted.
   */
  readonly kind: "index" | "xmltv";
}

/** A document being saved as it downloads, in a file of its own, until it is indexed. */
export interface GuideDownload {
  /** What the store names it by. */
  readonly file: string;
  write(bytes: Uint8Array): Promise<void>;
  /** Ends the document. It stays until it is discarded. */
  close(): Promise<void>;
  discard(): Promise<void>;
}

/** Where a subscription's guide is kept: `GuideSubscription.store`, and whose it is. */
export type GuidePlace = Pick<GuideSubscription, "store" | "key">;

/** Why a guide's downloads fail, and since when, until one works. */
export interface GuideFailureNote {
  readonly at: number;
  readonly error: AppError;
}

/** A global XMLTV source as it is kept. */
export interface StoredSource {
  /** Names it in mappings and to the window. */
  readonly id: string;
  /** Its scheme, host and port: all of the address that isn't sealed. */
  readonly origin: string;
  /** Tells addresses apart without holding one (`GuideAddress.identity`). */
  readonly identity: string;
  readonly sealedAddress: string;
  /** The name the viewer gave it (`GuideSourceStatus.label`), or null. */
  readonly label: string | null;
  /** Its last download that worked, or null before one. */
  readonly document: GuideDocument | null;
  readonly failure: GuideFailureNote | null;
  /**
   * The download a release before kept that its document was copied from, until it has one of
   * its own: the addresses that moved to it stay with their subscriptions until then.
   */
  readonly movedFrom: MovedFrom | null;
}

/** A download a release before kept, as identical addresses' downloads are chosen among. */
export interface MovedFrom {
  readonly file: string;
  readonly fetchedAt: number;
  readonly bytes: number;
}

/**
 * An XMLTV address a release before gave a subscription in place of its own guide, as it was
 * kept: read to move it to the sources, and kept, with its file, until the source it moved to
 * has a download of its own.
 */
export interface LegacyExternal {
  readonly origin: string;
  readonly identity: string;
  readonly sealedAddress: string;
  readonly document: GuideDocument;
  readonly failure: GuideFailureNote | null;
  /** The source it moved to, or null before it did. */
  readonly source: string | null;
  /** Since when it was the guide, which 0.0.12 needs to read it. */
  readonly since: number | null;
}

/**
 * What the viewer set for a subscription's guide, as kept. A mapping's `source` is null where a
 * release before made it, against the guide in use then: the legacy address when there was one,
 * else the subscription's own guide.
 */
export interface StoredConfig {
  readonly external: LegacyExternal | null;
  readonly mappings: Readonly<
    Record<string, Omit<GuideMapping, "source"> & { readonly source: string | null }>
  >;
}

/** How a copy went: whole, without a file to copy, or not at all. */
export type Copied = "copied" | "missing" | "failed";

/**
 * Where each guide is kept, for the next start: a subscription's own guide and what is set for
 * it in its folder, and the sources in theirs, and the files they name. A file is named by one
 * write of a small record, so a switch is whole or not at all, and a file nothing names is swept
 * away.
 */
export class GuideStore extends Context.Service<
  GuideStore,
  {
    /** The own guide kept at `place` for its account, or null; fails where it can't tell. */
    readonly own: (place: GuidePlace) => Effect.Effect<GuideDocument | null, Failed>;
    /**
     * Makes `document` the own guide at `place`, or none with null, whole or not at all. It
     * never makes the subscription's folder, so one that went is not brought back.
     */
    readonly setOwn: (
      place: GuidePlace,
      document: GuideDocument | null,
    ) => Effect.Effect<void, Failed>;
    /**
     * What is set for the account at `place`, or null when nothing is; fails where what is set
     * can't be read.
     */
    readonly config: (place: GuidePlace) => Effect.Effect<StoredConfig | null, Failed>;
    /**
     * Keeps what is set, whole or not at all: an interrupted write leaves what was set before.
     * A legacy address goes once it is written without one. It never makes the subscription's
     * folder.
     */
    readonly setConfig: (place: GuidePlace, config: StoredConfig) => Effect.Effect<void, Failed>;
    /** The sources kept in `place`, in their order: none when nothing is; fails where they can't be read. */
    readonly sources: (
      place: Pick<GuidePlace, "store">,
    ) => Effect.Effect<readonly StoredSource[], Failed>;
    /** Keeps the sources in their order, whole or not at all, making their folder when it isn't. */
    readonly setSources: (
      place: Pick<GuidePlace, "store">,
      sources: readonly StoredSource[],
    ) => Effect.Effect<void, Failed>;
    /** The size of a file in bytes, or null where there is none; fails where it can't look. */
    readonly bytesOf: (
      place: Pick<GuidePlace, "store">,
      file: string,
    ) => Effect.Effect<number | null, Failed>;
    /**
     * Copies a file of one folder to another under the same name, whole or not at all, as a
     * legacy address's download goes to the sources; the file stays where it was too. Answers
     * whether it is there now, or that there was none to copy.
     */
    readonly copy: (
      from: Pick<GuidePlace, "store">,
      to: Pick<GuidePlace, "store">,
      file: string,
    ) => Effect.Effect<Copied>;
    /**
     * Makes `file`, named by `newDownload`, to save a document into as it downloads. Fails
     * where the folder went.
     */
    readonly download: (
      place: Pick<GuidePlace, "store">,
      file: string,
    ) => Effect.Effect<GuideDownload, Failed>;
    /** A name for a new download. */
    readonly newDownload: () => string;
    /** A name for a new index. */
    readonly newIndex: () => string;
    /** Where a file of the guide's is, to read it or write it. */
    readonly path: (place: Pick<GuidePlace, "store">, file: string) => string;
    /** Removes a file of the guide's. It doesn't fail: one it can't remove is swept later. */
    readonly discard: (place: Pick<GuidePlace, "store">, file: string) => Effect.Effect<void>;
    /**
     * Drops every index and download `known` doesn't know, each asked just before it goes:
     * what work cut short left behind.
     */
    readonly sweep: (
      place: Pick<GuidePlace, "store">,
      known: (file: string) => boolean,
    ) => Effect.Effect<void>;
    /** Drops everything kept of a subscription's guide: its files, and what was set for it. */
    readonly erase: (place: Pick<GuidePlace, "store">) => Effect.Effect<void>;
  }
>()("mrstreamer/GuideStore") {}

/** The keychain and the network, for the addresses viewers give. */
export class GuideAddresses extends Context.Service<
  GuideAddresses,
  {
    readonly seal: (address: string) => Effect.Effect<string, Failed>;
    /** The address, or null when the keychain no longer opens it. */
    readonly open: (sealed: string) => Effect.Effect<string | null>;
    /**
     * Requests the document at an address, as it downloads, with its size when the server
     * says. It carries nothing of a provider's login, and fails naming no more of the address
     * than its origin.
     */
    readonly fetch: (
      address: string,
      signal: AbortSignal,
    ) => Promise<{ readonly body: AsyncIterable<Uint8Array>; readonly size: number | null }>;
  }
>()("mrstreamer/GuideAddresses") {}

/**
 * Indexes documents (`buildGuideIndex`) away from the main process, telling `progress` how many
 * programmes it has read. `signal` stops it, leaving nothing behind.
 */
export class GuideIndexer extends Context.Service<
  GuideIndexer,
  {
    readonly build: (
      build: GuideBuild,
      progress: (programmes: number) => void,
      signal: AbortSignal,
    ) => Promise<GuideIndexSummary>;
  }
>()("mrstreamer/GuideIndexer") {}

/**
 * Searches index files away from the main process (`searchFirst`, `searchEach`), however many
 * programmes a search reads. The caller keeps the file until the search answers.
 */
export class GuideSearcher extends Context.Service<GuideSearcher, GuideSearching>()(
  "mrstreamer/GuideSearcher",
) {}

/** Whose files a guide's are, and how long its programmes are kept: a subscription, or the sources. */
interface Owner {
  /** Its folder, as the store names it. */
  readonly store: string;
  readonly archive: number;
}

interface Loaded {
  readonly fetchedAt: number;
  /** Its index's file, as the store names it, in its owner's folder. */
  readonly file: string;
  readonly index: GuideIndex;
  /** Lets go of the guide's claim on its index. */
  readonly release: Release;
}

/** What is set for a subscription's guide, as read this run. */
interface Settings {
  readonly key: string;
  /**
   * The channels mapped by hand, by channel id. One made against a legacy address that couldn't
   * move yet names `LEGACY` until it does.
   */
  readonly mappings: Readonly<Record<string, GuideMapping>>;
  /** The own guide kept, or null. */
  readonly own: GuideDocument | null;
  /**
   * An address a release before set, still kept with the subscription, its file with it, until
   * the source it moved to has a download of its own; `source` null while it couldn't move.
   */
  readonly legacy: LegacyExternal | null;
  /** False where what is set couldn't be read: it is read again, and nothing is written over it. */
  readonly readable: boolean;
}

/**
 * The guide of an address a release before set that couldn't move to the sources this run, read
 * where it is: what the mappings made against it name meanwhile.
 */
const LEGACY = "legacy";

/** Names the work of reading such an address's download where it is. */
const legacyKey = (id: string) => `legacy:${id}`;

/** Settings as the store keeps them. */
const storedConfig = ({ mappings, legacy }: Settings): StoredConfig => ({
  external: legacy,
  mappings: Object.fromEntries(
    Object.entries(mappings).map(([channelId, mapping]) => [
      channelId,
      { ...mapping, source: mapping.source === LEGACY ? null : mapping.source },
    ]),
  ),
});

/** A source as this run knows it. */
interface Source extends StoredSource {
  /** The address itself; null while the keychain won't open it. */
  readonly address: string | null;
}

/** A subscription's guides, its channels and the time: what a lookup reads. */
interface Found {
  readonly guides: Guides;
  readonly channels: MappedChannels;
  readonly at: number;
}

/** A step of work under way, as the status tells it. */
type Progress = Extract<GuideProcessing, { state: "downloading" | "reading" }>;

/** What a download and its index came to: the index's file. */
interface Indexed {
  readonly file: string;
  readonly fetchedAt: number;
  readonly summary: GuideIndexSummary;
}

/** Work under way on a guide: a download, or the indexing of a document an older release kept. */
interface Job {
  readonly kind: "download" | "reindex";
  /** What it was begun for: the subscription as it was saved then, or the source's address. */
  readonly version: string;
  readonly token: object;
  readonly fiber: Fiber.Fiber<void, Failed>;
}

/** Names a source's work, among the subscriptions' by their ids. */
const sourceKey = (id: string) => `source:${id}`;

export class Guide extends Context.Service<
  Guide,
  {
    /**
     * What each channel shows now and next, by its `ownedKey`. Channels without guide data are
     * left out.
     */
    listings(channels: readonly OwnedId[]): Effect.Effect<Record<string, Listing>>;
    /**
     * The channel's programmes over [from, until), as `GUIDE_SCHEDULE` bounds them: aired ones
     * for catch-up from `from`, then the one on now and those to come.
     */
    schedule(channel: OwnedId, from: number, until: number): Effect.Effect<readonly Programme[]>;
    /**
     * The programmes of each channel that overlap [from, to), by its `ownedKey`, past ones the
     * guide keeps among them: a page of a grid. Channels without guide data are left out.
     */
    range(
      channels: readonly OwnedId[],
      from: number,
      to: number,
    ): Effect.Effect<Record<string, readonly GuideSlot[]>>;
    /**
     * The programme of the guide channel `guide` names that starts at `start`, with its
     * description: what a slot of `range` leaves out, by the slot's `guide` and `start`. Null
     * when the channel doesn't name that guide channel, or the guide has none starting then.
     */
    programme(channel: OwnedId, guide: string, start: number): Effect.Effect<Programme | null>;
    /** Programmes on now or later whose title matches, in any guide, on now first. */
    search(query: string): Effect.Effect<readonly ProgrammeMatch[], Failed>;
    /**
     * What a search finds in the programmes of the given channels, by each channel's `ownedKey`:
     * on now, and the first later one that starts before `until`. Every channel given is searched.
     */
    searchChannels(
      query: string,
      channels: readonly OwnedId[],
      until: number,
    ): Effect.Effect<Record<string, ListingMatch>, Failed>;
    /**
     * For each saved subscription, in their order: how many channels its guides cover and from
     * which, what is under way with its own guide and how its latest download ended, or that it
     * has none.
     */
    readonly status: Effect.Effect<readonly GuideStatus[]>;
    /**
     * Downloads a subscription's own guide. Concurrent calls for one subscription share a
     * download; a failure keeps the guide. An own guide that answers it has none succeeds, and
     * a guide loaded before goes.
     */
    refresh(subscriptionId: string): Effect.Effect<void, Failed>;
    /**
     * Downloads a subscription's own guide when there is none or it is six hours old, and starts
     * the sources' that are. A subscription that answered it has none isn't asked again.
     */
    refreshIfStale(subscriptionId: string): Effect.Effect<void, Failed>;
    /**
     * Checks whether the guide that supplies a channel changed with time alone since the last
     * check, and tells the window if it did. The service checks each minute; the app checks too
     * when the computer wakes, as the clock may have moved meanwhile.
     */
    readonly checkTime: Effect.Effect<void>;
    /** The global sources, in their order. */
    readonly sources: Effect.Effect<readonly GuideSourceStatus[]>;
    /**
     * Adds the XMLTV guide at the address typed after the other sources, named `label`, at once,
     * and starts its download. The same address again leaves the source it is as it is, its name
     * too. A name is kept as `renameSource` keeps it, and one it refuses adds nothing.
     */
    addSource(typed: string, label?: string | null): Effect.Effect<GuideSourceStatus, Failed>;
    /** Removes a source and what it downloaded, stopping its download. */
    removeSource(id: string): Effect.Effect<void, Failed>;
    /** Moves a source `by` one place earlier (-1) or later (1); at either end, it stays. */
    moveSource(id: string, by: -1 | 1): Effect.Effect<void, Failed>;
    /** Downloads a source now, joining a download under way, and answers its status then. */
    refreshSource(id: string): Effect.Effect<GuideSourceStatus, Failed>;
    /**
     * Names a source, or takes its name away with null. The name is kept with runs of white
     * space as one space, cut to `GUIDE_LABEL_MAX` characters, and none when nothing is left.
     * One holding "://" is refused (`label`): a name is kept unsealed, and that is an address
     * pasted into the wrong field. Nothing else of what a viewer types is checked.
     */
    renameSource(id: string, label: string | null): Effect.Effect<GuideSourceStatus, Failed>;
    /**
     * Maps a channel to the guide channel `ref` names exactly, or back to automatic with null.
     * `revision` names the guides the choice was made from: another one refuses it, and so does
     * a channel the provider, or a guide channel its guide, no longer lists once the mapping is
     * written.
     */
    map(
      subscriptionId: string,
      channelId: string,
      ref: string | null,
      revision: string,
    ): Effect.Effect<MapChannel | null, Failed>;
    /** A page of a subscription's channels with how each gets its programmes. */
    mapChannels(query: {
      readonly subscriptionId: string;
      readonly filter: MapFilter;
      readonly query: string;
      readonly offset: number;
      readonly limit: number;
    }): Effect.Effect<MapChannelPage, Failed>;
    /** A page of the channels a subscription's guides list, its own and then the sources'. */
    mapOptions(query: {
      readonly subscriptionId: string;
      readonly query: string;
      readonly offset: number;
      readonly limit: number;
    }): Effect.Effect<GuideChannelPage, Failed>;
    /**
     * Forgets everything of a subscription's guide and stops its work, for when the subscription
     * goes.
     */
    forget(subscription: Pick<GuideSubscription, "id" | "store">): Effect.Effect<void>;
    /**
     * Emits whenever a guide is loaded or dropped, what is set for one changes, a download
     * fails, or work under way moves on: each step at once, its progress a few times a second.
     */
    readonly changes: Stream.Stream<void>;
  }
>()("mrstreamer/Guide") {
  static readonly layer = Layer.effect(Guide, make());
}

function make() {
  return Effect.gen(function* () {
    const source = yield* GuideSource;
    const catalogue = yield* GuideCatalogue;
    const store = yield* GuideStore;
    const addresses = yield* GuideAddresses;
    const indexer = yield* GuideIndexer;
    const searcher = yield* GuideSearcher;
    const scope = yield* Effect.scope;
    const updates = yield* PubSub.unbounded<void>();
    const downloadOne = (yield* Semaphore.make(DOWNLOADS_AT_ONCE)).withPermits(1);
    /** The sources' folder, and how long their programmes are kept. */
    const sourcesOwner: Owner = { store: source.sources, archive: GUIDE_ARCHIVE_MS };

    /** Every file of the guides the service knows, and who holds each: nothing else deletes one. */
    const files = guideFiles({
      path: (folder, file) => store.path({ store: folder }, file),
      remove: (folder, file) => Effect.runPromise(store.discard({ store: folder }, file)),
    });
    // Shutting down closes every index. What is kept stays on disk for the next start.
    yield* Effect.addFinalizer(() => Effect.sync(() => files.closeAll()));

    /** Each subscription's turn at what decides its guide, by its id, and the sources' turn. */
    const turns = new Map<string, Semaphore.Semaphore>();
    /**
     * Runs `change` in a turn, a subscription's by its id or the sources' (`SOURCES`): one at a
     * time per turn, and once begun, to its end, also when what asked for it is stopped. Whatever
     * changes which guide is current, what is set for it or which files are kept runs here, and
     * checks in the turn whether it still applies. A subscription's turn may wait for the
     * sources' turn; no turn waits for its own, or for work that does.
     */
    const turn = <A, E>(id: string, change: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        let one = turns.get(id);
        if (!one) turns.set(id, (one = Semaphore.makeUnsafe(1)));
        return one.withPermits(1)(Effect.uninterruptible(change));
      });

    /** Each subscription's own guide, by its id. */
    const loaded = new Map<string, Loaded>();
    /** The subscriptions that answered they have no guide, by id, until they answer otherwise. */
    const absent = new Set<string>();
    /** The subscriptions with no saved guide this run could read: none is read for them again. */
    const unread = new Set<string>();
    /** What is set for each subscription's guide, by its id, once read. */
    const settings = new Map<string, Settings>();
    /**
     * The subscriptions `forget` is dropping, by id: nothing of theirs is read or claimed again
     * until their folder is empty, whatever still asks after them meanwhile.
     */
    const forgotten = new Set<string>();
    /** The files what is kept for each subscription names, by id, each with its claim. */
    const kept = new Map<string, Map<string, Release>>();
    /** Why a subscription's own downloads fail, and since when, until one works. */
    const failures = new Map<string, GuideFailureNote>();
    /** What each work under way is doing, while it runs, by the job's key. */
    const progress = new Map<string, Progress>();
    /** A subscription's channels with its mappings over them, while both are the same. */
    const overlays = new Map<
      string,
      {
        readonly base: CatalogueChannels;
        readonly mappings: Settings["mappings"];
        readonly channels: MappedChannels;
      }
    >();
    /**
     * Rises, per subscription, whenever `forget` drops its guide. Work that started before
     * doesn't apply its result, and a download asked for before doesn't start.
     */
    const generations = new Map<string, number>();
    const generationOf = (id: string) => generations.get(id) ?? 0;
    /**
     * The work under way on each guide, a subscription's by its id or a source's by
     * `sourceKey`: one at a time; a refresh joins a download under way.
     */
    const jobs = new Map<string, Job>();
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });
    const failed = (failure: GuideFailure) => new Failed({ error: { kind: "guide", failure } });
    /** A source's name as `renameSource` keeps it, or `label` refused. */
    const labelOf = (typed: string | null | undefined) =>
      Effect.suspend(() => {
        const whole = (typed ?? "").replace(/\s+/g, " ").trim();
        if (whole.includes("://")) return Effect.fail(failed({ kind: "label" }));
        const label = Array.from(whole).slice(0, GUIDE_LABEL_MAX).join("").trim();
        return Effect.succeed(label === "" ? null : label);
      });
    const changed = failed({ kind: "changed" });
    const published = PubSub.publish(updates, undefined);
    let toldAt = Number.NEGATIVE_INFINITY;
    /**
     * Set once a record of the guides or a file couldn't be read this run: from then on nothing
     * is swept or let go of until the next start, which reads them again.
     */
    let keepAll = false;
    const keepEverything = (what: string, error: AppError) =>
      Effect.suspend(() => {
        keepAll = true;
        return Effect.logWarning(
          `[guide] can't read ${what}; keeping every file until the next start`,
          error,
        );
      });
    /** Whether this run's sweep has begun: once, after every record was read. */
    let swept = false;

    /** Whether `other` is `subscription` with the login or link it had then. */
    const same = (subscription: GuideSubscription, other: GuideSubscription | null | undefined) =>
      other?.id === subscription.id && other.revision === subscription.revision;

    const savedAs = (subscriptionId: string) =>
      Effect.map(source.saved, (saved) => saved.find((each) => each.id === subscriptionId) ?? null);

    /** The saved subscription `subscriptionId` names, or `no-subscription`. */
    const savedOr = (subscriptionId: string) =>
      Effect.flatMap(savedAs(subscriptionId), (subscription) =>
        subscription ? Effect.succeed(subscription) : Effect.fail(noSubscription),
      );

    /** Names the guides a list of channels was read from, for a change made from that list. */
    const revisionOf = ({ id, revision }: GuideSubscription) => `${revision}.${generationOf(id)}`;

    /** Makes `next` a subscription's own guide, or none, and lets go of the one before. */
    const setLoaded = (id: string, next: Loaded | null) => {
      const before = loaded.get(id);
      if (next) loaded.set(id, next);
      else loaded.delete(id);
      if (before && before !== next) before.release();
    };

    /**
     * Claims the files `named` names in `folder`, and lets go of those `held` holds that it no
     * longer names: what is kept holds what it names. Only runs in the turn of what keeps them.
     */
    const hold = (folder: string, held: Map<string, Release>, named: ReadonlySet<string>) => {
      for (const [file, release] of held) {
        if (named.has(file)) continue;
        held.delete(file);
        release();
      }
      for (const file of named) {
        if (held.has(file)) continue;
        const release = files.claim(folder, file);
        if (release) held.set(file, release);
      }
    };

    /**
     * Claims the files `now` names for the subscription: its own guide's, and a legacy address's
     * still kept with it. Only runs in the subscription's turn.
     */
    const keep = (subscription: Pick<GuideSubscription, "id" | "store">, now: Settings | null) => {
      const held = kept.get(subscription.id) ?? new Map<string, Release>();
      const named = [now?.own?.file, now?.legacy?.document.file].filter((file) => file != null);
      hold(subscription.store, held, new Set(named));
      kept.set(subscription.id, held);
    };

    /** Claims a file a producer is about to write: it stays, and isn't swept, until let go. */
    const claimNew = (owner: Owner, file: string): Release =>
      files.claim(owner.store, file) ?? (() => {});

    /** What is set for a subscription's guide: from memory, or read once from the store. */
    const settingsOf = (subscription: GuideSubscription) =>
      Effect.suspend(() => {
        const read = settings.get(subscription.id);
        return read?.key === subscription.key
          ? Effect.succeed(read)
          : turn(subscription.id, readSettings(subscription));
      });

    /**
     * Reads what is set for a subscription's guide and the own guide kept, and claims the files
     * they name. An address a release before set for the subscription moves to the sources
     * first, and it and the mappings made against it name that source; one that can't is read
     * where it is. What can't be read is read again next time, and keeps everything meanwhile.
     * Only runs in the subscription's turn.
     */
    const readSettings = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id, key } = subscription;
        const known = settings.get(id);
        if (known?.key === key) return known;
        if (forgotten.has(id)) {
          return { key, mappings: {}, own: null, legacy: null, readable: true } satisfies Settings;
        }
        const unreadable = Symbol("unreadable");
        const stored = yield* store
          .config(subscription)
          .pipe(
            Effect.catchTag("Failed", (failure) =>
              Effect.as(keepEverything("what is set for a guide", failure.error), unreadable),
            ),
          );
        const own = yield* store
          .own(subscription)
          .pipe(
            Effect.catchTag("Failed", (failure) =>
              Effect.as(keepEverything("a guide on disk", failure.error), unreadable),
            ),
          );
        if (stored === unreadable || own === unreadable) {
          const read: Settings = {
            key,
            mappings: {},
            own: own === unreadable ? null : own,
            legacy: null,
            readable: false,
          };
          keep(subscription, read);
          return read;
        }
        const kept = stored?.external ?? null;
        const listed =
          kept?.source != null && (yield* sourcesNow).some((each) => each.id === kept.source);
        const legacy: LegacyExternal | null =
          kept && !listed ? { ...kept, source: yield* adoptLegacy(subscription, kept) } : kept;
        const mappings = Object.fromEntries(
          Object.entries(stored?.mappings ?? {}).map(([channelId, mapping]) => [
            channelId,
            {
              ...mapping,
              source: mapping.source ?? (legacy ? (legacy.source ?? LEGACY) : OWN_GUIDE),
            },
          ]),
        );
        const read: Settings = { key, mappings, own, legacy, readable: true };
        // Noted where it moved to, and what the mappings made before name: added to what is
        // kept, never taken from it.
        const older = Object.values(stored?.mappings ?? {}).some((each) => !each.source);
        const moved = legacy?.source != null && legacy.source !== kept?.source;
        if (moved || (!legacy && older)) {
          yield* store
            .setConfig(subscription, storedConfig(read))
            .pipe(
              Effect.catchTag("Failed", (failure) =>
                Effect.logWarning("[guide] can't keep what is set for the guide", failure.error),
              ),
            );
        }
        keep(subscription, read);
        if (legacy && legacy.source === null) yield* readPending(subscription, legacy);
        settings.set(id, read);
        return read;
      });

    /** Each subscription's guide of an address that couldn't move this run, read where it is. */
    const pending = new Map<string, Loaded>();
    const setPending = (id: string, next: Loaded | null) => {
      const before = pending.get(id);
      if (next) pending.set(id, next);
      else pending.delete(id);
      if (before && before !== next) before.release();
    };

    /**
     * Reads the download of an address a release before set where it is, for a subscription
     * whose address couldn't move to the sources this run. One an older release kept as XMLTV is
     * indexed beside it in the background first, into a file nothing names, which goes at a
     * later start. Only runs in the subscription's turn.
     */
    const readPending = (subscription: GuideSubscription, legacy: LegacyExternal) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const { document } = legacy;
        if (document.kind === "index") {
          const reader = yield* Effect.promise(() => files.open(subscription.store, document.file));
          if (reader) {
            const { index, release } = reader;
            setPending(id, { fetchedAt: document.fetchedAt, file: document.file, index, release });
          }
          return;
        }
        if (jobs.has(legacyKey(id))) return;
        yield* startJob(legacyKey(id), "reindex", versionOf(subscription), (report) =>
          reindexInto(subscription, document, report, (_index, adopt) =>
            Effect.sync(() => {
              if (settings.get(id)?.legacy?.source !== null) return null;
              setPending(id, adopt());
              return true;
            }),
          ).pipe(
            Effect.flatMap((kept) => (kept ? published : Effect.void)),
            downloadOne,
            Effect.catchTag("Failed", (failure) =>
              Effect.logWarning("[guide] can't read a guide address's download", failure.error),
            ),
          ),
        );
      });

    /**
     * Changes what is set for a subscription's guide, in its turn and only while the change
     * still applies: the subscription is saved with the login it had, and wasn't forgotten since
     * `started`. `next` gives what to set from what is set then, or null to leave it. What it
     * changes is written, own guide and mappings alike, the files it names are claimed and those
     * it no longer names let go of. `applied` runs then, still in the turn. Answers what was set
     * before, or null when nothing changed.
     */
    const change = (
      subscription: GuideSubscription,
      started: number,
      next: (now: Settings) => Effect.Effect<Settings | null, Failed>,
      applied: () => void = () => {},
    ) =>
      turn(
        subscription.id,
        Effect.gen(function* () {
          const { id } = subscription;
          if (generationOf(id) !== started || !same(subscription, yield* savedAs(id))) return null;
          const now = yield* readSettings(subscription);
          const then = yield* next(now);
          if (!then) return null;
          if (then.mappings !== now.mappings && !now.readable) {
            // What is set couldn't be read: a write would lose it.
            return yield* Effect.fail(
              failedWith(new Error("What is set for the guide can't be read.")),
            );
          }
          if (then.own !== now.own) yield* store.setOwn(subscription, then.own);
          if (then.mappings !== now.mappings)
            yield* store.setConfig(subscription, storedConfig(then));
          // What couldn't be read is read again next time, not kept as it was taken.
          if (then.readable) settings.set(id, then);
          keep(subscription, then);
          applied();
          return now;
        }),
      );

    /** A subscription's guide goes: what was loaded and known of it goes too. */
    const turned = (id: string) => {
      generations.set(id, generationOf(id) + 1);
      setLoaded(id, null);
      absent.delete(id);
      unread.delete(id);
      failures.delete(id);
    };

    /** Readers handed on to a guide, which their opener then doesn't let go of. */
    const adopted = new WeakSet<Reader>();

    /**
     * Opens the index `document` names in `owner`'s folder and hands it to `use`, which may make
     * it a guide with `adopt`. Unless adopted, it closes again however `use` ends, stopped too;
     * once adopted, the guide owns it, whatever happens after.
     */
    const opening = <A, E>(
      owner: Owner,
      document: Omit<GuideDocument, "kind">,
      use: (opened: { readonly index: GuideIndex; adopt(): Loaded }) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | Failed> =>
      Effect.acquireUseRelease(
        Effect.promise(() => files.open(owner.store, document.file)),
        (reader): Effect.Effect<A, E | Failed> => {
          if (!reader) return Effect.fail(failedWith(new Error("The guide can't be read.")));
          return use({
            index: reader.index,
            adopt: () => {
              adopted.add(reader);
              return {
                fetchedAt: document.fetchedAt,
                file: document.file,
                index: reader.index,
                release: reader.release,
              };
            },
          });
        },
        (reader) =>
          Effect.sync(() => {
            if (reader && !adopted.delete(reader)) reader.release();
          }),
      );

    /**
     * A saved subscription's own guide: from memory, or opened from what is kept, once. Null
     * while a document an older release kept is indexed: lookups don't wait for that.
     */
    const current = (subscription: GuideSubscription) =>
      Effect.suspend(() => {
        const { id } = subscription;
        const guide = loaded.get(id);
        // Nothing is kept for a subscription without a guide, so there is nothing to read.
        if (
          guide ||
          absent.has(id) ||
          unread.has(id) ||
          forgotten.has(id) ||
          jobs.get(id)?.kind === "reindex"
        ) {
          return Effect.succeed(guide ?? null);
        }
        return turn(id, readStored(subscription));
      });

    /** `current`, once the indexing of what an older release kept is done, when it is under way. */
    const keptGuide = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const guide = yield* current(subscription);
        const job = jobs.get(subscription.id);
        if (guide || job?.kind !== "reindex") return guide;
        yield* Fiber.await(job.fiber);
        return loaded.get(subscription.id) ?? null;
      });

    /** Only runs in the subscription's turn. */
    const readStored = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const known = loaded.get(id);
        if (known) return known;
        if (absent.has(id) || unread.has(id)) return null;
        const document = (yield* readSettings(subscription)).own;
        if (document?.kind === "xmltv") {
          // Indexed in the background, unless a download already brings a new one.
          if (!jobs.has(id)) {
            const started = generationOf(id);
            yield* startJob(id, "reindex", versionOf(subscription), (report) =>
              reindex(subscription, document, started, report),
            );
          }
          return null;
        }
        const reader = document
          ? yield* Effect.promise(() => files.open(subscription.store, document.file))
          : null;
        if (!document || !reader) {
          if (document) yield* Effect.logWarning("[guide] ignoring the guide on disk");
          unread.add(id);
          return null;
        }
        const guide: Loaded = {
          fetchedAt: document.fetchedAt,
          file: document.file,
          index: reader.index,
          release: reader.release,
        };
        loaded.set(id, guide);
        return guide;
      });

    /**
     * Notes why a subscription's own download failed, for the status, while it still applies:
     * since when is the first failure after the last download that worked.
     */
    const noteFailure = (subscription: GuideSubscription, started: number, error: AppError) =>
      Effect.gen(function* () {
        const { id } = subscription;
        if (generationOf(id) !== started) return;
        failures.set(id, { at: failures.get(id)?.at ?? (yield* Clock.currentTimeMillis), error });
        yield* published;
      });

    /**
     * Keeps the index file `previous` of `owner` while `build` runs, which reads the past from it.
     * Taken from what is set when the build begins, at once; a file that went meanwhile is none.
     */
    const pinning = <A, E, R>(
      owner: Owner,
      previous: string | null,
      build: (previous: string | null) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => (previous === null ? null : files.claim(owner.store, previous))),
        (pin) => build(pin ? previous : null),
        (pin) => Effect.sync(() => pin?.()),
      );

    /**
     * Downloads what `fetch` answers into `owner`'s folder and indexes it into a new file there,
     * telling `report` how far each step got, then hands the index to `use`. Answers `none` when
     * the own guide answers it has none. The download and the index are claimed for this work
     * from before they are written until it ends, however it ends: the download goes then, and
     * so does the index unless `use` handed it to another holder.
     */
    const fetchAndIndex = <A>(
      owner: Owner,
      fetch: (
        signal: AbortSignal,
      ) => Promise<{ body: AsyncIterable<Uint8Array>; size: number | null } | null>,
      { strict, previous }: { strict: boolean; previous: string | null },
      report: (progress: Progress) => void,
      use: (indexed: Indexed) => Effect.Effect<A, Failed>,
    ): Effect.Effect<
      { readonly none: true } | { readonly none: false; readonly used: A },
      Failed
    > =>
      Effect.gen(function* () {
        const fetchedAt = yield* Clock.currentTimeMillis;
        const name = store.newDownload();
        const file = store.newIndex();
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => [claimNew(owner, name), claimNew(owner, file)]),
          () =>
            Effect.acquireUseRelease(
              store.download(owner, name),
              (download) =>
                Effect.gen(function* () {
                  const got = yield* Effect.tryPromise({
                    try: async (signal) => {
                      const answer = await fetch(signal);
                      if (!answer) return false;
                      let bytes = 0;
                      report({ state: "downloading", bytes, total: answer.size });
                      for await (const chunk of answer.body) {
                        bytes += chunk.byteLength;
                        // Packed or not, nothing larger than the guide may unpack to is kept.
                        if (bytes > GUIDE_LIMITS.bytes) {
                          throw new AppFailure({
                            kind: "guide",
                            failure: { kind: "too-large", limit: "bytes" },
                          });
                        }
                        await download.write(chunk);
                        report({ state: "downloading", bytes, total: answer.size });
                      }
                      await download.close();
                      return true;
                    },
                    catch: failedWith,
                  });
                  if (!got) return { none: true } as const;
                  const summary = yield* indexed(owner, {
                    document: download.file,
                    file,
                    previous,
                    since: fetchedAt,
                    strict,
                    report,
                  });
                  return { none: false, used: yield* use({ file, fetchedAt, summary }) } as const;
                }),
              (download) => Effect.promise(() => download.discard()),
            ),
          (claims) => Effect.sync(() => claims.forEach((release) => release())),
        );
      });

    /**
     * Indexes a document of `owner`'s folder into `file` there, in the worker. Stopped, it waits
     * for the worker to have ended before it ends itself, so whatever the build read or wrote is
     * let go of only once the worker no longer has it open.
     */
    const indexed = (
      owner: Owner,
      {
        document,
        file,
        previous,
        since,
        strict,
        report,
      }: {
        document: string;
        file: string;
        previous: string | null;
        since: number;
        strict: boolean;
        report: (progress: Progress) => void;
      },
    ) =>
      Effect.gen(function* () {
        const began = yield* Clock.currentTimeMillis;
        report({ state: "reading", programmes: 0, since: began });
        const stop = new AbortController();
        const built = indexer.build(
          {
            document: store.path(owner, document),
            target: store.path(owner, file),
            previous: previous === null ? null : store.path(owner, previous),
            since,
            archive: owner.archive,
            strict,
          },
          (programmes) => report({ state: "reading", programmes, since: began }),
          stop.signal,
        );
        return yield* Effect.tryPromise({ try: () => built, catch: failedWith }).pipe(
          Effect.onInterrupt(() =>
            Effect.promise(() => {
              stop.abort();
              return built.then(
                () => {},
                () => {},
              );
            }),
          ),
        );
      });

    /**
     * Indexes `document`, a document an older release kept in `owner`'s folder, into a new
     * index there, and hands it to `keepIndex`, which keeps it in the document's place while
     * that is still the one kept, answering null when it isn't. The document goes once nothing
     * names it. Answers whether the index was kept.
     */
    const reindexInto = (
      owner: Owner,
      document: GuideDocument,
      report: (progress: Progress) => void,
      keepIndex: (index: GuideDocument, adopt: () => Loaded) => Effect.Effect<unknown, Failed>,
    ) =>
      Effect.gen(function* () {
        const file = store.newIndex();
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => [claimNew(owner, file), files.claim(owner.store, document.file)]),
          ([, input]) =>
            Effect.gen(function* () {
              if (!input) return false;
              yield* indexed(owner, {
                document: document.file,
                file,
                previous: null,
                since: yield* Clock.currentTimeMillis,
                strict: false,
                report,
              });
              const index: GuideDocument = { file, fetchedAt: document.fetchedAt, kind: "index" };
              const kept = yield* opening(owner, index, ({ adopt }) => keepIndex(index, adopt));
              return kept !== null;
            }),
          (claims) => Effect.sync(() => claims.forEach((release) => release?.())),
        );
      });

    /**
     * Asks the subscription for its own guide and downloads and indexes it; the new guide
     * replaces the old only once whole, and only while its answer still counts, checked in the
     * subscription's turn. A subscription that has none leaves none behind, in memory or on disk.
     */
    const downloadOwn = (
      subscription: GuideSubscription,
      ask: NonNullable<GuideSubscription["download"]>,
      started: number,
      report: (progress: Progress) => void,
    ) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const before = (yield* settingsOf(subscription)).own;
        const answer = yield* pinning(
          subscription,
          before?.kind === "index" ? before.file : null,
          (previous) =>
            fetchAndIndex(
              subscription,
              async (signal) => {
                const guide = await ask(signal);
                return guide.kind === "none" ? null : { body: guide.body, size: guide.size };
              },
              { strict: false, previous },
              report,
              ({ file, fetchedAt }) =>
                opening(subscription, { file, fetchedAt }, ({ adopt }) =>
                  // Kept only when it is also the guide to show: the next start reads what is kept.
                  change(
                    subscription,
                    started,
                    (now) => Effect.succeed({ ...now, own: { file, fetchedAt, kind: "index" } }),
                    () => {
                      failures.delete(id);
                      absent.delete(id);
                      unread.delete(id);
                      setLoaded(id, adopt());
                    },
                  ),
                ),
            ),
        );
        if (answer.none) {
          // It answered that it has none. Asked again and still none: nothing is told.
          let told = false;
          yield* change(
            subscription,
            started,
            (now) => Effect.succeed({ ...now, own: null }),
            () => {
              failures.delete(id);
              told = !absent.has(id);
              absent.add(id);
              // A guide loaded before is the one the subscription had before.
              setLoaded(id, null);
            },
          );
          if (told) yield* published;
          return;
        }
        if (answer.used) yield* published;
      });

    /**
     * Indexes the document an older release kept for a subscription's own guide and keeps the
     * index in its place, while it is still the document kept. One that can't be read counts as
     * none kept.
     */
    const reindex = (
      subscription: GuideSubscription,
      document: GuideDocument,
      started: number,
      report: (progress: Progress) => void,
    ) =>
      reindexInto(subscription, document, report, (index, adopt) =>
        change(
          subscription,
          started,
          (was) => Effect.succeed(was.own?.file === document.file ? { ...was, own: index } : null),
          () => {
            unread.delete(subscription.id);
            setLoaded(subscription.id, adopt());
          },
        ),
      ).pipe(
        Effect.flatMap((kept) => (kept ? published : Effect.void)),
        downloadOne,
        Effect.catchTag("Failed", (failure) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("[guide] ignoring the guide on disk", failure.error);
            if (generationOf(subscription.id) === started) unread.add(subscription.id);
          }),
        ),
      );

    /** Downloads a subscription's own guide. */
    const download = (subscription: GuideSubscription, report: (progress: Progress) => void) =>
      Effect.gen(function* () {
        const started = generationOf(subscription.id);
        const run = subscription.download
          ? downloadOwn(subscription, subscription.download, started, report)
          : Effect.fail(needsSecret(subscription));
        yield* run.pipe(
          Effect.tapError((failure) => noteFailure(subscription, started, failure.error)),
        );
      }).pipe(downloadOne, diagnosed("guide"));

    /** What a subscription's work is begun for: it as it is saved now. */
    const versionOf = (subscription: GuideSubscription) =>
      `${subscription.revision}.${generationOf(subscription.id)}`;

    /**
     * Starts work on a guide in the service's scope, under `key`: `work` tells how it goes,
     * which the status shows, and every step of it is told. A download shows as one from the
     * start, before its server answers. Work still under way under `key`, begun for what was
     * asked before, as under a login stored anew since, would apply nothing: it is stopped, so
     * the work under a key is all there is for `forget` to stop.
     */
    const startJob = (
      key: string,
      kind: Job["kind"],
      version: string,
      work: (report: (progress: Progress) => void) => Effect.Effect<void, Failed>,
    ) =>
      Effect.gen(function* () {
        const token = {};
        const report = (step: Progress) => {
          if (jobs.get(key)?.token !== token) return;
          const before = progress.get(key);
          progress.set(key, step);
          const now = performance.now();
          // A new step is told at once; how far one got, a few times a second.
          if (before?.state === step.state && now - toldAt < PROGRESS_EVERY_MS) return;
          toldAt = now;
          PubSub.publishUnsafe(updates, undefined);
        };
        const replaced = jobs.get(key);
        if (replaced) yield* Effect.forkIn(Fiber.interrupt(replaced.fiber), scope);
        const fiber = yield* Effect.forkIn(
          work(report).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                if (jobs.get(key)?.token !== token) return Effect.void;
                jobs.delete(key);
                progress.delete(key);
                return published;
              }),
            ),
          ),
          scope,
        );
        jobs.set(key, { kind, version, token, fiber });
        if (kind === "download" && !progress.has(key))
          report({ state: "downloading", bytes: 0, total: null });
        return fiber;
      });

    /** Waits for work a change to the guide can stop, which then fails with `stopped`. */
    const joined = <A>(fiber: Fiber.Fiber<A, Failed>, stopped: GuideFailure) =>
      Effect.flatMap(Fiber.await(fiber), (exit) =>
        Exit.isSuccess(exit)
          ? Effect.succeed(exit.value)
          : Cause.hasInterrupts(exit.cause)
            ? Effect.fail(failed(stopped))
            : Effect.failCause(exit.cause),
      );

    /**
     * Downloads under `key`: joins the download under way when it was begun for `version`, else
     * starts one, after the indexing of what an older release kept when that is under way. Once
     * what it was asked for no longer `stands` by then, nothing starts and it fails with `changed`.
     */
    const downloading = (
      key: string,
      version: string,
      work: (report: (progress: Progress) => void) => Effect.Effect<void, Failed>,
      stands: () => boolean = () => true,
    ) =>
      Effect.gen(function* () {
        const indexing = jobs.get(key);
        if (indexing?.kind === "reindex") yield* Fiber.await(indexing.fiber);
        if (!stands()) return yield* changed;
        const under = jobs.get(key);
        const running =
          under?.kind === "download" && under.version === version
            ? under.fiber
            : yield* startJob(key, "download", version, work);
        yield* joined(running, { kind: "changed" });
      });

    /**
     * Downloads a subscription's own guide, asked for while its guide was the one of `started`.
     * Once `forget` dropped that guide, as while what an older release kept was indexed, no
     * download starts: one would hold the subscription's files, and its removal wait for it.
     */
    const refreshOf = (
      subscription: GuideSubscription,
      started = generationOf(subscription.id),
    ): Effect.Effect<void, Failed> =>
      Effect.gen(function* () {
        const { id } = subscription;
        // What an older release kept is read first, so it is indexed before the download.
        yield* current(subscription);
        if (subscription.download === null) return yield* needsSecret(subscription);
        yield* downloading(
          id,
          versionOf(subscription),
          (report) => download(subscription, report),
          () => generationOf(id) === started && !forgotten.has(id),
        );
      });

    const staleOf = (subscription: GuideSubscription, started = generationOf(subscription.id)) =>
      Effect.gen(function* () {
        // Known to have none: asking again every check would only read the playlist over and over.
        if (absent.has(subscription.id)) return;
        const guide = yield* keptGuide(subscription);
        const now = yield* Clock.currentTimeMillis;
        if (guide && now - guide.fetchedAt < MAX_AGE_MS) return;
        yield* refreshOf(subscription, started);
      });

    /**
     * Stops the work under `key`, when there is some, and waits until it has ended: its worker
     * too, and what it held let go of.
     */
    const stopJob = (key: string) =>
      Effect.suspend(() => {
        const running = jobs.get(key);
        jobs.delete(key);
        progress.delete(key);
        return running ? Fiber.interrupt(running.fiber) : Effect.void;
      });

    /** The sources in their order, once read this run. */
    let sourceList: readonly Source[] | null = null;
    /** Each source's origin by its id, the same object while the list is. */
    let sourceOrigins: ReadonlyMap<string, string> = new Map();
    /** Each source's download open to read, by its file. */
    const cacheLoaded = new Map<string, Loaded>();
    /** The downloads of the sources this run couldn't read, by file: none is read again. */
    const cacheUnread = new Set<string>();
    /** The files the sources' list names, each with its claim. */
    const sourceKept = new Map<string, Release>();
    /**
     * Downloads a source's own replaced in a run that keeps everything: held until the run ends,
     * and swept at the next start that reads everything.
     */
    const pinned: Release[] = [];

    /** What the store keeps of a source. */
    const storedOf = ({ address: _address, ...stored }: Source): StoredSource => stored;

    /** The source's download open to read, if any. */
    const openOf = (each: Pick<StoredSource, "document"> | undefined) =>
      each?.document ? cacheLoaded.get(each.document.file) : undefined;

    /**
     * Makes `list` the sources: the files it names are claimed, and a download it no longer
     * names closes and goes once nothing reads it. Only runs in the sources' turn.
     */
    const setSources = (list: readonly Source[]) => {
      sourceList = list;
      sourceOrigins = new Map(list.map(({ id, origin }) => [id, origin]));
      const named = new Set(list.flatMap(({ document }) => (document ? [document.file] : [])));
      for (const [file, guide] of cacheLoaded) {
        if (named.has(file)) continue;
        cacheLoaded.delete(file);
        guide.release();
      }
      hold(sourcesOwner.store, sourceKept, named);
    };

    /** Makes `next` the open download of its file, letting go of one open before. */
    const setCacheLoaded = (next: Loaded) => {
      const before = cacheLoaded.get(next.file);
      cacheLoaded.set(next.file, next);
      if (before && before !== next) before.release();
    };

    /**
     * Reads the sources and opens their addresses, and claims the files they name. Sources that
     * are kept but can't be read fail, and keep everything this run: they are read again next
     * time, never taken for none. Only runs in the sources' turn.
     */
    const readSources = Effect.gen(function* () {
      if (sourceList) return sourceList;
      const stored = yield* store
        .sources(sourcesOwner)
        .pipe(Effect.tapError((failure) => keepEverything("the guide sources", failure.error)));
      const list = yield* Effect.forEach(stored, (kept) =>
        Effect.map(addresses.open(kept.sealedAddress), (address): Source => ({ ...kept, address })),
      );
      setSources(list);
      return list;
    });

    /** The sources in their order, for a lookup: from memory, or read once; none while unreadable. */
    const sourcesNow = Effect.suspend(() =>
      sourceList
        ? Effect.succeed(sourceList)
        : turn(SOURCES, readSources).pipe(
            Effect.catchTag("Failed", () => Effect.succeed<readonly Source[]>([])),
          ),
    );

    /**
     * Changes the sources in their turn: `next` gives the list from the one then, or null to
     * leave it. The list is written, the files it names claimed and those it no longer names let
     * go of, and `applied` runs, still in the turn. Answers the list before, or null when nothing
     * changed. Fails while the sources can't be read: a write would lose them.
     */
    const changeSources = (
      next: (now: readonly Source[]) => Effect.Effect<readonly Source[] | null, Failed>,
      applied: () => void = () => {},
    ) =>
      turn(
        SOURCES,
        Effect.gen(function* () {
          const now = yield* readSources;
          const then = yield* next(now);
          if (!then) return null;
          yield* store.setSources(sourcesOwner, then.map(storedOf));
          setSources(then);
          applied();
          return now;
        }),
      );

    /** `list` with the source `id` as `update` makes it, or null without it. */
    const updated = (
      list: readonly Source[],
      id: string,
      update: (source: Source) => Source | null,
    ): readonly Source[] | null => {
      const was = list.find((each) => each.id === id);
      const then = was && update(was);
      return then ? list.map((each) => (each === was ? then : each)) : null;
    };

    /**
     * Whether, of the downloads identical addresses had, `one` is the one their source reads
     * rather than `other`: the newer, then the larger, then the first by name, whichever
     * subscription is read first.
     */
    const preferred = (one: MovedFrom, other: MovedFrom) =>
      one.fetchedAt !== other.fetchedAt
        ? one.fetchedAt > other.fetchedAt
        : one.bytes !== other.bytes
          ? one.bytes > other.bytes
          : one.file < other.file;

    /**
     * Moves an address a release before set for a subscription to the sources: the source the
     * same address already is, else a new one after the others, and answers its id. Its download
     * is copied to the sources' folder, claimed there before `sources.json` names it, when it is
     * the one the source is to read (`preferred`); the source reads one download only. It only
     * adds: the subscription keeps the address and its file until the source's first download of
     * its own. Null when it couldn't be kept, the address then read where it is, to move at the
     * next start. A file that can't be looked at keeps everything this run. Takes the sources'
     * turn, from the subscription's.
     */
    const adoptLegacy = (subscription: GuideSubscription, legacy: LegacyExternal) =>
      turn(
        SOURCES,
        Effect.gen(function* () {
          const list = yield* readSources;
          const same = list.find((each) => each.identity === legacy.identity);
          const { file, fetchedAt } = legacy.document;
          // Copied before, by a run that couldn't note where.
          if (same?.movedFrom?.file === file) return same.id;
          const unreadable = Symbol("unreadable");
          const bytes = yield* store
            .bytesOf(subscription, file)
            .pipe(
              Effect.catchTag("Failed", (failure) =>
                Effect.as(keepEverything("a guide address's download", failure.error), unreadable),
              ),
            );
          if (bytes === unreadable) return null;
          const candidate: MovedFrom | null = bytes === null ? null : { file, fetchedAt, bytes };
          const read =
            candidate !== null &&
            (!same?.document ||
              (same.movedFrom
                ? preferred(candidate, same.movedFrom)
                : candidate.fetchedAt > same.document.fetchedAt));
          // Another download stays the source's: this one stays where it is, unread.
          if (same && !read) return same.id;
          const claim = read ? claimNew(sourcesOwner, file) : () => {};
          return yield* Effect.gen(function* () {
            const copied = read ? yield* store.copy(subscription, sourcesOwner, file) : "missing";
            if (copied === "failed") {
              yield* keepEverything("a guide address's download", {
                kind: "unexpected",
                detail: "It couldn't be copied to the sources.",
              });
              return null;
            }
            if (copied === "missing" && same) return same.id;
            const document = copied === "copied" ? legacy.document : null;
            const movedFrom = copied === "copied" ? candidate : null;
            const address = yield* addresses.open(legacy.sealedAddress);
            const adopted: Source = same
              ? { ...same, document, movedFrom }
              : {
                  id: randomUUID(),
                  origin: legacy.origin,
                  identity: legacy.identity,
                  sealedAddress: legacy.sealedAddress,
                  label: null,
                  document,
                  failure: legacy.failure,
                  movedFrom,
                  address,
                };
            const then = same
              ? list.map((each) => (each === same ? adopted : each))
              : [...list, adopted];
            yield* store.setSources(sourcesOwner, then.map(storedOf));
            setSources(then);
            return adopted.id;
          }).pipe(Effect.ensuring(Effect.sync(claim)));
        }).pipe(
          Effect.catchTag("Failed", (failure) =>
            Effect.logWarning(
              "[guide] can't move a guide address to the sources",
              failure.error,
            ).pipe(Effect.as(null)),
          ),
        ),
      );

    /** Whether a source has a download of its own, not one a move brought. */
    const ownDownload = (each: StoredSource | undefined) =>
      each?.document != null && each.movedFrom === null;

    /**
     * Lets go of the address a release before set for a subscription, and of its file, once
     * the source it moved to has a download of its own, or `removed`, the source the viewer
     * removed, is that one: in the subscription's turn, and only while everything this run
     * could be read.
     */
    const retireLegacy = (subscription: GuideSubscription, removed: string | null = null) =>
      turn(
        subscription.id,
        Effect.gen(function* () {
          const now = settings.get(subscription.id);
          const moved = now?.legacy?.source;
          if (keepAll || !now || !moved) return;
          const at = (sourceList ?? []).find((each) => each.id === moved);
          if (moved !== removed && !ownDownload(at)) return;
          const then: Settings = { ...now, legacy: null };
          const written = yield* store.setConfig(subscription, storedConfig(then)).pipe(
            Effect.as(true),
            Effect.catchTag("Failed", (failure) =>
              Effect.logWarning("[guide] can't keep what is set for the guide", failure.error).pipe(
                Effect.as(false),
              ),
            ),
          );
          if (!written) return;
          settings.set(subscription.id, then);
          keep(subscription, then);
        }),
      );

    /**
     * Lets go of the addresses releases before set that moved to source `id`, of the
     * subscriptions read this run, once it has a download of its own, or was `removed`.
     */
    const retireMovedTo = (id: string, removed = false) =>
      Effect.gen(function* () {
        for (const subscription of yield* source.saved) {
          if (settings.get(subscription.id)?.legacy?.source !== id) continue;
          yield* retireLegacy(subscription, removed ? id : null);
        }
      });

    /**
     * Whether the registry holds `file` of `folder`, or the file being written into it under
     * its name and `.part`: a sweep leaves both, asking just before each goes.
     */
    const held = (folder: string) => (file: string) =>
      files.known(folder, file) ||
      (file.endsWith(".part") && files.known(folder, file.slice(0, -".part".length)));

    /**
     * Once every record of the guides was read this run, and only then: sweeps away the files
     * nothing holds in each folder, what work cut short in a run before left, and lets go of the
     * addresses releases before set whose sources have downloads of their own since.
     */
    const sweepAll = (saved: readonly GuideSubscription[]) =>
      Effect.gen(function* () {
        for (const subscription of saved) {
          yield* turn(
            subscription.id,
            Effect.suspend(() =>
              keepAll || forgotten.has(subscription.id)
                ? Effect.void
                : store.sweep(subscription, held(subscription.store)),
            ),
          );
        }
        yield* turn(
          SOURCES,
          Effect.suspend(() =>
            keepAll ? Effect.void : store.sweep(sourcesOwner, held(sourcesOwner.store)),
          ),
        );
        for (const subscription of saved) yield* retireLegacy(subscription);
      });

    /**
     * The sources in their order, each one's download opened from what is kept, once, with the
     * addresses releases before gave subscriptions among them. A download an older release kept
     * as XMLTV is indexed in the background meanwhile. The first time everything could be read,
     * the run's sweep begins. Never runs in a turn.
     */
    const currentSources = Effect.gen(function* () {
      // Reading what is set for each subscription moves an address a release before gave it.
      const saved = yield* source.saved;
      yield* Effect.forEach(saved, settingsOf, { discard: true });
      const list = yield* sourcesNow;
      const unopened = ({ id, document }: Source) =>
        document !== null &&
        !cacheLoaded.has(document.file) &&
        !cacheUnread.has(document.file) &&
        jobs.get(sourceKey(id))?.kind !== "reindex";
      if (list.some(unopened)) yield* turn(SOURCES, readStoredSources);
      if (!swept && !keepAll && sourceList) {
        swept = true;
        // In the background: it takes each folder's turn, which a change under way may hold,
        // and nothing waits for it, every file in use being held.
        yield* Effect.forkIn(sweepAll(saved), scope);
      }
      return sourceList ?? list;
    });

    /** Only runs in the sources' turn. */
    const readStoredSources = Effect.gen(function* () {
      for (const each of sourceList ?? []) {
        const { id, document } = each;
        const key = sourceKey(id);
        if (!document || cacheLoaded.has(document.file) || cacheUnread.has(document.file)) continue;
        if (jobs.get(key)?.kind === "reindex") continue;
        if (document.kind === "xmltv") {
          // A download under way brings an index in its place.
          if (jobs.has(key)) continue;
          yield* startJob(key, "reindex", each.identity, (report) =>
            reindexSource(each, document, report),
          );
          continue;
        }
        const reader = yield* Effect.promise(() => files.open(sourcesOwner.store, document.file));
        if (!reader) {
          yield* Effect.logWarning("[guide] ignoring a guide source on disk");
          cacheUnread.add(document.file);
          continue;
        }
        setCacheLoaded({
          fetchedAt: document.fetchedAt,
          file: document.file,
          index: reader.index,
          release: reader.release,
        });
      }
    });

    /** Indexes the document an older release kept for a source, while it is still the one kept. */
    const reindexSource = (each: Source, document: GuideDocument, report: (p: Progress) => void) =>
      reindexInto(sourcesOwner, document, report, (index, adopt) =>
        changeSources(
          (now) =>
            Effect.succeed(
              updated(now, each.id, (was) =>
                was.document?.file === document.file ? { ...was, document: index } : null,
              ),
            ),
          () => setCacheLoaded(adopt()),
        ),
      ).pipe(
        Effect.flatMap((kept) => (kept ? published : Effect.void)),
        downloadOne,
        Effect.catchTag("Failed", (failure) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("[guide] ignoring a guide source on disk", failure.error);
            cacheUnread.add(document.file);
          }),
        ),
      );

    /**
     * Notes why a source's download failed, kept with the source so it shows after a restart,
     * and this run also when that can't be written: since when is the first failure after the
     * last download that worked.
     */
    const noteSourceFailure = (each: Source, error: AppError) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const failing = (now: readonly Source[]) =>
          updated(now, each.id, (was) => ({
            ...was,
            failure: { at: was.failure?.at ?? at, error },
          }));
        const stands = yield* changeSources((now) => Effect.succeed(failing(now))).pipe(
          Effect.catchTag("Failed", () =>
            turn(
              SOURCES,
              Effect.sync(() => {
                const then = sourceList && failing(sourceList);
                if (then) setSources(then);
                return then;
              }),
            ),
          ),
        );
        if (stands) yield* published;
      });

    /**
     * Downloads a source and indexes it into a file of its own. It becomes the source's guide,
     * and the one before goes, only once it is read whole, and only while the source is still
     * kept with the same address. Until then, and when it fails, the last one stays as it is.
     */
    const downloadSource = (each: Source, report: (progress: Progress) => void) =>
      Effect.gen(function* () {
        const { id, identity, address, document } = each;
        if (address === null) return yield* failed({ kind: "locked" });
        const before = yield* pinning(
          sourcesOwner,
          document?.kind === "index" ? document.file : null,
          (previous) =>
            fetchAndIndex(
              sourcesOwner,
              (signal) => addresses.fetch(address, signal),
              { strict: true, previous },
              report,
              ({ file, fetchedAt }) =>
                opening(sourcesOwner, { file, fetchedAt }, ({ adopt }) =>
                  changeSources(
                    (now) =>
                      Effect.succeed(
                        updated(now, id, (was) => {
                          if (was.identity !== identity) return null;
                          // In a run that keeps everything the one it replaces stays until the
                          // run ends; the next start that reads everything sweeps it.
                          const replaced = was.document?.file;
                          const claim =
                            keepAll && replaced ? files.claim(sourcesOwner.store, replaced) : null;
                          if (claim) pinned.push(claim);
                          return {
                            ...was,
                            document: { file, fetchedAt, kind: "index" },
                            movedFrom: null,
                            failure: null,
                          };
                        }),
                      ),
                    () => setCacheLoaded(adopt()),
                  ),
                ),
            ),
        );
        if (!before.none && before.used) {
          yield* published;
          // The addresses releases before set that moved to it go, with their files, in the
          // background: a subscription's turn may be held a while.
          yield* Effect.forkIn(retireMovedTo(id), scope);
        }
      }).pipe(
        Effect.tapError((failure) => noteSourceFailure(each, failure.error)),
        downloadOne,
        diagnosed("guide"),
      );

    /**
     * Downloads a source: joins its download under way, else starts one, after the indexing of
     * what an older release kept when that is under way. One removed by then isn't asked for and
     * fails with `changed`, and one whose address the keychain no longer opens isn't either: it
     * says so, and keeps what it had.
     */
    const refreshSourceOf = (each: Source) =>
      Effect.gen(function* () {
        if (each.address === null) return yield* failed({ kind: "locked" });
        const key = sourceKey(each.id);
        const indexing = jobs.get(key);
        if (indexing?.kind === "reindex") yield* Fiber.await(indexing.fiber);
        // As it is now: the indexing replaced the document it had, which the download builds on.
        const kept = sourceList?.find((one) => one.id === each.id);
        if (!kept) return yield* changed;
        yield* downloading(key, kept.identity, (report) => downloadSource(kept, report));
      });

    /**
     * Starts the downloads of the sources with no guide, or one six hours old, that can be had.
     * One whose kept document is still being indexed, as at the first start after a move, downloads
     * once that is done, in the background: nothing waits for it, and removing it stops both.
     */
    const staleSources = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const each of yield* currentSources) {
        const key = sourceKey(each.id);
        const job = jobs.get(key);
        if (each.address === null || job?.kind === "download") continue;
        // One a move brought downloads straight away: until then it reads one download only.
        const fresh = each.document && each.movedFrom === null;
        if (fresh && now - (each.document?.fetchedAt ?? 0) < MAX_AGE_MS) continue;
        if (job) {
          // How it ends shows in the status.
          yield* Effect.forkIn(
            refreshSourceOf(each).pipe(Effect.catchTag("Failed", () => Effect.void)),
            scope,
          );
        } else {
          yield* startJob(key, "download", each.identity, (report) => downloadSource(each, report));
        }
      }
    });

    // Checks now and then; the app asks for the first downloads itself, after its own start.
    // Each guide's check stands alone: one that fails holds no other back.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* staleSources.pipe(
          Effect.catchDefect((defect) => Effect.logWarning("[guide] refresh failed", defect)),
        );
        yield* Effect.forEach(
          yield* source.saved,
          (subscription) =>
            (subscription.download ? staleOf(subscription) : Effect.void).pipe(
              Effect.catchTag("Failed", (failure) =>
                Effect.logWarning("[guide] refresh failed", failure.error),
              ),
              Effect.catchDefect((defect) => Effect.logWarning("[guide] refresh failed", defect)),
            ),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.delay(CHECK_EVERY), Effect.forever),
    );

    /** A subscription's channels with its mappings, or null without a catalogue. */
    const channelsOf = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const base = yield* catalogue
          .channels(id)
          .pipe(Effect.catchTag("Failed", () => Effect.succeed(null)));
        if (!base) return null;
        const { mappings } = yield* settingsOf(subscription);
        const overlay = overlays.get(id);
        if (overlay?.base === base && overlay.mappings === mappings) return overlay.channels;
        const channels = mappedChannels(base, mappings);
        overlays.set(id, { base, mappings, channels });
        return channels;
      });

    /**
     * The guides each subscription names, the sources' and, where its address couldn't move
     * this run, that one's: the same object while they are.
     */
    const namedSets = new Map<
      string,
      { base: ReadonlyMap<string, string>; origin: string; named: ReadonlyMap<string, string> }
    >();
    const namedFor = (id: string, legacyOrigin: string | null) => {
      if (legacyOrigin === null) return sourceOrigins;
      const before = namedSets.get(id);
      if (before?.base === sourceOrigins && before.origin === legacyOrigin) return before.named;
      const named = new Map([...sourceOrigins, [LEGACY, legacyOrigin]]);
      namedSets.set(id, { base: sourceOrigins, origin: legacyOrigin, named });
      return named;
    };

    /** Each subscription's guides, the same object while its parts and the sources are. */
    const guideSets = new Map<string, Guides>();
    const guidesFor = (id: string, parts: readonly GuidePart[], legacyOrigin: string | null) => {
      const named = namedFor(id, legacyOrigin);
      const before = guideSets.get(id);
      const still =
        before?.sources === named &&
        before.parts.length === parts.length &&
        before.parts.every(
          (part, at) => part.index === parts[at]?.index && part.source === parts[at]?.source,
        );
      if (before && still) return before;
      const guides = guidesOf(parts, named);
      guideSets.set(id, guides);
      return guides;
    };

    /**
     * Runs `read` on a subscription's guides, its own and the sources' loaded, with its
     * catalogue's channels and the time, reading their indexes under claims of its own taken
     * before anything else is waited for and let go of once `read` is done: a guide that takes
     * one's place meanwhile leaves this one open until then. Null without a guide or a catalogue.
     */
    const withContext = <A, E>(
      subscription: GuideSubscription,
      read: (found: Found) => Effect.Effect<A, E>,
    ): Effect.Effect<A | null, E> =>
      Effect.gen(function* () {
        if (checkedAt === null) {
          checkedAt = yield* Clock.currentTimeMillis;
          asked.resolve();
        }
        // The guides current when the claims are taken: one replaced just before has closed.
        let held: { readonly parts: GuidePart[]; readonly readers: Reader[] } | null = null;
        for (let tries = 0; tries < 3 && !held; tries++) {
          const own = yield* current(subscription);
          const list = yield* currentSources;
          const { legacy } = yield* settingsOf(subscription);
          const waiting = legacy?.source === null ? pending.get(subscription.id) : undefined;
          const wanted = [
            ...(own
              ? [{ owner: subscription.store, source: OWN_GUIDE, origin: null, guide: own }]
              : []),
            ...(legacy && waiting
              ? [
                  {
                    owner: subscription.store,
                    source: LEGACY,
                    origin: legacy.origin,
                    guide: waiting,
                  },
                ]
              : []),
            ...list.flatMap((each) => {
              const guide = openOf(each);
              return guide
                ? [{ owner: sourcesOwner.store, source: each.id, origin: each.origin, guide }]
                : [];
            }),
          ];
          const readers: Reader[] = [];
          for (const { owner, guide } of wanted) {
            const reader = files.share(owner, guide.file);
            if (!reader) break;
            readers.push(reader);
          }
          if (readers.length < wanted.length) {
            for (const reader of readers) reader.release();
            continue;
          }
          held = {
            readers,
            parts: wanted.map(({ owner, source, origin, guide }) => ({
              source,
              origin,
              index: guide.index,
              path: store.path({ store: owner }, guide.file),
            })),
          };
        }
        if (!held) return null;
        const { parts, readers } = held;
        return yield* Effect.gen(function* () {
          if (parts.length === 0) return null;
          const channels = yield* channelsOf(subscription);
          if (!channels) return null;
          const { legacy } = yield* settingsOf(subscription);
          return yield* read({
            guides: guidesFor(
              subscription.id,
              parts,
              legacy?.source === null ? legacy.origin : null,
            ),
            channels,
            at: yield* Clock.currentTimeMillis,
          });
        }).pipe(Effect.ensuring(Effect.sync(() => readers.forEach((reader) => reader.release()))));
      });

    /**
     * Operational search failures stay failures, rather than claiming a successful empty result.
     * Removal returns the empty fallback; interruption waits for the worker before releasing files.
     */
    const searching = <A>(
      subscriptionId: string,
      search: (signal: AbortSignal) => Promise<A>,
      fallback: A,
    ) =>
      Effect.suspend(() => {
        const stop = new AbortController();
        const under = searches.get(subscriptionId) ?? new Set<AbortController>();
        searches.set(subscriptionId, under.add(stop));
        const answer = search(stop.signal)
          .catch((cause: unknown) => {
            if (stop.signal.aborted) return fallback;
            throw cause;
          })
          .finally(() => under.delete(stop));
        return Effect.tryPromise({ try: () => answer, catch: failedWith }).pipe(
          Effect.onInterrupt(() =>
            Effect.promise(() => {
              stop.abort();
              return answer.catch(() => {});
            }),
          ),
        );
      });
    /** Each subscription's searches under way, which `forget` stops. */
    const searches = new Map<string, Set<AbortController>>();

    /**
     * What `lookup` answers per channel id, in each subscription's own guides, for those of
     * `channels` whose subscription is saved, by each channel's `ownedKey`. Keeps successful
     * reads when another subscription fails; fails only when none of the relevant reads succeed.
     */
    const perChannel = <A, E = never>(
      channels: readonly OwnedId[],
      lookup: (
        found: Found,
        subscriptionId: string,
        ids: readonly string[],
      ) => Effect.Effect<Record<string, A>, E>,
    ) =>
      Effect.gen(function* () {
        // A list may hold tens of thousands of channels: other work gets its turn between slices.
        const slice = slicer();
        const rest = (wait: Promise<void> | undefined) =>
          wait ? Effect.promise(() => wait) : Effect.void;
        const asked = new Map<string, string[]>();
        for (const { subscriptionId, id } of channels) {
          const ids = asked.get(subscriptionId);
          if (ids) ids.push(id);
          else asked.set(subscriptionId, [id]);
          yield* rest(slice());
        }
        const answers: Record<string, A> = {};
        let failure: E | undefined;
        let succeeded = false;
        for (const subscription of yield* source.saved) {
          const ids = asked.get(subscription.id);
          if (!ids) continue;
          const result = yield* Effect.result(
            withContext(subscription, (context) => lookup(context, subscription.id, ids)),
          );
          if (result._tag === "Failure") {
            failure ??= result.failure;
            continue;
          }
          const found = result.success;
          if (found === null) continue;
          succeeded = true;
          for (const id in found) {
            const answer = found[id];
            if (answer !== undefined)
              answers[ownedKey({ subscriptionId: subscription.id, id })] = answer;
            yield* rest(slice());
          }
        }
        if (!succeeded && failure !== undefined) return yield* Effect.fail(failure);
        return answers;
      });

    /** What a guide's Settings row shows of its work, and how the latest ended. */
    const processingOf = (
      key: string,
      guide: Loaded | null,
      channels: number,
      failure: GuideFailureNote | null,
    ): GuideProcessing =>
      progress.get(key) ??
      (failure
        ? {
            state: "failed",
            reason: failure.error,
            since: failure.at,
            kept: guide?.fetchedAt ?? null,
          }
        : guide
          ? {
              state: "ready",
              channels,
              programmes: guide.index.programmes,
              until: guide.index.until,
              fetchedAt: guide.fetchedAt,
            }
          : { state: "empty" });

    /** How many channels its guides cover in a subscription, and from which; null without any. */
    const coverageOf = (subscription: GuideSubscription) =>
      withContext(subscription, (context) =>
        Effect.map(
          Effect.promise(() => coverage(context.guides, context.channels, context.at)),
          (covered) => ({ ...context, covered }),
        ),
      );

    const statusOf = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const { mappings, legacy } = yield* settingsOf(subscription);
        const guide = yield* current(subscription);
        const found = yield* coverageOf(subscription);
        const channels = found?.channels ?? (yield* channelsOf(subscription));
        const bySource = found?.covered.bySource;
        return {
          subscriptionId: id,
          channels: found?.covered.covered ?? 0,
          supplied: (found?.guides.parts ?? []).flatMap(({ source: each, origin }) => {
            const count = bySource?.get(each) ?? 0;
            if (count === 0) return [];
            return [
              {
                source:
                  each === OWN_GUIDE
                    ? null
                    : {
                        id: each,
                        origin: origin ?? "",
                        label: (sourceList ?? []).find((one) => one.id === each)?.label ?? null,
                      },
                channels: count,
              },
            ];
          }),
          listed: channels?.all.length ?? 0,
          guideChannels: guide?.index.channels.size ?? 0,
          fetchedAt: guide?.fetchedAt ?? null,
          availability: absent.has(id) ? "none" : guide ? "available" : "unknown",
          mapped: Object.keys(mappings).length,
          unresolved: channels
            ? unresolvedMappings(
                found?.guides ??
                  guidesOf([], namedFor(id, legacy?.source === null ? legacy.origin : null)),
                channels,
              )
            : 0,
          processing: processingOf(
            id,
            guide,
            bySource?.get(OWN_GUIDE) ?? 0,
            failures.get(id) ?? null,
          ),
        } satisfies GuideStatus;
      });

    /** The channels each source supplies, summed over every subscription, by the source's id. */
    const matched = Effect.gen(function* () {
      const total = new Map<string, number>();
      for (const subscription of yield* source.saved) {
        const found = yield* coverageOf(subscription);
        for (const [each, count] of found?.covered.bySource ?? []) {
          total.set(each, (total.get(each) ?? 0) + count);
        }
      }
      return total;
    });

    /** Settles at the first lookup of the guides: the checks of the time wait for it. */
    const asked = Promise.withResolvers<void>();
    /** When the guides were last checked against the time: the first lookup, then each check. */
    let checkedAt: number | null = null;

    /**
     * When the guide that supplies a channel of any subscription can next change with time
     * alone, as the guides stand at `at`: the first end after it of the last programme of a guide
     * channel that supplies one. Null while none does.
     */
    const nextSupplierChange = (at: number) =>
      Effect.gen(function* () {
        // One budget for the whole scan, however many subscriptions it reads, and the event
        // loop between them: a slice ends with the work it holds.
        const slice = slicer();
        let next: number | null = null;
        for (const subscription of yield* source.saved) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
          const changes = yield* withContext(subscription, ({ guides, channels }) =>
            Effect.promise(() => nextChangeOf(subscription.id, guides, channels, at, slice)),
          );
          if (changes != null && changes > at && (next === null || changes < next)) next = changes;
        }
        return next;
      });

    /**
     * Each subscription's next supplier change, with the guides and channels it was worked out
     * from and when: it stands while they are the same and it hasn't come, as no guide hands a
     * channel on before then.
     */
    const nextChanges = new Map<
      string,
      { guides: Guides; channels: MappedChannels; at: number; next: number | null }
    >();
    const nextChangeOf = async (
      id: string,
      guides: Guides,
      channels: MappedChannels,
      at: number,
      slice: Slice,
    ) => {
      const kept = nextChanges.get(id);
      if (
        kept?.guides === guides &&
        kept.channels === channels &&
        kept.at <= at &&
        (kept.next === null || kept.next > at)
      ) {
        return kept.next;
      }
      const { changes } = await coverage(guides, channels, at, slice);
      nextChanges.set(id, { guides, channels, at, next: changes });
      return changes;
    };

    const checking = Semaphore.makeUnsafe(1);
    /**
     * Whether the guide that supplies a channel changed since the last check, with time alone:
     * a guide's last programme on it ended, or the clock went back, or forward by more than
     * `CLOCK_JUMP_MS` at once, as after a sleep or a new time set. The guides are read as they
     * stood at the last check, so an end that passed while they were read counts too. The window
     * is told once, and reads its grids and details again.
     */
    const checkTime = checking.withPermits(1)(
      Effect.gen(function* () {
        if (checkedAt === null) return;
        const since = checkedAt;
        const next = yield* nextSupplierChange(since);
        const now = yield* Clock.currentTimeMillis;
        checkedAt = now;
        const jumped = now < since || now - since > CLOCK_JUMP_MS;
        if (jumped || (next !== null && next <= now)) yield* published;
      }),
    );

    // From the first lookup on, each minute.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Effect.promise(() => asked.promise);
        for (;;) {
          yield* checkTime.pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("[guide] checking the time failed", defect),
            ),
          );
          yield* Effect.sleep(CHECK_TIME_EVERY_MS);
        }
      }),
    );

    const sourceStatusOf = (each: Source, channels: number): GuideSourceStatus => ({
      id: each.id,
      origin: each.origin,
      label: each.label,
      locked: each.address === null,
      processing: processingOf(sourceKey(each.id), openOf(each) ?? null, channels, each.failure),
    });

    /** A source's status now, by its id, or `changed` once it was removed. */
    const sourceStatus = (id: string) =>
      Effect.gen(function* () {
        const each = (yield* currentSources).find((one) => one.id === id);
        if (!each) return yield* changed;
        return sourceStatusOf(each, (yield* matched).get(id) ?? 0);
      });

    /**
     * What subscription `id`'s guide `source` reads, set as `now`: its own guide, a source's
     * downloads, or those of an address that couldn't move this run.
     */
    const guidesOfSource = (id: string, now: Settings, source: string): readonly Loaded[] => {
      const found =
        source === OWN_GUIDE
          ? [loaded.get(id)]
          : source === LEGACY
            ? [now.legacy?.source === null ? pending.get(id) : undefined]
            : [openOf((sourceList ?? []).find((each) => each.id === source))];
      return found.filter((each) => each !== undefined);
    };

    /** The source `id` names, or `changed` once it was removed. */
    const sourceOr = (id: string) =>
      Effect.flatMap(currentSources, (list) => {
        const each = list.find((one) => one.id === id);
        return each ? Effect.succeed(each) : Effect.fail(changed);
      });

    return {
      listings: (channels: readonly OwnedId[]) =>
        perChannel(channels, (found, _subscriptionId, ids) =>
          Effect.sync(() => listingsAt(found.guides, found.channels, ids, found.at)),
        ),
      schedule: (channel: OwnedId, from: number, until: number) =>
        Effect.gen(function* () {
          const subscription = yield* savedAs(channel.subscriptionId);
          const found =
            subscription &&
            (yield* withContext(subscription, (context) =>
              Effect.sync(() =>
                scheduleAt(context.guides, context.channels, channel.id, context.at, from, until),
              ),
            ));
          return found ?? [];
        }),
      range: (channels: readonly OwnedId[], from: number, to: number) =>
        perChannel(channels, (found, _subscriptionId, ids) =>
          Effect.promise(() => rangeAt(found.guides, found.channels, ids, found.at, from, to)),
        ),
      programme: (channel: OwnedId, ref: string, start: number) =>
        Effect.gen(function* () {
          const subscription = yield* savedAs(channel.subscriptionId);
          const found =
            subscription &&
            (yield* withContext(subscription, (context) =>
              Effect.sync(() =>
                programmeAt(context.guides, context.channels, channel.id, ref, start, context.at),
              ),
            ));
          return found ?? null;
        }),
      search: (query: string) =>
        Effect.gen(function* () {
          const matches: ProgrammeMatch[] = [];
          let at = 0;
          let failure: Failed | undefined;
          let succeeded = false;
          for (const subscription of yield* source.saved) {
            // Each subscription's own first fifty hold every one of the first fifty of them all.
            const result = yield* Effect.result(
              withContext(subscription, (context) =>
                Effect.map(
                  searching(
                    subscription.id,
                    (signal) =>
                      searchAt(
                        context.guides,
                        context.channels,
                        query,
                        context.at,
                        searcher,
                        signal,
                      ),
                    [],
                  ),
                  (programmes) => ({ at: context.at, programmes }),
                ),
              ),
            );
            if (result._tag === "Failure") {
              failure ??= result.failure;
              continue;
            }
            const found = result.success;
            if (!found) continue;
            succeeded = true;
            at = found.at;
            matches.push(...found.programmes);
          }
          if (!succeeded && failure !== undefined) return yield* failure;
          const onNow = (match: ProgrammeMatch) => (match.programme.start <= at ? 0 : 1);
          return matches
            .sort((a, b) => onNow(a) - onNow(b) || a.programme.start - b.programme.start)
            .slice(0, SEARCH_LIMIT);
        }),
      searchChannels: (query: string, channels: readonly OwnedId[], until: number) =>
        perChannel(channels, (found, subscriptionId, ids) =>
          searching(
            subscriptionId,
            (signal) =>
              searchChannelsAt(
                found.guides,
                found.channels,
                ids,
                query,
                found.at,
                until,
                searcher,
                signal,
              ),
            {},
          ),
        ),
      status: Effect.flatMap(source.saved, (saved) => Effect.forEach(saved, statusOf)),
      refresh: (subscriptionId: string) => Effect.flatMap(savedOr(subscriptionId), refreshOf),
      refreshIfStale: (subscriptionId: string) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          const started = generationOf(subscription.id);
          // The sources' downloads run on their own, shared by every subscription.
          yield* staleSources.pipe(
            Effect.catchDefect((defect) => Effect.logWarning("[guide] refresh failed", defect)),
          );
          yield* staleOf(subscription, started);
        }),

      sources: Effect.gen(function* () {
        const list = yield* currentSources;
        const counts = yield* matched;
        return list.map((each) => sourceStatusOf(each, counts.get(each.id) ?? 0));
      }),

      addSource: (typed: string, named?: string | null) =>
        Effect.gen(function* () {
          const address = guideAddress(typed);
          if (!address) return yield* failed({ kind: "address" });
          const label = yield* labelOf(named);
          const known = (yield* currentSources).find((each) => each.identity === address.identity);
          // The same address again is the same source. Typed again where the keychain no longer
          // opens it, it is sealed anew and downloads again.
          if (known && known.address === null) {
            const sealedAddress = yield* addresses.seal(address.href);
            const before = yield* changeSources((now) =>
              Effect.succeed(
                updated(now, known.id, (was) =>
                  was.address === null ? { ...was, sealedAddress, address: address.href } : null,
                ),
              ),
            );
            const unlocked = (sourceList ?? []).find((each) => each.id === known.id);
            if (before && unlocked) {
              yield* startJob(sourceKey(unlocked.id), "download", unlocked.identity, (report) =>
                downloadSource(unlocked, report),
              );
              yield* published;
            }
          }
          if (known) return yield* sourceStatus(known.id);
          const added: Source = {
            id: randomUUID(),
            origin: address.origin,
            identity: address.identity,
            sealedAddress: yield* addresses.seal(address.href),
            label,
            document: null,
            failure: null,
            movedFrom: null,
            address: address.href,
          };
          const before = yield* changeSources((now) =>
            Effect.succeed(
              now.some((each) => each.identity === added.identity) ? null : [...now, added],
            ),
          );
          if (before) {
            yield* startJob(sourceKey(added.id), "download", added.identity, (report) =>
              downloadSource(added, report),
            );
            yield* published;
            return sourceStatusOf(added, 0);
          }
          // The same address was added meanwhile.
          const same = (sourceList ?? []).find((each) => each.identity === added.identity);
          return yield* same ? sourceStatus(same.id) : changed;
        }),

      removeSource: (id: string) =>
        Effect.gen(function* () {
          const before = yield* changeSources((now) =>
            Effect.succeed(
              now.some((each) => each.id === id) ? now.filter((each) => each.id !== id) : null,
            ),
          );
          if (!before) return yield* changed;
          yield* stopJob(sourceKey(id));
          // An address a release before set that moved to it goes with it.
          yield* Effect.forkIn(retireMovedTo(id, true), scope);
          yield* published;
        }),

      moveSource: (id: string, by: -1 | 1) =>
        Effect.gen(function* () {
          const before = yield* changeSources((now) =>
            Effect.gen(function* () {
              const from = now.findIndex((each) => each.id === id);
              if (from < 0) return yield* changed;
              const to = from + by;
              if (to < 0 || to >= now.length) return null;
              const then = [...now];
              const [moved] = then.splice(from, 1);
              if (moved) then.splice(to, 0, moved);
              return then;
            }),
          );
          if (before) yield* published;
        }),

      refreshSource: (id: string) =>
        Effect.gen(function* () {
          yield* refreshSourceOf(yield* sourceOr(id)).pipe(
            // How it ended shows in the status: a failure keeps the source and its last guide.
            Effect.catchTag("Failed", (failure) =>
              failure.error.kind === "guide" && failure.error.failure.kind === "changed"
                ? Effect.fail(failure)
                : Effect.void,
            ),
          );
          return yield* sourceStatus(id);
        }),

      renameSource: (id: string, typed: string | null) =>
        Effect.gen(function* () {
          const label = yield* labelOf(typed);
          const before = yield* changeSources((now) =>
            Effect.gen(function* () {
              if (!now.some((each) => each.id === id)) return yield* changed;
              return updated(now, id, (was) => (was.label === label ? null : { ...was, label }));
            }),
          );
          if (before) yield* published;
          return yield* sourceStatus(id);
        }),

      map: (subscriptionId: string, channelId: string, ref: string | null, revision: string) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          const { id } = subscription;
          const started = generationOf(id);
          const named = ref === null ? null : parseGuideRef(ref);
          if (revision !== revisionOf(subscription) || (ref !== null && !named)) {
            return yield* changed;
          }
          // Loads the guides where this run hasn't yet: the change reads them from memory.
          yield* keptGuide(subscription);
          yield* currentSources;
          const before = yield* change(subscription, started, (was) =>
            Effect.gen(function* () {
              // The channels and the guides as they are now, in the change's turn: a channel
              // list or a download that arrived while it waited may list neither any more.
              const channels = yield* catalogue
                .channels(id)
                .pipe(Effect.catchTag("Failed", () => Effect.succeed(null)));
              if (!channels) return yield* changed;
              const channel = channels.channel(channelId);
              if (named) {
                if (!channel) {
                  return yield* new Failed({ error: { kind: "channel-not-found", channelId } });
                }
                // Only a channel a guide of the subscription lists, by its exact id.
                const lists = guidesOfSource(id, was, named.source).some((guide) =>
                  guide.index.channels.has(named.guideId),
                );
                if (!lists) {
                  return yield* changed;
                }
              }
              /** Whether a mapping is this channel's, under whichever of its streams' ids it was made. */
              const names = (key: string) =>
                key === channelId ||
                (channel !== undefined && channels.channel(key)?.id === channel.id);
              const others = Object.fromEntries(
                Object.entries(was.mappings).filter(([key]) => !names(key)),
              );
              const mappings =
                !named || !channel
                  ? others
                  : {
                      ...others,
                      [channel.id]: {
                        source: named.source,
                        guideId: named.guideId,
                        name: channel.title,
                      },
                    };
              return { ...was, mappings };
            }),
          );
          if (!before) return yield* changed;
          yield* published;
          return yield* withContext(subscription, ({ guides, channels, at }) =>
            Effect.sync(() => {
              const listed = channels.channel(channelId);
              return listed ? mapChannel(guides, channels, listed, at) : null;
            }),
          );
        }),

      mapChannels: ({
        subscriptionId,
        offset,
        limit,
        ...list
      }: {
        readonly subscriptionId: string;
        readonly filter: MapFilter;
        readonly query: string;
        readonly offset: number;
        readonly limit: number;
      }) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          // Named before the page is read: one read while the subscription's guide goes names
          // the guides before, whichever it read, so a choice made from it is refused.
          const revision = revisionOf(subscription);
          const page = yield* withContext(subscription, ({ guides, channels, at }) =>
            Effect.sync(() => mapChannelsAt(guides, channels, list, offset, limit, at)),
          );
          return { ...(page ?? { total: 0, channels: [] }), revision };
        }),

      mapOptions: ({
        subscriptionId,
        query,
        offset,
        limit,
      }: {
        readonly subscriptionId: string;
        readonly query: string;
        readonly offset: number;
        readonly limit: number;
      }) =>
        Effect.gen(function* () {
          const page = yield* withContext(yield* savedOr(subscriptionId), ({ guides, at }) =>
            Effect.sync(() => guideChannelsAt(guides, query, offset, limit, at)),
          );
          return page ?? { total: 0, listed: 0, channels: [] };
        }),

      forget: (subscription: Pick<GuideSubscription, "id" | "store">) =>
        Effect.gen(function* () {
          const { id } = subscription;
          // In its turn: whatever change still had one is done, and none after it applies.
          yield* turn(
            id,
            Effect.sync(() => {
              turned(id);
              forgotten.add(id);
              overlays.delete(id);
              settings.delete(id);
              guideSets.delete(id);
              keep(subscription, null);
              kept.delete(id);
            }),
          );
          yield* stopJob(id);
          yield* stopJob(legacyKey(id));
          setPending(id, null);
          nextChanges.delete(id);
          // Its searches stop, their worker with them.
          for (const search of searches.get(id) ?? []) search.abort();
          // Once no file of it is held or going, nothing of it is left to write or read.
          yield* Effect.promise(() => files.settled(subscription.store));
          yield* turn(
            id,
            Effect.andThen(
              store.erase(subscription),
              Effect.sync(() => forgotten.delete(id)),
            ),
          );
        }),
      changes: Stream.fromPubSub(updates),
      checkTime: checkTime.pipe(
        Effect.catchDefect((defect) =>
          Effect.logWarning("[guide] checking the time failed", defect),
        ),
      ),
    };
  });
}

function needsSecret(subscription: GuideSubscription): Failed {
  return new Failed({ error: { kind: "needs-secret", subscriptionId: subscription.id } });
}
