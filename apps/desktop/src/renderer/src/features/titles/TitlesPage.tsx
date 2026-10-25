import { useSearchUsage } from "../../app/analytics.ts";
// Movies or Series: tabs under the title bar, like Hulu and Apple TV. For you leads with a
// featured title, what's being watched, titles like the last one and the collections that suit
// the viewer's language; New gathers what was added; Genres and Services are pages of tiles; 4K
// and All are grids. A row's All, a genre or a service opens its collection, with Back to the tab.
// Genres and services come from TMDB, so they fill in as its metadata arrives.
//   The field at the end of the tabs searches this kind only, by any of a title's names, and
// shows what it finds in place of the tab; Escape clears it. ⌘K searches everything for the same.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Play } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import {
  type CollectionId,
  type CollectionRow,
  type CollectionSort,
  type CollectionTile,
  type Title,
  type TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { collectionSort } from "@mrstreamer/core/ondemand/collections";
import type { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { formatDecimal, formatNumber, type PlainKey, t } from "@mrstreamer/core/i18n";
import { isMac, isTyping } from "../../app/platform.ts";
import { openDetails, openView, useUi } from "../../app/ui-store.ts";
import { Artwork, PosterTile, StillTile } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { SearchField } from "../../components/ui/search-field.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { queries, useSubscriptions, useSubscriptionPreferences } from "../../lib/queries.ts";
import { call } from "../../lib/ipc.ts";
import {
  movieNow,
  pickedVersion,
  playTitle,
  useContinueWatching,
  useRemoveFromContinue,
  useResume,
  type ContinueEntry,
} from "../../lib/titles.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
import { useFit } from "../../lib/use-fit.ts";
import { cn } from "../../lib/utils.ts";
import { CollectionGrid, TitleGrid, useCollection } from "./CollectionGrid.tsx";
import {
  FilterEmpty,
  TitleChoiceMenu,
  TitleFilterBar,
  type TitleFilterControls,
} from "./TitleFilters.tsx";

type Tab = "for-you" | "new" | "genres" | "services" | "4k" | "adult" | "all";

interface Place {
  readonly tab: Tab;
  /** A collection opened over the tab, with how the viewer sorted it; null in its own order. */
  readonly collection: CollectionId | null;
  readonly collectionSort: CollectionSort | null;
  /** How All is sorted. */
  readonly sort: CollectionSort;
  /** What the field in the tab bar searches for; empty shows the tab. */
  readonly query: string;
}

/** Where each kind was, kept while the viewer goes elsewhere and comes back. */
const usePlace = create<Record<TitleKind, Place>>(() => ({
  movie: { tab: "for-you", collection: null, collectionSort: null, sort: "added", query: "" },
  series: { tab: "for-you", collection: null, collectionSort: null, sort: "added", query: "" },
}));

/** Opens Movies or Series on one collection, with Back to the tab it was on: Home's All. */
export function openCollection(kind: TitleKind, collection: CollectionId): void {
  usePlace.setState((state) => ({
    [kind]: { ...state[kind], collection, collectionSort: null },
  }));
  openView(kind === "movie" ? "movies" : "series");
}

const POSTER_REM = 8.5;
const STILL_REM = 13;

export function TitlesPage({ kind, active }: { kind: TitleKind; active: boolean }) {
  const [filterState, setFilterState] = useState<{ kind: TitleKind; filters: TitleFilters }>({
    kind,
    filters: {},
  });
  if (filterState.kind !== kind) setFilterState({ kind, filters: {} });
  const filters = filterState.kind === kind ? filterState.filters : {};
  const onFilters = (next: TitleFilters) => setFilterState({ kind, filters: next });
  const client = useQueryClient();
  useEffect(() => {
    if (!active) return;
    // Returning from details/playback can add current episode hints or locally read tracks.
    // Read the cache again without downloading a catalogue or opening another file.
    void client.invalidateQueries({ queryKey: queries.titleFilterOptions(kind).queryKey });
    void client.invalidateQueries({
      queryKey: ["ondemand"],
      predicate: (query) =>
        query.queryKey[2] === kind &&
        ((query.queryKey[1] === "collection" && query.queryKey.length > 7) ||
          (query.queryKey[1] === "searchKind" && query.queryKey.length > 4)),
    });
  }, [active, kind, client]);
  const place = usePlace((state) => state[kind]);
  const go = (next: Partial<Place>) =>
    usePlace.setState((state) => ({ [kind]: { ...state[kind], ...next } }));
  const subscriptions = useSubscriptions();
  const playlistOnly =
    subscriptions.some((each) => each.playlistMapped) &&
    !subscriptions.some((each) => each.kind === "xtream");
  const status = useQuery(queries.onDemandStatus());
  const fourK = useQuery(queries.collection(kind, "4k", undefined, 0, 1));
  // Empty unless Settings shows titles for adults. Until it does again, Adults is gone as soon as
  // the setting is, whatever was read before.
  const adults = useQuery(queries.preferences()).data?.adultTitles ?? false;
  const adult = useQuery(queries.collection(kind, "adult", undefined, 0, 1));
  // 4K and Adults go when nothing is left in them, as after changing the language or the setting.
  const emptied =
    (place.tab === "4k" && fourK.data?.total === 0) ||
    (place.tab === "adult" && (!adults || adult.data?.total === 0));
  // Playlists have no added dates or eager metadata. Open their complete catalogue immediately.
  const tab =
    emptied || (playlistOnly && (place.tab === "for-you" || place.tab === "new"))
      ? playlistOnly
        ? "all"
        : "for-you"
      : place.tab;
  const tabs: readonly { value: Tab; label: string }[] = [
    ...(playlistOnly
      ? []
      : [
          { value: "for-you" as const, label: t("For you") },
          { value: "new" as const, label: t("New") },
        ]),
    { value: "genres", label: t("Genres") },
    { value: "services", label: t("Services") },
    ...(fourK.data?.total ? [{ value: "4k" as const, label: t("4K") }] : []),
    ...(adults && adult.data?.total ? [{ value: "adult" as const, label: t("Adults") }] : []),
    { value: "all", label: kind === "movie" ? t("All movies") : t("All series") },
  ];

  const searching = place.query.trim() !== "";
  const measuredQuery = useDebounced(place.query.trim(), 120);
  useSearchUsage(kind === "movie" ? "movies" : "series", searching ? measuredQuery : "", active);
  // Escape leaves an open collection, or the search, for the tab, one layer at a time.
  useEffect(() => {
    if (!active || (!place.collection && !searching)) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || isTyping(event)) return;
      const ui = useUi.getState();
      if (ui.searchOpen || ui.settings || ui.updateDialog || ui.details || ui.playingTitle) return;
      usePlace.setState((state) => ({
        [kind]: state[kind].collection
          ? { ...state[kind], collection: null }
          : { ...state[kind], query: "" },
      }));
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, place.collection, searching, kind]);

  // ⌘K and the search button search everything for what this page searches for.
  useEffect(() => {
    if (!active) return;
    useUi.setState({ searchFrom: place.query.trim() });
    return () => useUi.setState({ searchFrom: "" });
  }, [active, place.query]);

  const open = (collection: CollectionId) => go({ collection, collectionSort: null });
  // Lists show as soon as one subscription's are in; the others join them as they arrive.
  const lists = status.data?.lists ?? [];
  const loading = lists.length > 0 && lists.every((each) => each.fetchedAt === null);
  // No first fetch worked: nothing to show but why.
  const failed = loading ? lists.filter((each) => each.failure !== null) : [];
  const failure = failed[0]?.failure ?? null;
  return (
    <div className="flex h-full flex-col">
      <WindowBar
        className="bg-black"
        {...(place.collection ? { onBack: () => go({ collection: null }) } : {})}
      />
      {place.collection ? (
        <Collection
          kind={kind}
          id={place.collection}
          sort={place.collectionSort}
          onSort={(collectionSort) => go({ collectionSort })}
          active={active}
          filters={filters}
          onFilters={onFilters}
        />
      ) : (
        <>
          <nav className="flex flex-none items-center gap-6 px-10 pt-2 pb-4 text-[0.9375rem]">
            {tabs.map((each) => {
              const shown = !searching && each.value === tab;
              return (
                <button
                  key={each.value}
                  aria-pressed={shown}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => go({ tab: each.value, query: "" })}
                  className={cn(
                    "border-b-2 pb-1",
                    shown
                      ? "border-white font-semibold text-white"
                      : "border-transparent text-muted-foreground hover:text-white",
                  )}
                >
                  {each.label}
                </button>
              );
            })}
            <TitleSearch kind={kind} value={place.query} onChange={(query) => go({ query })} />
          </nav>
          {failure ? (
            <div className="px-10 text-[0.9375rem]">
              <p className="text-destructive">{describeError(failure)}</p>
              <Button
                variant="secondary"
                className="mt-4"
                onClick={() => {
                  for (const { subscriptionId } of failed) {
                    void call("ondemand.refresh", { subscriptionId }).catch(() => {});
                  }
                }}
              >
                {t("Try again")}
              </Button>
            </div>
          ) : loading ? (
            <p className="px-10 text-[0.9375rem] text-muted-foreground">
              {kind === "movie" ? t("Loading movies…") : t("Loading series…")}
            </p>
          ) : searching ? (
            <SearchResults
              kind={kind}
              query={place.query.trim()}
              active={active}
              filters={filters}
              onFilters={onFilters}
            />
          ) : tab === "for-you" || tab === "new" ? (
            <Rows kind={kind} tab={tab} onOpen={open} />
          ) : tab === "genres" || tab === "services" ? (
            <Tiles kind={kind} of={tab} onOpen={open} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col pl-10">
              <CollectionGrid
                kind={kind}
                id={tab}
                {...(tab === "all" ? { sort: place.sort } : {})}
                active={active}
                filters={filters}
                onFilters={onFilters}
                sortControl={
                  tab === "all" ? (
                    <SortMenu value={place.sort} onChange={(sort) => go({ sort })} />
                  ) : undefined
                }
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The field at the end of the tabs. Down or Enter hands the keys to the results, Escape clears
 * it and returns to the tab.
 */
function TitleSearch({
  kind,
  value,
  onChange,
}: {
  kind: TitleKind;
  value: string;
  onChange: (query: string) => void;
}) {
  return (
    <SearchField
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onChange("");
        else if (event.key !== "ArrowDown" && event.key !== "Enter") return;
        event.currentTarget.blur();
        event.preventDefault();
      }}
      placeholder={kind === "movie" ? t("Search movies") : t("Search series")}
      aria-label={kind === "movie" ? t("Search movies") : t("Search series")}
      className="ml-auto w-[17rem]"
    />
  );
}

/** What the field found, as posters, with how many and a way to search everything. */
function SearchResults({
  kind,
  query,
  active,
  filters,
  onFilters,
}: {
  kind: TitleKind;
  query: string;
  active: boolean;
} & TitleFilterControls) {
  const debounced = useDebounced(query, 120);
  const found = useQuery({
    ...queries.titleSearchIn(kind, debounced, filters),
  });
  const titles = found.data?.titles ?? [];
  const total = found.data?.total ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col pl-10">
      <TitleFilterBar
        kind={kind}
        filters={filters}
        onFilters={onFilters}
        total={found.data && !found.isPlaceholderData ? total : null}
        unfiltered={
          found.data && !found.isPlaceholderData ? (found.data.unfiltered ?? total) : null
        }
      />
      {found.error ? (
        <p className="text-sm text-destructive">{describeError(appError(found.error))}</p>
      ) : (
        found.data && (
          <p className="mb-4 text-[0.9375rem] font-medium tabular-nums">
            {total === 0
              ? kind === "series"
                ? t("No series found")
                : t("No movies found")
              : total > titles.length
                ? kind === "series"
                  ? t("The best {shown} of {count} series", { shown: titles.length, count: total })
                  : t("The best {shown} of {count} movies", { shown: titles.length, count: total })
                : kind === "series"
                  ? t("{count} series", { count: total })
                  : t("{count} movies", { count: total })}
          </p>
        )
      )}
      {total === 0 && found.data && Object.keys(filters).length > 0 ? (
        <FilterEmpty filters={filters} />
      ) : (
        <div
          inert={found.isPlaceholderData || debounced !== query ? true : undefined}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TitleGrid
            key={`${debounced}:${JSON.stringify(filters)}`}
            titles={titles}
            active={active && !found.isPlaceholderData && debounced === query}
            caption={searchCaption}
            asked={Object.keys(filters).length > 0}
          />
        </div>
      )}
      <p className="flex-none py-4 text-[0.8125rem] text-muted-foreground">
        {kind === "series"
          ? t("Channels, movies and programmes for “{query}”", { query })
          : t("Channels, series and programmes for “{query}”", { query })}{" "}
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => useUi.setState({ searchOpen: true })}
          className="ml-1 text-white underline-offset-4 hover:underline"
        >
          {t("Search everything")} {isMac ? "⌘K" : "Ctrl K"}
        </button>
      </p>
    </div>
  );
}

/** Under a found poster: the year, and the original name, which search finds it by too. */
function searchCaption(title: Title): string {
  return [
    title.year,
    title.originalTitle ? t("Original: {title}", { title: title.originalTitle }) : title.genres[0],
  ]
    .filter(Boolean)
    .join(" · ");
}

const SORTS: readonly { value: CollectionSort; label: PlainKey }[] = [
  { value: "added", label: "Newest" },
  { value: "popular", label: "Popular" },
  { value: "rating", label: "Top rated" },
  { value: "title", label: "A–Z" },
];

function SortMenu({
  value,
  onChange,
}: {
  value: CollectionSort | null;
  onChange: (sort: CollectionSort) => void;
}) {
  return (
    <TitleChoiceMenu
      label={t("Sort")}
      choices={SORTS.map((entry) => ({ ...entry, label: t(entry.label) }))}
      value={value ?? undefined}
      onChange={(sort) => {
        if (sort) onChange(sort);
      }}
      showLabel={false}
    />
  );
}

/** A collection opened from a row, a genre or a service: its name, its order, its grid. */
function Collection({
  kind,
  id,
  sort,
  onSort,
  active,
  filters,
  onFilters,
}: {
  kind: TitleKind;
  id: CollectionId;
  sort: CollectionSort | null;
  onSort: (sort: CollectionSort) => void;
  active: boolean;
} & TitleFilterControls) {
  const listed = useCollection(kind, id, sort ?? undefined, filters);
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-2 pl-10">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 pr-8">
        <h1 className="text-2xl font-semibold tracking-tight">{listed.name}</h1>
        <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
          {listed.total === null || listed.unfiltered === null
            ? null
            : t("{shown} of {total}", { shown: listed.total, total: listed.unfiltered })}
        </span>
      </div>
      <CollectionGrid
        kind={kind}
        id={id}
        {...(sort ? { sort } : {})}
        active={active}
        filters={filters}
        onFilters={onFilters}
        sortControl={<SortMenu value={sort ?? collectionSort(id)} onChange={onSort} />}
        hideCount
      />
    </div>
  );
}

