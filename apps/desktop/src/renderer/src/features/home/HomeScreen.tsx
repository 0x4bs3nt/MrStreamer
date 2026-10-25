import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Play, Volume2, VolumeX } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { Listing } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { seriesOf, type Title, type TitleKind } from "@mrstreamer/contracts/ondemand";
import { hasTitles, ownedId, ownedKey, sameOwned } from "@mrstreamer/contracts/subscription";
import { formatNumber, t } from "@mrstreamer/core/i18n";
import { openDetails, openView, type ChannelList } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo, hueOf } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { PosterTile, StillTile } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { usePresentationVisible } from "../../lib/presentation.ts";
import { appError, describeError } from "../../lib/errors.ts";
import {
  categoryOf,
  channelLine,
  clockTime,
  pastTime,
  progressOf,
  timeLeft,
} from "../../lib/format.ts";
import {
  queries,
  useCategoryMap,
  useLastChannel,
  useSourceOf,
  useSubscriptionPreferences,
  useSubscriptions,
} from "../../lib/queries.ts";
import {
  useContinueWatching,
  useRemoveFromContinue,
  useResume,
  movieNow,
  playTitle,
  pickedVersion,
} from "../../lib/titles.ts";
import { useFit } from "../../lib/use-fit.ts";
import { usePreviewWaits } from "../../player/output.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { call } from "../../lib/ipc.ts";
import { homeRows, type HomeRowId } from "./rows.ts";
import { watchChannel } from "../live/GuidePage.tsx";
import { listTitle, useHomeDiscovery, useListChannels, useShowList } from "../live/lists.ts";
import { PAGE } from "../titles/CollectionGrid.tsx";
import { openCollection } from "../titles/TitlesPage.tsx";
import { HomeTitle } from "./HomeTitle.tsx";
import { kindLabel } from "../../lib/watchlist.ts";
import { SavedTile, openSaved } from "../watchlist/SavedTile.tsx";

const NO_CHANNELS: readonly LiveChannel[] = [];
const NO_TITLES: readonly Title[] = [];
/** Tile widths: channels and stills at 16:9, posters at 2:3. */
const TILE_REM = 13;
const POSTER_REM = 8.5;

/** Channels without those for adults, which show only in Live TV. */

function notForAdults(channel: LiveChannel | null): LiveChannel | null {
  return channel?.adult ? null : channel;
}

/** Opens a list in Live TV. */
function useBrowse(): (list: ChannelList) => void {
  const showList = useShowList();
  return (list) => {
    showList(list);
    openView("live");
  };
}

