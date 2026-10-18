import type { CollectionId, CollectionRow, Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { seriesOf } from "@mrstreamer/contracts/ondemand";
import { collectionRows, rowIds, type Collections } from "@mrstreamer/core/ondemand/collections";
import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { reloadTitles, retryTitles, useRoster } from "./account.ts";
import { describeError } from "./errors.ts";
import { tabHref } from "./header.tsx";
import {
  Docked,
  libraryStatus,
  loadingStatus,
  Placeholders,
  Shape,
  useDockInset,
  type Status,
} from "./loading.tsx";
import { detailsHref, openDetails, resume, useContinueWatching } from "./resume.ts";
import { store, useStore } from "./store.ts";
import { useFixedTabBar } from "./tab-bar.ts";
import { tilesOf, useCollections, useHolding, useTitleLists } from "./titles.ts";
import {
  Artwork,
  CollectionTileView,
  PlaceholderGrid,
  PlaceholderShelf,
  PosterGrid,
  Shelf,
  TextTabs,
} from "./titles-ui.tsx";
import { colors, Message } from "./ui.tsx";
import { useViewing } from "./viewing.ts";

// Movies or Series: the desktop's tabs as text under the title. For you leads with a featured
// title, what is being watched, titles like the last one and the collections that suit the
// viewer's language; New gathers what was added; Genres and Services are tiles; 4K and All are
// virtualised grids. A row's All, a genre or a service opens its collection on the tab's stack.
// Genres, services, popular and top rated come from TMDB, so without its metadata they are left
// out rather than shown empty. Until a kind's first collections are made, still shapes hold For
// you; what loads, updates or failed by provider is the status line at the bottom, over the
// titles already there.

type Tab = "for-you" | "new" | "genres" | "services" | "4k" | "all";

/** Which tab each kind was on, kept while the viewer goes elsewhere and comes back. */
const places = store<Record<TitleKind, Tab>>({ movie: "for-you", series: "for-you" });

export const collectionHref = (kind: TitleKind, id: CollectionId) =>
  `/${kind === "movie" ? "films" : "series"}/collection/${encodeURIComponent(id)}` as const;

/**
 * The status line for a kind's screens: each provider's movie and series lists, Retry reading a
 * failed one's again, Settings on the kind's own tab.
 */
function useTitlesStatus(kind: TitleKind): Status | null {
  const roster = useRoster();
  return libraryStatus(roster.kind === "ready" ? roster.members : [], {
    titles: true,
    retry: reloadTitles,
    settings: () => router.push(tabHref(kind === "movie" ? "films" : "series", "settings")),
  });
}

/** The Movies or Series tab. */
export function TitlesHome({ kind }: { kind: TitleKind }) {
  const lists = useTitleLists();
  const made = useCollections(kind);
  const status = useTitlesStatus(kind);
  if (lists.kind === "failed") {
    return (
      <View style={styles.screen}>
        <Message
          text={describeError(lists.error)}
          action={{ label: "Try again", onPress: retryTitles }}
        />
      </View>
    );
  }
  // Loading too while the lists' collections are first made.
  if (!made) {
    return (
      <Docked status={status ?? loadingStatus(kind === "movie" ? "movies" : "series")}>
        <ScrollView
          style={styles.screen}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.content}
          scrollEnabled={false}
          testID={`${kind}-loading`}
        >
          <Placeholders style={styles.featured}>
            <Shape style={styles.featuredArt} />
          </Placeholders>
          <PlaceholderShelf />
          <PlaceholderShelf />
        </ScrollView>
      </Docked>
    );
  }
  return (
    <Docked status={status}>
      <Browse made={made} kind={kind} />
    </Docked>
  );
}