/** For you, or New: rows of collections; For you leads with a featured title. */
function Rows({
  kind,
  tab,
  onOpen,
}: {
  kind: TitleKind;
  tab: "for-you" | "new";
  onOpen: (id: CollectionId) => void;
}) {
  const continuing = useContinueWatching();
  const play = useResume();
  const removal = useRemoveFromContinue();
  const [box, fit] = useFit();
  const stills = fit(STILL_REM);
  const posters = fit(POSTER_REM);
  const mine = continuing.entries.filter((entry) => entry.title.kind === kind);
  // Titles like the one watched last, by the version that was watched.
  const like = mine[0]?.version ?? null;
  const rows = useQuery(queries.rows(kind, tab, tab === "for-you" ? like : null));
  if (rows.error) {
    return <p className="px-10 text-sm text-destructive">{describeError(appError(rows.error))}</p>;
  }
  const featured = tab === "for-you" ? featuredOf(kind, rows.data ?? []) : null;
  // A featured movie the viewer is part way through resumes.
  const resume =
    featured &&
    mine.find((entry) => entry.title.versions.some((version) => sameOwned(version, featured)));
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-10 pb-16">
      {featured && <Featured title={featured} resume={resume ?? null} />}
      <div className="space-y-9">
        {tab === "for-you" && mine.length > 0 && (
          <div>
            <Section title={t("Continue watching")} columns={stills}>
              {mine.slice(0, stills).map((entry) => (
                <StillTile
                  key={entry.key}
                  artworkUrl={entry.artworkUrl}
                  name={entry.title.title}
                  line={entry.line}
                  done={entry.done}
                  onPlay={() => play(entry)}
                  onRemove={() => removal.mutate(entry.title)}
                />
              ))}
            </Section>
            {removal.error && (
              <p className="mt-3 text-sm text-destructive">
                {describeError(appError(removal.error))}
              </p>
            )}
          </div>
        )}
        {(rows.data ?? []).map((row) => (
          <Section
            key={row.id}
            title={row.name}
            count={row.total}
            onAll={() => onOpen(row.id)}
            columns={posters}
          >
            {row.titles.slice(0, posters).map((title) => (
              <PosterTile
                key={title.key}
                title={title}
                onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
              />
            ))}
          </Section>
        ))}
      </div>
    </div>
  );
}

