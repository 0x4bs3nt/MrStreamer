import type { CollectionId, Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { seriesOf } from "@mrstreamer/contracts/ondemand";
import type { IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { describeError } from "./errors.ts";
import { detailsHref, openDetails, resume, useContinueWatching } from "./resume.ts";
import { store, useStore } from "./store.ts";
import { useFixedTabBar } from "./tab-bar.ts";
import {
  collectionOf,
  loadTitles,
  rowsOf,
  tilesOf,
  useMetadataVersion,
  useTitleLists,
} from "./titles.ts";
import { Artwork, CollectionTileView, PosterGrid, Shelf, TextTabs } from "./titles-ui.tsx";
import { colors, Message } from "./ui.tsx";
import { useViewing } from "./viewing.ts";

// Films or Series: the desktop's tabs as text under the title. For you leads with a featured
// title, what is being watched, titles like the last one and the collections that suit the
// viewer's language; New gathers what was added; Genres and Services are tiles; 4K and All are
// virtualised grids. A row's All, a genre or a service opens its collection on the tab's stack.
// Genres, services, popular and top rated come from TMDB, so without its metadata they are left
// out rather than shown empty.

type Tab = "for-you" | "new" | "genres" | "services" | "4k" | "all";

/** Which tab each kind was on, kept while the viewer goes elsewhere and comes back. */
const places = store<Record<TitleKind, Tab>>({ movie: "for-you", series: "for-you" });

export const collectionHref = (kind: TitleKind, id: CollectionId) =>
  `/${kind === "movie" ? "films" : "series"}/collection/${encodeURIComponent(id)}` as const;

/** The Films or Series tab. */
export function TitlesHome({ kind }: { kind: TitleKind }) {
  const lists = useTitleLists();
  if (lists.kind === "idle" || lists.kind === "loading") {
    return <Message text={kind === "movie" ? "Loading films" : "Loading series"} />;
  }
  if (lists.kind === "failed") {
    return (
      <View style={styles.screen}>
        <Message
          text={describeError(lists.error)}
          action={{ label: "Try again", onPress: loadTitles }}
        />
      </View>
    );
  }
  return <Browse index={lists.index} kind={kind} />;
}

function Browse({ index, kind }: { index: IndexedCatalogue; kind: TitleKind }) {
  const metadata = useMetadataVersion();
  const viewing = useViewing();
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

  const built = useMemo(
    () => ({
      forYou: rowsOf(index, kind, "for-you", like),
      fresh: rowsOf(index, kind, "new", null),
      genres: tilesOf(index, kind, "genres"),
      services: tilesOf(index, kind, "services"),
      fourK: collectionOf(index, kind, "4k").titles,
      all: collectionOf(index, kind, "all").titles,
    }),
    // A new metadata version changes what collections hold.
    [index, kind, like, metadata],
  );

  const tabs = [
    { value: "for-you" as const, label: "For you" },
    ...(built.fresh.length > 0 ? [{ value: "new" as const, label: "New" }] : []),
    ...(built.genres.length > 0 ? [{ value: "genres" as const, label: "Genres" }] : []),
    ...(built.services.length > 0 ? [{ value: "services" as const, label: "Services" }] : []),
    ...(built.fourK.length > 0 ? [{ value: "4k" as const, label: "4K" }] : []),
    { value: "all" as const, label: "All" },
  ];
  // A tab that emptied, as before TMDB's metadata arrived, gives way to For you.
  const tab = tabs.some((each) => each.value === chosen) ? chosen : "for-you";
  const grid = tab === "4k" || tab === "all";
  useFixedTabBar(grid);
  const choose = (next: Tab) => places.set((current) => ({ ...current, [kind]: next }));
  const header = <TextTabs tabs={tabs} value={tab} onChange={choose} />;

  if (grid) {
    return (
      <PosterGrid
        key={tab}
        titles={tab === "4k" ? built.fourK : built.all}
        onPress={open}
        header={<View style={styles.gridHead}>{header}</View>}
        empty={<Message text={kind === "movie" ? "No films." : "No series."} />}
        testID={`${kind}-grid`}
      />
    );
  }
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      testID={`${kind}-${tab}`}
    >
      {header}
      {tab === "for-you" ? (
        <ForYou kind={kind} rows={built.forYou} open={open} />
      ) : tab === "new" ? (
        built.fresh.map((row) => (
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
          {(tab === "genres" ? built.genres : built.services).map((tile) => (
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
  rows: ReturnType<typeof rowsOf>;
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
              ? "Nothing new or popular yet. All lists every film."
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
      onPress={() => router.push(detailsHref(title.kind, title.id))}
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
  const lists = useTitleLists();
  const metadata = useMetadataVersion();
  useFixedTabBar(true);
  const found = useMemo(
    () => (lists.kind === "ready" ? collectionOf(lists.index, kind, id) : null),
    [lists, kind, id, metadata],
  );
  const open = useCallback((title: Title) => openDetails(title), []);
  if (!found) return <Message text="Loading" />;
  return (
    <PosterGrid
      titles={found.titles}
      onPress={open}
      header={<Text style={styles.collectionName}>{found.name}</Text>}
      empty={<Message text="Nothing here now." />}
      testID="collection-grid"
    />
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
});