export function HomeScreen({ active }: { active: boolean }) {
  const visible = usePresentationVisible();
  const browse = useBrowse();
  const subscriptions = useSubscriptions();
  const mappedOnly =
    subscriptions.length > 0 &&
    subscriptions.every((each) => each.kind === "m3u") &&
    subscriptions.some(hasTitles);
  const titleCollection = mappedOnly ? "all" : "new-month";
  const left = useSubscriptionPreferences();
  const categories = useQuery(queries.categories());
  const categoryMap = useCategoryMap();
  const customLists = useQuery(queries.customLists()).data;
  const viewing = useQuery(queries.viewing());
  const favourites = useListChannels({ kind: "favourites" }, "ordinary").channels ?? NO_CHANNELS;
  const recent = useListChannels({ kind: "recent" }, "ordinary").channels ?? NO_CHANNELS;
  const categoryList = useHomeDiscovery();
  const discovery = useListChannels(categoryList, "ordinary");
  const inCategory = discovery.channels ?? NO_CHANNELS;

  const [grid, fit] = useFit();
  const columns = fit(TILE_REM);
  const posters = fit(POSTER_REM);
  const preferences = useQuery(queries.preferences());
  const rows = homeRows(preferences.data?.homeRows);
  const allowed = (id: HomeRowId) =>
    preferences.isSuccess && rows.some((row) => row.id === id && row.visible);
  const needs = (id: HomeRowId) => visible && allowed(id);
  const channelRows = { favourites, recent, category: inCategory };
  const isChannelRow = (id: HomeRowId): id is keyof typeof channelRows => id in channelRows;
  const promoted = rows
    .filter((row) => row.visible)
    .map((row) => row.id)
    .find((id): id is keyof typeof channelRows => isChannelRow(id) && channelRows[id].length > 0);
  const shown = {
    favourites: favourites.slice(0, promoted === "favourites" ? 6 : columns),
    recent: recent.slice(0, promoted === "recent" ? 6 : columns),
    category: inCategory.slice(0, promoted === "category" ? 6 : columns),
  };
  const onDemand = subscriptions.some(hasTitles);
  const newMovies = useHomeTitles(
    "movie",
    posters,
    titleCollection,
    onDemand && needs("new-movies"),
  );
  const newSeries = useHomeTitles(
    "series",
    posters,
    titleCollection,
    onDemand && needs("new-series"),
  );
  // Home's first Watchlist page always excludes adult saves; the full list has its own query.
  const saved = useQuery({
    ...queries.watchlist("saved", 0, PAGE, true),
    enabled: onDemand && needs("watchlist"),
  }).data;
  const continuing = useContinueWatching(undefined, allowed("continue"));
  const resume = useResume();
  const removal = useRemoveFromContinue();
  const playing = notForAdults(usePlayer((state) => state.channel));
  const streaming = usePlayer(
    (state) => state.phase.kind !== "idle" && state.phase.kind !== "failed",
  );
  const last = notForAdults(useLastChannel());
  // Each channel shown, once.
  const listed = useMemo(
    () => [
      ...new Map(
        [playing, last, ...shown.favourites, ...shown.recent, ...shown.category].flatMap(
          (channel) => (channel ? [[ownedKey(channel), channel] as const] : []),
        ),
      ).values(),
    ],
    [playing, last, shown.favourites, shown.recent, shown.category],
  );
  const listings =
    useQuery({
      ...queries.listings(listed),
      enabled: visible && listed.length > 0,
    }).data ?? {};
  // Without a last channel, a favourite on now, or the first in your category, stands still.
  const hero =
    playing ??
    last ??
    shown.favourites.find((channel) => listings[ownedKey(channel)]?.now) ??
    shown.favourites[0] ??
    shown.category[0] ??
    null;

  const seeds = (viewing.data?.recentTitles ?? []).slice(0, 32).map(({ title }) => ({
    kind: title.kind === "movie" ? ("movie" as const) : ("series" as const),
    version: title.kind === "movie" ? ownedId(title) : seriesOf(title),
  }));
  const recommendations =
    useQuery({
      queryKey: ["ondemand", "home-recommendations", seeds],
      queryFn: () => call("ondemand.recommendations", { seeds }),
      enabled: onDemand && needs("recommendations") && seeds.length > 0,
      staleTime: Infinity,
    }).data ?? [];
  const notice = catalogueState(categories);
  const stageShown =
    !(notice && !(mappedOnly && notice.kind === "empty")) && (!mappedOnly || !!hero);
  const tiles = (channels: readonly LiveChannel[]) =>
    channels.map((channel) => (
      <Tile
        key={ownedKey(channel)}
        channel={channel}
        listing={listings[ownedKey(channel)]}
        categories={categoryMap}
      />
    ));
  const sourceOf = useSourceOf();
  const playMovie = (title: Title) => {
    playTitle(movieNow({ ...title, ...pickedVersion(title, left) }, title.backdropUrl), 0);
  };
  const titles = (list: readonly Title[]) =>
    list.map((title) =>
      list.length <= 3 ? (
        <HomeTitle
          key={title.key}
          name={title.title}
          artworkUrl={title.posterUrl}
          line={[kindLabel(title.kind), title.year, sourceOf(title)].filter(Boolean).join(" · ")}
          onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
          onPlay={title.kind === "movie" ? () => playMovie(title) : undefined}
        />
      ) : (
        <PosterTile
          key={title.key}
          title={title}
          onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
        />
      ),
    );
  const entries = continuing.entries.slice(0, columns);
  const compact = (count: number) => (count <= 3 ? Math.min(3, posters) : undefined);
  const channelSections = {
    favourites: {
      title: t("Favourites"),
      count: favourites.length,
      list: { kind: "favourites" } as const,
    },
    recent: {
      title: t("Recently watched"),
      count: recent.length,
      list: { kind: "recent" } as const,
    },
    category: {
      title: listTitle(categoryList, categoryMap, customLists),
      count: inCategory.length,
      list: categoryList,
    },
  };
  const content: Record<HomeRowId, ReactNode> = {
    continue: entries.length > 0 && (
      <div>
        <Section
          title={t("Continue watching")}
          tileRem={TILE_REM}
          compact={compact(continuing.entries.length)}
        >
          {entries.map((entry) =>
            continuing.entries.length <= 3 ? (
              <HomeTitle
                key={entry.key}
                name={entry.title.title}
                artworkUrl={entry.artworkUrl}
                line={[entry.line, sourceOf({ ...entry.title, ...entry.version })]
                  .filter(Boolean)
                  .join(" · ")}
                still
                done={entry.done}
                onPlay={() => resume(entry)}
                onOpen={() => openDetails({ kind: entry.title.kind, ...entry.version })}
                onRemove={() => removal.mutate(entry.title)}
              />
            ) : (
              <StillTile
                key={entry.key}
                artworkUrl={entry.artworkUrl}
                name={entry.title.title}
                line={entry.line}
                done={entry.done}
                onPlay={() => resume(entry)}
                onRemove={() => removal.mutate(entry.title)}
              />
            ),
          )}
        </Section>
        {removal.error && (
          <p className="mt-3 text-sm text-destructive">{describeError(appError(removal.error))}</p>
        )}
      </div>
    ),
    watchlist: saved && saved.total > 0 && (
      <Section
        title={t("Watchlist")}
        count={saved.total}
        onAll={() => openView("watchlist")}
        tileRem={POSTER_REM}
        compact={compact(saved.total)}
      >
        {saved.entries.slice(0, posters).map((entry) =>
          saved.total <= 3 ? (
            <HomeTitle
              key={ownedKey(entry)}
              name={entry.title?.title ?? entry.name}
              artworkUrl={entry.title?.posterUrl ?? entry.artworkUrl}
              unavailable={entry.listed && !entry.title}
              line={
                entry.listed && !entry.title
                  ? t("Unavailable")
                  : [
                      kindLabel(entry.kind),
                      entry.title?.year ?? entry.year,
                      entry.title && sourceOf(entry.title),
                    ]
                      .filter(Boolean)
                      .join(" · ")
              }
              onOpen={() => openSaved(entry)}
              onPlay={
                entry.title?.kind === "movie"
                  ? () => {
                      if (entry.title) playMovie(entry.title);
                    }
                  : undefined
              }
            />
          ) : (
            <SavedTile key={ownedKey(entry)} entry={entry} brief />
          ),
        )}
      </Section>
    ),
    favourites: shown.favourites.length > 0 && (
      <Section
        title={channelSections.favourites.title}
        count={channelSections.favourites.count}
        onAll={() => browse(channelSections.favourites.list)}
        tileRem={TILE_REM}
      >
        {tiles(shown.favourites)}
      </Section>
    ),
    recent: shown.recent.length > 0 && (
      <Section
        title={channelSections.recent.title}
        count={channelSections.recent.count}
        onAll={() => browse(channelSections.recent.list)}
        tileRem={TILE_REM}
      >
        {tiles(shown.recent)}
      </Section>
    ),
    "new-movies": newMovies.length > 0 && (
      <Section
        title={mappedOnly ? t("Movies") : t("New movies")}
        compact={compact(newMovies.length)}
        onAll={() => openCollection("movie", titleCollection)}
        tileRem={POSTER_REM}
      >
        {titles(newMovies)}
      </Section>
    ),
    "new-series": newSeries.length > 0 && (
      <Section
        title={mappedOnly ? t("Series") : t("New series")}
        compact={compact(newSeries.length)}
        onAll={() => openCollection("series", titleCollection)}
        tileRem={POSTER_REM}
      >
        {titles(newSeries)}
      </Section>
    ),
    category: shown.category.length > 0 && (
      <Section
        title={channelSections.category.title}
        count={channelSections.category.count}
        onAll={() => browse(channelSections.category.list)}
        tileRem={TILE_REM}
      >
        {tiles(shown.category)}
      </Section>
    ),
    recommendations: recommendations.length > 0 && (
      <Section
        title={t("Recommendations")}
        tileRem={POSTER_REM}
        compact={compact(recommendations.length)}
      >
        {recommendations
          .slice(0, posters)
          .map(({ title, seed, reason }) =>
            recommendations.length <= 3 ? (
              <HomeTitle
                key={title.key}
                name={title.title}
                artworkUrl={title.posterUrl}
                line={[t("Because you watched {name}", { name: seed }), reason, sourceOf(title)]
                  .filter(Boolean)
                  .join(" · ")}
                onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
                onPlay={title.kind === "movie" ? () => playMovie(title) : undefined}
              />
            ) : (
              <PosterTile
                key={title.key}
                title={title}
                wrapLine
                line={t("Because you watched {name}", { name: seed }) + " · " + reason}
                onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
              />
            ),
          )}
      </Section>
    ),
  };
  const remaining = rows.filter(
    (row) => row.visible && (!stageShown || row.id !== promoted) && content[row.id],
  );
  const titleRows = remaining.filter((row) => !isChannelRow(row.id));
  const titlesInOrder = [
    ...titleRows.filter((row) => row.id === "continue"),
    ...titleRows.filter((row) => row.id !== "continue"),
  ];
  // Continue leads the title rows; channel rows keep their saved positions between them.
  const displayed = remaining.map((row) =>
    isChannelRow(row.id) ? row : (titlesInOrder[titleRows.indexOf(row)] ?? row),
  );
  return (
    <div className="h-full overflow-y-auto">
      <WindowBar className="sticky top-0 z-20 bg-black" />
      <div className="flex items-center gap-3 px-10 pt-5 pb-3">
        <h1 className="mr-auto text-2xl font-semibold">{t("Home")}</h1>
      </div>
      {notice && !(mappedOnly && notice.kind === "empty") ? (
        <div className="flex min-h-64 items-center justify-center">
          <CatalogueNotice state={notice} />
        </div>
      ) : (
        (!mappedOnly || hero) && (
          <div
            className="mx-10 mt-1 mb-7 grid items-start gap-6"
            data-home-stage
            style={{
              gridTemplateColumns: promoted
                ? "minmax(0, min(38.67rem, 52%)) minmax(0, 1fr)"
                : "minmax(0, 38.67rem)",
            }}
          >
            <Hero
              channel={hero}
              live={active && sameOwned(hero, playing)}
              streaming={streaming}
              listing={hero ? listings[ownedKey(hero)] : undefined}
              categories={categoryMap}
              onBrowse={browse}
            />
            {promoted && (
              <section className="@container min-w-0" data-home-row={promoted} data-home-promoted>
                <SectionHeading
                  title={channelSections[promoted].title}
                  count={channelSections[promoted].count}
                  onAll={() => browse(channelSections[promoted].list)}
                />
                {shown[promoted].map((channel) => (
                  <ChannelLine
                    key={ownedKey(channel)}
                    channel={channel}
                    listing={listings[ownedKey(channel)]}
                    categories={categoryMap}
                  />
                ))}
              </section>
            )}
          </div>
        )
      )}
      <div ref={grid} className="space-y-7 px-10 pt-2 pb-16">
        {displayed.map((row) => (
          <div key={row.id} data-home-row={row.id}>
            {content[row.id]}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Playlists have no reliable added date, so Home uses their full catalogue's first page. */
function useHomeTitles(
  kind: TitleKind,
  count: number,
  collection: "all" | "new-month",
  enabled: boolean,
): readonly Title[] {
  const page = useQuery({
    ...queries.collection(kind, collection, undefined, 0, Math.max(count, 1)),
    enabled,
  });
  return page.data?.titles.slice(0, count) ?? NO_TITLES;
}

function Hero({
  channel,
  live,
  streaming,
  listing,
  categories,
  onBrowse: browse,
}: {
  channel: LiveChannel | null;
  /** The backdrop shows this channel's stream. */
  live: boolean;
  /** The stream is up, so it has sound to turn on. */
  streaming: boolean;
  listing: Listing | undefined;
  categories: ReadonlyMap<string, Category>;
  /** Opens a list in Live TV. */
  onBrowse: (list: ChannelList) => void;
}) {
  const now = useNow();
  const audible = usePlayer((state) => state.audible && !state.muted);
  // A receiver on the network is connected, so the backdrop stands still and says why.
  const waits = usePreviewWaits();
  const hue = channel ? hueOf(channel.title) : 220;
  // The channel's recording that plays says when it aired, as Watch does.
  const archive = usePlayer((state) =>
    channel && sameOwned(state.channel, channel) ? state.archive : null,
  );
  const current = archive ? null : (listing?.now ?? null);
  return (
    <section
      className="relative aspect-video min-w-0 overflow-hidden rounded-2xl"
      data-home-preview
      style={{
        background: `radial-gradient(ellipse 70% 90% at 78% 35%, hsl(${hue} 45% 20%), transparent 70%), #000`,
      }}
    >
      {channel && (
        <ChannelLogo
          channel={channel}
          plain
          className="pointer-events-none absolute top-[15%] left-[31%] h-[34%] w-[38%] text-5xl"
        />
      )}
      <Picture active={live && !waits} fit="contain" className="absolute inset-0" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-transparent" />
      {channel && waits && (
        <p className="absolute inset-x-6 top-4 text-center text-sm text-muted-foreground">
          {waits}
        </p>
      )}
      {channel && (
        <div className="absolute inset-x-6 bottom-5">
          <h2 className="line-clamp-2 text-[1.375rem] leading-tight font-semibold tracking-tight text-balance">
            {(archive ?? current)?.title ?? channel.title}
          </h2>
          <div className="mt-2 flex min-w-0 items-center gap-2 text-sm text-foreground/85">
            <ChannelLogo channel={channel} className="h-6 w-9" />
            <span className="truncate" title={channel.title}>
              {archive
                ? [channel.title, t("Aired {time}", { time: pastTime(archive.start, now) })].join(
                    " · ",
                  )
                : current
                  ? [
                      channel.title,
                      t("Until {time}", { time: clockTime(current.stop, now) }),
                      timeLeft(current, now),
                    ].join(" · ")
                  : [channelLine(channel, categories), ...channel.tags].filter(Boolean).join(" · ")}
            </span>
          </div>
          {current && (
            <Progress value={progressOf(current, now)} className="mt-3 w-72 max-w-full" />
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="default" onClick={() => watchChannel(channel)}>
              <Play className="fill-current" />
              {t("Watch")}
            </Button>
            <Button variant="media" size="default" onClick={() => browse({ kind: "all" })}>
              {t("All channels")}
            </Button>
            {live && streaming && !waits && (
              <Button
                variant="media"
                size="icon"
                aria-label={audible ? t("Mute") : t("Unmute")}
                onClick={() => player.toggleMute()}
              >
                {audible ? <Volume2 /> : <VolumeX />}
              </Button>
            )}
          </div>
        </div>
      )}
      {!channel && (
        <div className="absolute bottom-5 left-6">
          <Button variant="primary" size="default" onClick={() => browse({ kind: "all" })}>
            {t("All channels")}
          </Button>
        </div>
      )}
    </section>
  );
}

function SectionHeading({
  title,
  count,
  onAll,
}: {
  title: string;
  count?: number | undefined;
  onAll?: (() => void) | undefined;
}) {
  return (
    <div className="mb-3.5 flex min-w-0 items-baseline gap-3">
      <h2 className="min-w-0 text-xl font-semibold tracking-tight break-words">{title}</h2>
      {onAll && (
        <Button variant="ghost" size="sm" onClick={onAll}>
          {t("All")}
          {count === undefined ? "" : ` ${formatNumber(count)}`}
          <ChevronRight className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  onAll,
  tileRem,
  compact,
  children,
}: {
  title: string;
  count?: number | undefined;
  onAll?: (() => void) | undefined;
  tileRem: number;
  /** Sparse titles span three poster columns, wrapping when the window is narrower. */
  compact?: number | undefined;
  children: ReactNode;
}) {
  return (
    <section>
      <SectionHeading title={title} count={count} onAll={onAll} />
      <div
        className="grid items-start gap-4"
        style={{
          gridTemplateColumns: compact
            ? `repeat(auto-fill, minmax(min(100%, ${compact * POSTER_REM + compact - 1}rem), 1fr))`
            : `repeat(auto-fill, minmax(${tileRem}rem, 1fr))`,
        }}
      >
        {children}
      </div>
    </section>
  );
}

/** Six compact rows reuse the guide's channel, programme, progress and remaining-time pattern. */
function ChannelLine({
  channel,
  listing,
  categories,
}: {
  channel: LiveChannel;
  listing: Listing | undefined;
  categories: ReadonlyMap<string, Category>;
}) {
  const now = useNow();
  const current = listing?.now;
  const source = useSourceOf()(channel);
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => watchChannel(channel)}
      className="grid min-h-[2.8rem] w-full grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-white/8 text-left hover:bg-white/5 @[32rem]:min-h-[3.25rem] @[32rem]:grid-cols-[3.5rem_9rem_minmax(0,1fr)_auto]"
      title={channel.title}
    >
      <span
        className="relative block aspect-video overflow-hidden rounded-md bg-white/5"
        data-home-channel-art
      >
        <ChannelLogo
          channel={channel}
          plain
          className="absolute top-[18%] left-[15%] h-[64%] w-[70%]"
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[0.9375rem]">{channel.title}</span>
        {source && <span className="block truncate text-xs text-muted-foreground">{source}</span>}
        <span className="block truncate text-xs text-muted-foreground @[32rem]:hidden">
          {current?.title ?? categoryOf(channel, categories)}
        </span>
        {current && <Progress value={progressOf(current, now)} className="mt-1 @[32rem]:hidden" />}
      </span>
      <span className="hidden min-w-0 @[32rem]:block">
        <span className="block truncate text-[0.9375rem] text-foreground/85">
          {current?.title ?? categoryOf(channel, categories)}
        </span>
        {current && <Progress value={progressOf(current, now)} className="mt-1.5" />}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {current ? timeLeft(current, now) : ""}
      </span>
    </button>
  );
}

/** A channel, programme first: what's on with its progress, or the channel and its category. */
function Tile({
  channel,
  listing,
  categories,
}: {
  channel: LiveChannel;
  listing: Listing | undefined;
  categories: ReadonlyMap<string, Category>;
}) {
  const now = useNow();
  const hue = hueOf(channel.title);
  const current = listing?.now ?? null;
  // Whose channel it is, where another subscription has one of its name.
  const source = useSourceOf()(channel);
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => watchChannel(channel)}
      className="group min-w-0 text-left"
    >
      <div
        data-home-channel-art
        className="relative aspect-video overflow-hidden rounded-2xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 30% 16%), hsl(${hue} 25% 8%))` }}
      >
        <ChannelLogo
          channel={channel}
          plain
          className="absolute top-[27%] left-[20%] h-[46%] w-[60%] text-2xl"
        />
        {current && (
          <Progress value={progressOf(current, now)} className="absolute inset-x-3 bottom-2.5" />
        )}
      </div>
      <div className="mt-2.5 truncate text-[0.9375rem] font-medium">
        {current?.title ?? channel.title}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {(current
          ? [channel.title, source, timeLeft(current, now)]
          : [categoryOf(channel, categories) || channel.tags.join(" · "), source]
        )
          .filter(Boolean)
          .join(" · ")}
      </div>
    </button>
  );
}
