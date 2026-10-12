import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Play, Volume2, VolumeX } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Listing } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { seriesOf, type Title, type TitleKind } from "@mrstreamer/contracts/ondemand";
import {
  hasTitles,
  ownedId,
  ownedKey,
  sameOwned,
  type OwnedId,
} from "@mrstreamer/contracts/subscription";
import { formatNumber, t } from "@mrstreamer/core/i18n";
import { openDetails, openView, useUi, type ChannelList } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo, hueOf } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { PosterTile, StillTile } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { categoryOf, channelLine, clockTime, progressOf, timeLeft } from "../../lib/format.ts";
import {
  queries,
  useCategoryMap,
  useLastChannel,
  useSourceOf,
  useSubscriptionPreferences,
  useSubscriptions,
} from "../../lib/queries.ts";
import { useContinueWatching, useRemoveFromContinue, useResume } from "../../lib/titles.ts";
import { useFit } from "../../lib/use-fit.ts";
import { usePreviewWaits } from "../../player/output.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { call } from "../../lib/ipc.ts";
import { CustomizeHome } from "./CustomizeHome.tsx";
import { homeRows, type HomeRowId } from "./rows.ts";
import { watchChannel } from "../live/GuidePage.tsx";
import { useShowList } from "../live/lists.ts";
import { PAGE } from "../titles/CollectionGrid.tsx";
import { openCollection } from "../titles/TitlesPage.tsx";
import { SavedTile } from "../watchlist/SavedTile.tsx";

const NO_IDS: readonly OwnedId[] = [];
const NO_CHANNELS: readonly LiveChannel[] = [];
const NO_TITLES: readonly Title[] = [];
/** Tile widths: channels and stills at 16:9, posters at 2:3. */
const TILE_REM = 13;
const POSTER_REM = 8.5;