function Browse({ made, kind }: { made: Collections; kind: TitleKind }) {
  const viewing = useViewing();
  const inset = useDockInset();
  const chosen = useStore(places)[kind];
  const open = useCallback((title: Title) => openDetails(title), []);

  /** For you starts with titles like the one of this kind watched last. */
  const like = useMemo(() => {
    const last = (viewing?.recentTitles ?? viewing?.continueWatching ?? []).find(({ title }) =>
      kind === "movie" ? title.kind === "movie" : title.kind === "episode",
    );
    if (!last) return null;
    return last.title.kind === "movie" ? ownedId(last.title) : seriesOf(last.title);
  }, [viewing, kind]);

  // Which tabs have anything, counted without sorting; only the open tab's lists are read.
  const has = useMemo(
    () => ({
      new: rowIds(made, "new", null).some((id) => made.size(id) > 0),
      genres: made.genres().length > 0,
      services: made.services().length > 0,
      fourK: made.size("4k") > 0,
    }),
    [made],
  );
  const tabs = [
    { value: "for-you" as const, label: "For you" },
    ...(has.new ? [{ value: "new" as const, label: "New" }] : []),
    ...(has.genres ? [{ value: "genres" as const, label: "Genres" }] : []),
    ...(has.services ? [{ value: "services" as const, label: "Services" }] : []),
    ...(has.fourK ? [{ value: "4k" as const, label: "4K" }] : []),
    { value: "all" as const, label: "All" },
  ];
  // A tab that emptied, as before TMDB's metadata arrived, gives way to For you.
  const tab = tabs.some((each) => each.value === chosen) ? chosen : "for-you";
  const grid = tab === "4k" || tab === "all";
  const rows = useMemo(
    () =>
      tab === "for-you" || tab === "new"
        ? collectionRows(made, tab, tab === "for-you" ? like : null)
        : [],
    [made, tab, like],
  );
  const tiles = useMemo(
    () => (tab === "genres" || tab === "services" ? tilesOf(made, tab) : []),
    [made, tab],
  );
  // TitlesHome asks as Movies opens and as collections are made; the tab and lead are Browse's.
  useHolding(kind, [tab, like]);
  useFixedTabBar(grid);
  const choose = (next: Tab) => places.set((current) => ({ ...current, [kind]: next }));
  const header = <TextTabs tabs={tabs} value={tab} onChange={choose} />;

  if (grid) {
    return (
      <PosterGrid
        key={tab}
        titles={made.list(tab === "4k" ? "4k" : "all")}
        onPress={open}
        header={<View style={styles.gridHead}>{header}</View>}
        empty={<Message text={kind === "movie" ? "No movies." : "No series."} />}
        testID={`${kind}-grid`}
      />
    );
  }
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.content, { paddingBottom: 32 + inset }]}
      testID={`${kind}-${tab}`}
    >
      {header}
      {tab === "for-you" ? (
        <ForYou kind={kind} rows={rows} open={open} />
      ) : tab === "new" ? (
        rows.map((row) => (
          <Shelf
            key={row.id}
            name={row.name}
            titles={row.titles}
            total={row.total}
            onAll={() => router.push(collectionHref(kind, row.id))}
            onPress={open}
          />
        ))
      ) : (
        <View style={styles.tiles}>
          {tiles.map((tile) => (
            <CollectionTileView
              key={tile.id}
              name={tile.name}
              count={tile.count}
              artworkUrl={tile.artworkUrl}
              onPress={() => router.push(collectionHref(kind, tile.id))}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function ForYou({
  kind,
  rows,
  open,
}: {
  kind: TitleKind;
  rows: readonly CollectionRow[];
  open: (title: Title) => void;
}) {
  const continuing = useContinueWatching(kind);
  const featured = rows[0]?.titles[0] ?? null;
  return (
    <>
      {featured ? <Featured title={featured} /> : null}
      {continuing.length > 0 ? (
        <Shelf
          name="Continue watching"
          titles={continuing.map((entry) => entry.title)}
          onPress={(title) => {
            const entry = continuing.find((each) => each.title.key === title.key);
            if (entry) resume(entry);
          }}
          lines={(title) => continuing.find((each) => each.title.key === title.key)?.line}
          done={(title) => continuing.find((each) => each.title.key === title.key)?.done ?? null}
        />
      ) : null}
      {rows.map((row) => (
        <Shelf
          key={row.id}
          name={row.name}
          titles={row.titles}
          total={row.total}
          onAll={() => router.push(collectionHref(kind, row.id))}
          onPress={open}
        />
      ))}
      {rows.length === 0 && continuing.length === 0 ? (
        <Message
          text={
            kind === "movie"
              ? "Nothing new or popular yet. All lists every movie."
              : "Nothing new or popular yet. All lists every series."
          }
        />
      ) : null}
    </>
  );
}

/** The first title of For you, wide, with its name and line. */
function Featured({ title }: { title: Title }) {
  const line = [title.year, title.genres[0], title.rating?.toFixed(1)].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title.title, line].filter(Boolean).join(", ")}
      onPress={() => router.push(detailsHref(title.kind, title))}
      style={({ pressed }) => [styles.featured, pressed && styles.pressed]}
      testID="featured"
    >
      <Artwork
        url={title.backdropUrl ?? title.posterUrl}
        name={title.title}
        width={780}
        style={styles.featuredArt}
      />
      <Text style={styles.featuredName} numberOfLines={2}>
        {title.title}
      </Text>
      {line ? <Text style={styles.featuredLine}>{line}</Text> : null}
    </Pressable>
  );
}

/** A collection pushed over its tab: a row's All, a genre or a service. */
export function CollectionScreen({ kind, id }: { kind: TitleKind; id: CollectionId }) {
  const made = useCollections(kind, [id]);
  const status = useTitlesStatus(kind);
  useFixedTabBar(true);
  const found = useMemo(
    () => (made ? { name: made.name(id) ?? "", titles: made.list(id) } : null),
    [made, id],
  );
  const open = useCallback((title: Title) => openDetails(title), []);
  if (!found) {
    return (
      <Docked status={status ?? loadingStatus(kind === "movie" ? "movies" : "series")}>
        <PlaceholderGrid
          header={
            <Placeholders style={styles.nameRow}>
              <Shape style={styles.nameShape} />
            </Placeholders>
          }
        />
      </Docked>
    );
  }
  return (
    <Docked status={status}>
      <PosterGrid
        titles={found.titles}
        onPress={open}
        header={<Text style={styles.collectionName}>{found.name}</Text>}
        empty={<Message text="Nothing here now." />}
        testID="collection-grid"
      />
    </Docked>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingBottom: 32 },
  pressed: { opacity: 0.6 },
  gridHead: { marginHorizontal: -16, marginBottom: 4 },
  tiles: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingHorizontal: 16,
    marginTop: 12,
  },
  featured: { marginHorizontal: 16, marginTop: 8 },
  featuredArt: { width: "100%", aspectRatio: 16 / 9, borderRadius: 10 },
  featuredName: { color: colors.text, fontSize: 22, fontWeight: "700", marginTop: 10 },
  featuredLine: { color: colors.dim, fontSize: 13, marginTop: 2 },
  collectionName: { color: colors.text, fontSize: 28, fontWeight: "700", marginBottom: 8 },
  nameRow: { marginBottom: 8 },
  nameShape: { width: "55%", height: 28 },
});
