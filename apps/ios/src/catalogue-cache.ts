import { lazy } from "@mrstreamer/contracts/lazy";
import type {
  LiveCatalogue,
  OnDemandCatalogue,
  ProviderCategory,
  ProviderChannel,
  ProviderTitle,
} from "@mrstreamer/core/provider";
import { pacer, type Steps } from "@mrstreamer/core/steps";
import { type, type ArkErrors } from "arktype";
import { Directory, File, Paths } from "expo-file-system";
import { inTasks } from "./library.ts";

// Each subscription's last channel list and movie and series lists, as its provider gave them,
// kept in Caches/catalogues so a launch can show them before, or instead of, asking again.
// account.ts alone calls this module and decides when a copy shows, when one is saved and when
// one goes; this module only keeps the files. Caches is left out of backups, and iOS may empty
// it: a copy that is missing, unreadable or doubtful is simply not there, and the lists load as
// they would without one. Reading, saving and tidying never throw: a failure is a missing copy.
// Deleting a subscription's copies, which a new password waits on, answers whether they are gone,
// as a copy left behind would show again at the next launch. Nothing is logged.
//
// What is written is a copy of the fields the app reads, nothing else. An artwork address that
// could carry the login is written as none, while this session's lists keep it; a list with the
// password in any other text the provider sent isn't written at all. A read checks every row
// before anything shows.
// Each subscription's lists are read, written and deleted one operation at a time, per list, so a
// deletion waits for a write under way and a write never recreates what was deleted after it.
// A read checks the rows, and a write copies them, a few slices per task (library.ts `inTasks`),
// so taps go through meanwhile; one whose login is replaced or removed in between stops there,
// shows and writes nothing, and leaves the file to the deletion that follows it in the queue.
// A write goes to a file beside the copy, then takes its place; on iOS that move deletes the copy
// first, so an app stopped in between leaves only the new file, which a read takes once it checks.

/** One subscription's list, with when its provider gave it, epoch milliseconds. */
export type Saved =
  | { readonly kind: "live"; readonly catalogue: LiveCatalogue; readonly fetchedAt: number }
  | { readonly kind: "titles"; readonly catalogue: OnDemandCatalogue; readonly fetchedAt: number };
type SavedKind = Saved["kind"];

const VERSION = 1;
/** A file larger than this isn't read or kept. */
const FILE_BYTES = 64 * 1024 * 1024;
/** Rows a list may have: categories, channels, movies or series. */
const ROWS = 250_000;
/** What every file together may take; the oldest go first past it. */
const TOTAL_BYTES = 256 * 1024 * 1024;
/** A copy older than this, or from further ahead than the clock may drift, isn't shown. */
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_AHEAD = 10 * 60 * 1000;
/** The longest artwork address kept. */
const URL_LENGTH = 2048;