/** The featured title of each kind, kept for the day while it stays in the rows. */
const featuredPicks = new Map<TitleKind, { readonly day: number; readonly title: OwnedId }>();

/**
 * The title For you leads with: one of the ten most popular with a picture, a different one each
 * day. It stays put while popularity arrives from TMDB and reorders the rows.
 */
function featuredOf(kind: TitleKind, rows: readonly CollectionRow[]): Title | null {
  const day = Math.floor(Date.now() / 86_400_000);
  const picked = featuredPicks.get(kind);
  if (picked?.day === day) {
    const kept = rows
      .flatMap((row) => row.titles)
      .find((title) => sameOwned(title, picked.title) && title.backdropUrl);
    if (kept) return kept;
  }
  const popular = rows.find((row) => row.id === "popular")?.titles ?? rows[0]?.titles ?? [];
  const pictured = popular.filter((title) => title.backdropUrl).slice(0, 10);
  const title = pictured[day % Math.max(pictured.length, 1)] ?? null;
  if (title) featuredPicks.set(kind, { day, title: ownedId(title) });
  return title;
}

function Featured({ title, resume }: { title: Title; resume: ContinueEntry | null }) {
  const facts = [
    title.year,
    ...title.genres.slice(0, 2),
    title.rating ? `★ ${formatDecimal(title.rating, 1)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const resumeEntry = useResume();
  const picked = pickedVersion(title, useSubscriptionPreferences());
  return (
    <section className="relative mb-9 aspect-[21/8] max-h-[26rem] w-full overflow-hidden rounded-2xl">
      <Artwork url={title.backdropUrl} name={title.title} size="full" plain />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/40 to-transparent" />
      <div className="absolute bottom-8 left-8 max-w-[40rem]">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">{title.title}</h1>
        <div className="mt-2 text-[0.9375rem] text-foreground/85">{facts}</div>
        <div className="mt-6 flex gap-3">
          {title.kind === "movie" && (
            <Button
              variant="primary"
              size="lg"
              onClick={() =>
                resume
                  ? resumeEntry(resume)
                  : playTitle(movieNow({ ...title, ...picked }, title.backdropUrl), 0)
              }
            >
              <Play className="fill-current" />
              {resume ? t("Resume") : t("Play")}
            </Button>
          )}
          <Button
            variant={title.kind === "movie" ? "secondary" : "primary"}
            size="lg"
            onClick={() => openDetails({ kind: title.kind, ...ownedId(title) })}
          >
            {title.kind === "movie" ? t("Details") : t("Episodes")}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Genres or streaming services as a page of picture tiles. */
function Tiles({
  kind,
  of,
  onOpen,
}: {
  kind: TitleKind;
  of: "genres" | "services";
  onOpen: (id: CollectionId) => void;
}) {
  const tiles = useQuery(queries.tiles(kind, of));
  const status = useQuery(queries.onDemandStatus());
  const metadata = status.data?.metadata;
  if (tiles.error) {
    return <p className="px-10 text-sm text-destructive">{describeError(appError(tiles.error))}</p>;
  }
  const empty = tiles.data?.length === 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-10 pt-1 pb-16">
      {empty ? (
        <p className="text-[0.9375rem] text-muted-foreground">
          {!metadata
            ? of === "genres"
              ? t("Genres need a TMDB key, in Settings.")
              : t("Services need a TMDB key, in Settings.")
            : metadata.refused
              ? t("TMDB refused the key. Check it in Settings.")
              : metadata.known < metadata.wanted
                ? of === "genres"
                  ? t("Genres appear as details arrive from TMDB.")
                  : t("Services appear as details arrive from TMDB.")
                : of === "genres"
                  ? t("No genres for these titles.")
                  : t("No streaming services for these titles here.")}
        </p>
      ) : (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))" }}
        >
          {(tiles.data ?? []).map((tile) => (
            <CollectionTileButton key={tile.id} tile={tile} onOpen={() => onOpen(tile.id)} />
          ))}
        </div>
      )}
      {of === "services" && Boolean(tiles.data?.length) && (
        <p className="mt-8 text-xs text-muted-foreground">Where titles stream, from JustWatch.</p>
      )}
    </div>
  );
}

function CollectionTileButton({ tile, onOpen }: { tile: CollectionTile; onOpen: () => void }) {
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="group relative block aspect-video overflow-hidden rounded-xl text-left ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 hover:ring-2 hover:ring-white/40 active:scale-[0.98]"
    >
      <Artwork url={tile.artworkUrl} name={tile.name} size="wide" plain />
      <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
      <span className="absolute bottom-3 left-4">
        <span className="block text-lg font-semibold">{tile.name}</span>
        <span className="block text-xs text-muted-foreground tabular-nums">
          {formatNumber(tile.count)}
        </span>
      </span>
    </button>
  );
}

/** A row: a heading with All, over one line of tiles; the rest of the row is behind All. */
function Section({
  title,
  count,
  onAll,
  columns,
  children,
}: {
  title: string;
  count?: number;
  onAll?: () => void;
  /** How many tiles fit across. The row is given no more, so none wraps. */
  columns: number;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3.5 flex items-baseline gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {onAll && (
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAll}
            className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-white"
          >
            {t("All")}
            {count === undefined ? "" : ` ${formatNumber(count)}`}
            <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
      <div
        className="grid gap-x-4"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {children}
      </div>
    </section>
  );
}