/** Channels without those for adults, which show only in Live TV. */
function ordinary(channels: readonly LiveChannel[] | undefined): readonly LiveChannel[] {
  return channels?.filter((channel) => !channel.adult) ?? NO_CHANNELS;
}

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
  const list = useUi((state) => state.list);
  const viewing = useQuery(queries.viewing());
  const favouriteIds = viewing.data?.favourites ?? NO_IDS;
  const recentIds = viewing.data?.recent ?? NO_IDS;
  const favourites = ordinary(useQuery(queries.channelsOf(favouriteIds)).data);
  const recent = ordinary(useQuery(queries.channelsOf(recentIds)).data);
  // The category Live TV shows, or the one the viewer left it at, which one subscription keeps.
  const lastCategory: OwnedId | null =
    list.kind === "category"
      ? list.category
      : ([...(left ?? [])].flatMap(([subscriptionId, { lastCategoryId }]) =>
          lastCategoryId === null ? [] : [{ subscriptionId, id: lastCategoryId }],
        )[0] ?? null);
  const category = lastCategory ? categoryMap.get(ownedKey(lastCategory)) : undefined;
  // Your category, or every channel before you have one.
  const categoryList: ChannelList = category
    ? { kind: "category", category: ownedId(category) }
    : { kind: "all" };
  const inCategory = ordinary(
    useQuery({ ...queries.channels(category ?? null), enabled: categories.isSuccess }).data,
  );
  const status = useQuery(queries.libraryStatus());

  const [grid, fit] = useFit();
  const columns = fit(TILE_REM);
  const posters = fit(POSTER_REM);
  const shown = {
    favourites: favourites.slice(0, columns),
    recent: recent.slice(0, columns),
    category: inCategory.slice(0, columns),
  };
  const newMovies = useHomeTitles("movie", posters, titleCollection);
  const newSeries = useHomeTitles("series", posters, titleCollection);
  // Home's first Watchlist page always excludes adult saves; the full list has its own query.
  const onDemand = subscriptions.some(hasTitles);
  const saved = useQuery({ ...queries.watchlist("saved", 0, PAGE, true), enabled: onDemand }).data;
  const continuing = useContinueWatching();
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
  const listings = useQuery(queries.listings(listed)).data ?? {};
  // Without a last channel, a favourite on now, or the first in your category, stands still.
  const hero =
    playing ??
    last ??
    shown.favourites.find((channel) => listings[ownedKey(channel)]?.now) ??
    shown.favourites[0] ??
    shown.category[0] ??
    null;

  const preferences = useQuery(queries.preferences());
  const [customizing, setCustomizing] = useState(false);
  const rows = homeRows(preferences.data?.homeRows);
  const seeds = (viewing.data?.recentTitles ?? []).slice(0, 32).map(({ title }) => ({
    kind: title.kind === "movie" ? ("movie" as const) : ("series" as const),
    version: title.kind === "movie" ? ownedId(title) : seriesOf(title),
  }));
  const recommendations =
    useQuery({
      queryKey: ["ondemand", "home-recommendations", seeds],
      queryFn: () => call("ondemand.recommendations", { seeds }),
      enabled: onDemand && seeds.length > 0,
      staleTime: Infinity,
    }).data ?? [];
  const notice = catalogueState(categories);
  const tiles = (channels: readonly LiveChannel[]) =>
    channels.map((channel) => (
      <Tile
        key={ownedKey(channel)}
        channel={channel}
        listing={listings[ownedKey(channel)]}
        categories={categoryMap}
      />
    ));
  const titles = (list: readonly Title[]) =>
    list.map((title) => (
      <PosterTile
        key={title.key}
        title={title}
        onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
      />
    ));
  const entries = continuing.entries.slice(0, columns);
  const content: Record<HomeRowId, ReactNode> = {
    continue: entries.length > 0 && (
      <div>
        <Section title={t("Continue watching")} tileRem={TILE_REM}>
          {entries.map((entry) => (
            <StillTile
              key={entry.key}
              artworkUrl={entry.artworkUrl}
              name={entry.title.title}
              line={entry.line}
              done={entry.done}
              onPlay={() => resume(entry)}
              onRemove={() => removal.mutate(entry.title)}
            />
          ))}
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
      >
        {saved.entries.slice(0, posters).map((entry) => (
          <SavedTile key={ownedKey(entry)} entry={entry} brief />
        ))}
      </Section>
    ),
    favourites: shown.favourites.length > 0 && (
      <Section
        title={t("Favourites")}
        count={favourites.length}
        onAll={() => browse({ kind: "favourites" })}
        tileRem={TILE_REM}
      >
        {tiles(shown.favourites)}
      </Section>
    ),
    recent: shown.recent.length > 0 && (
      <Section
        title={t("Recently watched")}
        count={recent.length}
        onAll={() => browse({ kind: "recent" })}
        tileRem={TILE_REM}
      >
        {tiles(shown.recent)}
      </Section>
    ),
    "new-movies": newMovies.length > 0 && (
      <Section
        title={mappedOnly ? t("Movies") : t("New movies")}
        onAll={() => openCollection("movie", titleCollection)}
        tileRem={POSTER_REM}
      >
        {titles(newMovies)}
      </Section>
    ),
    "new-series": newSeries.length > 0 && (
      <Section
        title={mappedOnly ? t("Series") : t("New series")}
        onAll={() => openCollection("series", titleCollection)}
        tileRem={POSTER_REM}
      >
        {titles(newSeries)}
      </Section>
    ),
    category: shown.category.length > 0 && (
      <Section
        title={category?.title ?? t("All channels")}
        count={
          category?.channelCount ??
          status.data?.reduce((sum, each) => sum + each.channelCount, 0) ??
          inCategory.length
        }
        onAll={() => browse(categoryList)}
        tileRem={TILE_REM}
      >
        {tiles(shown.category)}
      </Section>
    ),
    recommendations: recommendations.length > 0 && (
      <Section title={t("Recommendations")} tileRem={POSTER_REM}>
        {recommendations.slice(0, posters).map(({ title, seed, reason }) => (
          <PosterTile
            key={title.key}
            title={title}
            wrapLine
            line={t("Because you watched {name}", { name: seed }) + " · " + reason}
            onOpen={() => openDetails({ kind: title.kind, ...ownedId(title) })}
          />
        ))}
      </Section>
    ),
  };
  return (
    <div className="h-full overflow-y-auto">
      <WindowBar className="sticky top-0 z-20 bg-black" />
      <div className="flex items-center gap-3 px-10 pt-5 pb-3">
        <h1 className="mr-auto text-2xl font-semibold">{t("Home")}</h1>
        <Button
          className="rounded-none text-white hover:bg-transparent"
          variant="ghost"
          onClick={() => openView("watchlist")}
        >
          {t("Watchlist")}
        </Button>
        <Button
          className="rounded-none text-white hover:bg-transparent"
          variant="ghost"
          aria-expanded={customizing}
          onClick={() => setCustomizing((shown) => !shown)}
        >
          {t("Customize")}
        </Button>
      </div>
      {customizing && (
        <div className="px-10">
          <CustomizeHome onDone={() => setCustomizing(false)} />
        </div>
      )}
      {notice && !(mappedOnly && notice.kind === "empty") ? (
        <div className="flex min-h-64 items-center justify-center">
          <CatalogueNotice state={notice} />
        </div>
      ) : (
        (!mappedOnly || hero) && (
          <Hero
            channel={hero}
            live={active && sameOwned(hero, playing)}
            streaming={streaming}
            listing={hero ? listings[ownedKey(hero)] : undefined}
            categories={categoryMap}
            onBrowse={browse}
          />
        )
      )}
      <div ref={grid} className="space-y-7 px-10 pt-2 pb-16">
        {rows
          .filter((row) => row.visible && content[row.id])
          .map((row) => (
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
): readonly Title[] {
  const page = useQuery(queries.collection(kind, collection, undefined, 0, Math.max(count, 1)));
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
  const current = listing?.now ?? null;
  return (
    <section
      className="relative mx-10 mb-4 flex h-48 items-end overflow-hidden pb-5"
      style={{
        background: `radial-gradient(ellipse 70% 90% at 78% 35%, hsl(${hue} 45% 20%), transparent 70%), #000`,
      }}
    >
      {channel && (
        <ChannelLogo
          channel={channel}
          plain
          className="pointer-events-none absolute top-[24%] right-[12%] h-[28%] w-[22%] text-8xl opacity-90"
        />
      )}
      <Picture
        active={live && !waits}
        fit="cover"
        className="absolute inset-y-0 right-0 aspect-video h-full max-w-full"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/60 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black to-transparent" />
      {channel && waits && (
        <p className="absolute top-[56%] right-[12%] w-[22%] text-center text-sm text-muted-foreground">
          {waits}
        </p>
      )}
      {channel && (
        <div className="relative max-w-[46rem]">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            {current?.title ?? channel.title}
          </h1>
          <div className="mt-3 flex items-center gap-2 text-[0.9375rem] text-foreground/85">
            <ChannelLogo channel={channel} className="h-6 w-9" />
            {current
              ? [
                  channel.title,
                  t("Until {time}", { time: clockTime(current.stop, now) }),
                  timeLeft(current, now),
                ].join(" · ")
              : [channelLine(channel, categories), ...channel.tags].filter(Boolean).join(" · ")}
          </div>
          {current && <Progress value={progressOf(current, now)} className="mt-3 w-72" />}
          <div className="mt-4 flex items-center gap-3">
            <Button
              className="rounded-none"
              variant="primary"
              size="default"
              onClick={() => watchChannel(channel)}
            >
              <Play className="fill-current" />
              {t("Watch")}
            </Button>
            <Button
              className="rounded-none text-white hover:bg-transparent"
              variant="ghost"
              size="default"
              onClick={() => browse({ kind: "all" })}
            >
              {t("All channels")}
            </Button>
            {live && streaming && !waits && (
              <Button
                className="rounded-none text-white hover:bg-transparent"
                variant="secondary"
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
        <div className="relative">
          <Button
            className="rounded-none"
            variant="primary"
            size="default"
            onClick={() => browse({ kind: "all" })}
          >
            {t("All channels")}
          </Button>
        </div>
      )}
    </section>
  );
}

function Section({
  title,
  count,
  onAll,
  tileRem,
  children,
}: {
  title: string;
  count?: number;
  onAll?: () => void;
  /** The narrowest a tile gets; as many fit across as the window allows, in one row. */
  tileRem: number;
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
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileRem}rem, 1fr))` }}
      >
        {children}
      </div>
    </section>
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
        className="relative grid aspect-video place-items-center rounded-2xl ring-1 ring-white/8 transition-[box-shadow,transform] duration-150 group-hover:ring-2 group-hover:ring-white/40 group-active:scale-[0.98]"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 30% 16%), hsl(${hue} 25% 8%))` }}
      >
        <ChannelLogo channel={channel} plain className="h-[42%] w-[62%] text-2xl" />
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