const folder = () => new Directory(Paths.cache, "catalogues");
/** A file name per id: letters, digits and "-" as they are, every other UTF-16 unit as "_" and hex. */
const nameOf = (id: string, kind: SavedKind) =>
  `${id.replace(/[^A-Za-z0-9-]/g, (unit) => `_${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)}.${kind}.json`;
const fileOf = (id: string, kind: SavedKind) => new File(folder(), nameOf(id, kind));
const pendingOf = (id: string, kind: SavedKind) => new File(folder(), `${nameOf(id, kind)}.next`);

const Url = lazy(() => type(`string <= ${URL_LENGTH}`).or("null"));
/**
 * A row's number, or none. JSON reads `1e400` as Infinity, which ArkType's "number" lets through,
 * while a copy this module writes never holds one (JSON writes it as null): a file that does was
 * changed since, and doesn't check out.
 */
const Finite = lazy(() =>
  type("number")
    .narrow((value, ctx) => Number.isFinite(value) || ctx.mustBe("a finite number"))
    .or("null"),
);
const Category = lazy(() => type({ "+": "reject", id: "string", name: "string" }));
const Channel = lazy(() =>
  type({
    "+": "reject",
    id: "string",
    name: "string",
    number: Finite(),
    logoUrl: Url(),
    categoryIds: "string[]",
    guideId: "string | null",
    "adult?": "boolean",
    catchupDays: Finite(),
  }),
);
const Title = lazy(() =>
  type({
    "+": "reject",
    id: "string",
    name: "string",
    posterUrl: Url(),
    backdropUrl: Url(),
    rating: Finite(),
    addedAt: Finite(),
    releaseDate: "string | null",
    categoryIds: "string[]",
    adult: "boolean",
    container: "string | null",
    "tmdbId?": "string | null",
    "metadata?": "'lazy'",
    "episodeFiles?": "string[]",
  }),
);
const Head = {
  "+": "reject",
  version: `${VERSION}`,
  subscriptionId: "string",
  fetchedAt: "number",
} as const;
/** A list as the envelope checks it: an array within the row bound. `rows` checks each row. */
const List = lazy(() => type("unknown[]").atMostLength(ROWS));
/** Each file's envelope and its lists; the rows are checked a slice at a time, each by its own schema. */
const Envelopes = lazy(() => ({
  live: type({
    ...Head,
    kind: "'live'",
    catalogue: type({ "+": "reject", categories: List(), channels: List() }),
  }),
  titles: type({
    ...Head,
    kind: "'titles'",
    catalogue: type({
      "+": "reject",
      movieCategories: List(),
      movies: List(),
      seriesCategories: List(),
      series: List(),
    }),
  }),
}));

/** Each of `list` as `row` checks it, a slice at a time; null at the first that doesn't check. */
function* rows<R>(
  list: readonly unknown[],
  row: (data: unknown) => R | ArkErrors,
): Steps<R[] | null> {
  const due = pacer();
  const checked: R[] = [];
  for (const each of list) {
    if (due()) yield;
    const result = row(each);
    if (result instanceof type.errors) return null;
    checked.push(result);
  }
  return checked;
}

/**
 * `json` as `id`'s saved `kind`, or "invalid": its envelope, its age, then every row of every list.
 * Nothing of it is answered until all have checked.
 */
function* checked(json: unknown, id: string, kind: SavedKind): Steps<Saved | "invalid"> {
  const fresh = (fetchedAt: number) => {
    const age = Date.now() - fetchedAt;
    return age <= MAX_AGE && age >= -MAX_AHEAD;
  };
  if (kind === "live") {
    const head = Envelopes().live(json);
    if (head instanceof type.errors || head.subscriptionId !== id || !fresh(head.fetchedAt)) {
      return "invalid";
    }
    const categories = yield* rows(head.catalogue.categories, Category());
    if (!categories) return "invalid";
    const channels = yield* rows(head.catalogue.channels, Channel());
    if (!channels) return "invalid";
    return { kind, catalogue: { categories, channels }, fetchedAt: head.fetchedAt };
  }
  const head = Envelopes().titles(json);
  if (head instanceof type.errors || head.subscriptionId !== id || !fresh(head.fetchedAt)) {
    return "invalid";
  }
  const movieCategories = yield* rows(head.catalogue.movieCategories, Category());
  if (!movieCategories) return "invalid";
  const movies = yield* rows(head.catalogue.movies, Title());
  if (!movies) return "invalid";
  const seriesCategories = yield* rows(head.catalogue.seriesCategories, Category());
  if (!seriesCategories) return "invalid";
  const series = yield* rows(head.catalogue.series, Title());
  if (!series) return "invalid";
  const catalogue = { movieCategories, movies, seriesCategories, series };
  return { kind, catalogue, fetchedAt: head.fetchedAt };
}

/** The last operation on each list's files, settled or not, by file name. */
const queues = new Map<string, Promise<unknown>>();

/** Runs `operation` once the list's earlier ones have finished; answers `fallback` when it fails. */
function queued<A>(id: string, kind: SavedKind, fallback: A, operation: () => Promise<A>) {
  const name = nameOf(id, kind);
  const run = (queues.get(name) ?? Promise.resolve()).then(operation).catch(() => fallback);
  queues.set(name, run);
  return run;
}

/** Deletes the file if it is there, whatever stops it. */
function discard(file: File) {
  try {
    if (file.exists) file.delete();
  } catch {
    // Left for the next launch's tidying.
  }
}

/**
 * The file's list if it reads whole and checks out as `id`'s `kind`; "none" when there is none or
 * it doesn't, which deletes it. "stopped" when `wanted` failed while its rows were checked: the
 * file is left as it is, for the deletion queued behind.
 */
async function load(
  file: File,
  id: string,
  kind: SavedKind,
  wanted: () => boolean,
): Promise<Saved | "none" | "stopped"> {
  if (!file.exists) return "none";
  try {
    if (file.size > FILE_BYTES) throw new RangeError("Too large");
    // In this order: every schema, each built on its first use, before the text as it was when
    // the rows were checked at once; the text; one parse; then the envelope and the rows.
    for (const schema of [Envelopes, Category, Channel, Title]) schema();
    const json: unknown = JSON.parse(await file.text());
    const saved = await inTasks(checked(json, id, kind), wanted);
    if (saved === null) return "stopped";
    if (saved === "invalid") throw new TypeError();
    return saved;
  } catch {
    discard(file);
    return "none";
  }
}

/**
 * `id`'s saved `kind`, or null when there is none that checks out. A write left halfway takes the
 * copy's place while `stands` holds, as the app was stopped before it could; every other file of
 * the list that doesn't check out is deleted. Null too, leaving the files, once `stands` fails
 * while the rows are checked.
 */
export function readList(id: string, kind: SavedKind, stands: () => boolean) {
  return queued(id, kind, null, async () => {
    const pending = pendingOf(id, kind);
    const kept = await load(fileOf(id, kind), id, kind, stands);
    if (kept === "stopped") return null;
    if (kept !== "none") {
      discard(pending);
      return kept;
    }
    const left = await load(pending, id, kind, stands);
    if (left === "stopped") return null;
    if (left === "none" || !stands()) {
      discard(pending);
      return null;
    }
    await pending.move(fileOf(id, kind), { overwrite: true });
    if (stands()) return left;
    discard(fileOf(id, kind));
    return null;
  });
}

/**
 * Saves `saved` as `id`'s copy of its list, while `stands` holds: checked between the slices that
 * copy its rows, before the write, while it waits on the disk, and once the copy is in place,
 * which goes again when it no longer holds.
 * `login` is what signs the subscription in, kept out of the copy. Never rejects.
 */
export function writeList(
  id: string,
  saved: Saved,
  login: readonly string[],
  stands: () => boolean,
): Promise<void> {
  const { kind } = saved;
  return queued(id, kind, undefined, async () => {
    if (!stands()) return;
    // Stopped once `stands` fails, or not kept when the password is in the provider's text.
    const text = await inTasks(textOf(id, saved, login), stands);
    if (text === null || text === false) return;
    folder().create({ intermediates: true, idempotent: true });
    const pending = pendingOf(id, kind);
    try {
      pending.create({ overwrite: true });
      await pending.write(text);
      if (!stands() || pending.size > FILE_BYTES) return discard(pending);
      await pending.move(fileOf(id, kind), { overwrite: true });
    } catch {
      return discard(pendingOf(id, kind));
    }
    if (!stands()) return discard(fileOf(id, kind));
    shed(nameOf(id, kind), false);
  });
}

/**
 * Deletes `id`'s copies once whatever reads or writes them has finished. Answers whether none is
 * left of either list, the copy or a write left halfway: false when the disk refuses a deletion.
 * Never rejects.
 */
export async function dropLists(id: string): Promise<boolean> {
  const gone = await Promise.all(
    (["live", "titles"] as const).map((kind) =>
      queued(id, kind, false, async () => {
        const files = [fileOf(id, kind), pendingOf(id, kind)];
        for (const file of files) if (file.exists) file.delete();
        return files.every((file) => !file.exists);
      }),
    ),
  );
  return gone.every(Boolean);
}

/**
 * At launch, before any list is read: deletes every file but the copies of `ids`, the saved
 * subscriptions, and keeps them all within the folder's budget.
 */
export function pruneLists(ids: readonly string[]): void {
  try {
    const at = folder();
    if (!at.exists) return;
    const kept = new Set(
      ids.flatMap((id) =>
        (["live", "titles"] as const).flatMap((kind) => [
          nameOf(id, kind),
          `${nameOf(id, kind)}.next`,
        ]),
      ),
    );
    for (const entry of at.list()) {
      if (!kept.has(entry.name)) entry.delete();
    }
    shed(null, true);
  } catch {
    // Tried again at the next launch.
  }
}

/**
 * While the files take more than the budget, deletes copies, the movie and series lists before
 * the channel lists, each the least recently written first, but never `keep`. With `pending`,
 * which only launch passes before any list is read or written, writes left halfway go as copies
 * do; later, one may be a write under way, and stays.
 */
function shed(keep: string | null, pending: boolean) {
  const files = folder()
    .list()
    .filter((entry) => entry instanceof File);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= TOTAL_BYTES) return;
  const order = (file: File) => (file.name.includes(".titles.json") ? 0 : 1);
  const copies = files
    .filter(
      (file) =>
        (file.name.endsWith(".json") || (pending && file.name.endsWith(".json.next"))) &&
        file.name !== keep,
    )
    .toSorted(
      (a, b) => order(a) - order(b) || (a.modificationTime ?? 0) - (b.modificationTime ?? 0),
    );
  for (const file of copies) {
    if (total <= TOTAL_BYTES) return;
    total -= file.size;
    discard(file);
  }
}

/**
 * The file's text for `saved`, a slice of rows at a time: its rows with the fields the app reads,
 * artwork addresses that may carry the login as none. False when any other text of a row holds
 * the password, as nothing then says what else of the login a row carries; their numbers and
 * field names aren't text.
 */
function* textOf(id: string, saved: Saved, login: readonly string[]): Steps<string | false> {
  const [username = "", password = ""] = login;
  const art = (url: string | null) => safeUrl(url, username, password);
  let catalogue: LiveCatalogue | OnDemandCatalogue;
  if (saved.kind === "live") {
    const categories = yield* copies(saved.catalogue.categories, categoryCopy, password);
    if (!categories) return false;
    const channels = yield* copies(
      saved.catalogue.channels,
      (each) => channelCopy(each, art),
      password,
    );
    if (!channels) return false;
    catalogue = { categories, channels } satisfies LiveCatalogue;
  } else {
    const { movieCategories, movies, seriesCategories, series } = saved.catalogue;
    const titleOf = (each: ProviderTitle) => titleCopy(each, art);
    const movieCopies = yield* copies(movieCategories, categoryCopy, password);
    if (!movieCopies) return false;
    const movieRows = yield* copies(movies, titleOf, password);
    if (!movieRows) return false;
    const seriesCopies = yield* copies(seriesCategories, categoryCopy, password);
    if (!seriesCopies) return false;
    const seriesRows = yield* copies(series, titleOf, password);
    if (!seriesRows) return false;
    catalogue = {
      movieCategories: movieCopies,
      movies: movieRows,
      seriesCategories: seriesCopies,
      series: seriesRows,
    } satisfies OnDemandCatalogue;
  }
  return JSON.stringify({
    version: VERSION,
    subscriptionId: id,
    fetchedAt: saved.fetchedAt,
    kind: saved.kind,
    catalogue,
  });
}

/** `list` copied by `copy`, a slice at a time; false at the first copy whose text holds `password`. */
function* copies<A, B extends object>(
  list: readonly A[],
  copy: (each: A) => B,
  password: string,
): Steps<B[] | false> {
  const due = pacer();
  const copied: B[] = [];
  for (const each of list) {
    if (due()) yield;
    const row = copy(each);
    if (password !== "" && holds(row, password)) return false;
    copied.push(row);
  }
  return copied;
}

/** Whether a text within `value`, a copied row, holds `password`. Artwork kept has none. */
function holds(value: unknown, password: string): boolean {
  if (typeof value === "string") return value.includes(password);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some((each: unknown) => holds(each, password))
  );
}

type Art = (url: string | null) => string | null;

const categoryCopy = ({ id, name }: ProviderCategory) => ({ id, name }) satisfies ProviderCategory;

const channelCopy = (channel: ProviderChannel, art: Art) =>
  ({
    id: channel.id,
    name: channel.name,
    number: channel.number,
    logoUrl: art(channel.logoUrl),
    categoryIds: [...channel.categoryIds],
    guideId: channel.guideId,
    ...(channel.adult === undefined ? {} : { adult: channel.adult }),
    catchupDays: channel.catchupDays,
  }) satisfies ProviderChannel;

const titleCopy = (title: ProviderTitle, art: Art) =>
  ({
    id: title.id,
    name: title.name,
    posterUrl: art(title.posterUrl),
    backdropUrl: art(title.backdropUrl),
    rating: title.rating,
    addedAt: title.addedAt,
    releaseDate: title.releaseDate,
    categoryIds: [...title.categoryIds],
    adult: title.adult,
    container: title.container,
    ...(title.tmdbId === undefined ? {} : { tmdbId: title.tmdbId }),
    ...(title.metadata === undefined ? {} : { metadata: title.metadata }),
    ...(title.episodeFiles === undefined ? {} : { episodeFiles: [...title.episodeFiles] }),
  }) satisfies ProviderTitle;

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** How many layers of encoding, or addresses within addresses, are looked through. */
const LAYERS = 4;

type Login = { readonly username: string; readonly password: string };

/**
 * `url` when the disk may keep it: an http(s) address of at most 2048 characters that doesn't
 * give the login away (`exposes`). Otherwise null.
 */
function safeUrl(url: string | null, username: string, password: string): string | null {
  if (url === null || url.length > URL_LENGTH) return null;
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  return exposes(url, { username, password }, LAYERS, parsed) ? null : url;
}

/**
 * Whether `text`, an address or a part of one, gives the login away: it is the username, or
 * holds the password, as written or decoded as percent or form encoding ("+" a space) spells it,
 * and so on for `layers` more decodings; an address within it, such as an image proxy's, counts
 * with its own login, path parts, fragment, and query names and values. Text that won't decode,
 * or still decodes or holds an address after the last layer, counts as giving it away.
 */
function exposes(
  text: string,
  login: Login,
  layers: number,
  address = text.includes(":") ? URL.parse(text) : null,
): boolean {
  const { username, password } = login;
  if ((username !== "" && text === username) || (password !== "" && text.includes(password))) {
    return true;
  }
  const next = new Set([decoded(text), decoded(text.replaceAll("+", " "))]);
  next.delete(text);
  if (!address && next.size === 0) return false;
  if (layers === 0 || next.has(null)) return true;
  if (address && (address.username !== "" || address.password !== "")) return true;
  const parts = address
    ? [address.hash.slice(1), ...address.pathname.split("/"), ...[...address.searchParams].flat()]
    : [];
  return [...parts, ...next].some((part) => part !== null && exposes(part, login, layers - 1));
}
