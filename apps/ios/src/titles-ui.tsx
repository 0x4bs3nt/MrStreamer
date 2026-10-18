import type { Title } from "@mrstreamer/contracts/ondemand";
import { memo, useState, type ReactNode } from "react";
import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Placeholders, Shape, useDockInset } from "./loading.tsx";
import { colors } from "./ui.tsx";

// Movies and series as content: posters, shelves of them, text tabs and grids, on solid true
// black. Pictures are React Native's own Image; a title without one, or whose picture doesn't
// load, shows its name on a tint worked out from it, as the desktop does.

/** A hue from a name, the desktop's `hueOf`, so a title has the same tint everywhere. */
function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

/** TMDB's links at a width fit for the phone; any other link as it is. */
function sized(url: string, width: 154 | 342 | 780 | 1280): string {
  return url.replace(/^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^/]+\//, `$1w${width}/`);
}

/** A picture, or the name on a tint when there is none or it doesn't load. */
export function Artwork({
  url,
  name,
  width,
  style,
  plain = false,
}: {
  url: string | null;
  name: string;
  width: 154 | 342 | 780 | 1280;
  style?: StyleProp<ViewStyle>;
  /** Only the tint, where the name shows beside it. */
  plain?: boolean;
}) {
  // The link that failed: a tile reused for another title tries its own.
  const [failed, setFailed] = useState<string | null>(null);
  const hue = hueOf(name);
  return (
    <View style={[styles.art, { backgroundColor: `hsl(${hue}, 28%, 14%)` }, style]}>
      {plain || (url && url !== failed) ? null : (
        <Text
          style={[styles.artName, { color: `hsl(${hue}, 50%, 82%)` }]}
          numberOfLines={4}
          maxFontSizeMultiplier={1.4}
        >
          {name}
        </Text>
      )}
      {url && url !== failed ? (
        <Image
          source={{ uri: sized(url, width) }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setFailed(url)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

/** How far a title got, as a thin line under its picture. */
export function ProgressLine({ done }: { done: number | null }) {
  if (done === null || !(done > 0)) return null;
  return (
    <View style={styles.track}>
      <View style={[styles.done, { width: `${Math.min(100, Math.round(done * 100))}%` }]} />
    </View>
  );
}

/** The poster width that fits three to a row at the phone's width, smaller on wide screens. */
export function usePosterWidth(columns = 3): number {
  const { width } = useWindowDimensions();
  const fit = Math.floor((width - 32 - (columns - 1) * 10) / columns);
  return Math.min(fit, 160);
}

export const PosterTile = memo(function PosterTile({
  title,
  width,
  line,
  done = null,
  onPress,
  onLongPress,
}: {
  title: Title;
  width: number;
  /** Under the name: the year, or how far it got. */
  line?: string;
  done?: number | null;
  onPress: (title: Title) => void;
  onLongPress?: (title: Title) => void;
}) {
  const shown = line ?? (title.year ? String(title.year) : "");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title.title, shown].filter(Boolean).join(", ")}
      onPress={() => onPress(title)}
      {...(onLongPress ? { onLongPress: () => onLongPress(title) } : {})}
      style={({ pressed }) => [{ width }, pressed && styles.pressed]}
      testID={`title-${title.id}`}
    >
      <Artwork
        url={title.posterUrl}
        name={title.title}
        width={342}
        style={{ width, height: Math.round(width * 1.5), borderRadius: 6 }}
      />
      <ProgressLine done={done} />
      <Text style={styles.caption} numberOfLines={1}>
        {title.title}
      </Text>
      {shown ? (
        <Text style={styles.line} numberOfLines={1}>
          {shown}
        </Text>
      ) : null}
    </Pressable>
  );
});

/** A titled row of posters scrolling sideways, with All when there are more than it shows. */
export function Shelf({
  name,
  titles,
  total,
  onAll,
  onPress,
  onLongPress,
  lines,
  done,
}: {
  name: string;
  titles: readonly Title[];
  total?: number;
  onAll?: () => void;
  onPress: (title: Title) => void;
  onLongPress?: (title: Title) => void;
  lines?: (title: Title) => string | undefined;
  done?: (title: Title) => number | null;
}) {
  const width = Math.min(usePosterWidth(3), 120);
  return (
    <View style={styles.shelf}>
      <Pressable
        accessibilityRole={onAll ? "button" : "header"}
        accessibilityLabel={onAll ? `${name}, all ${total ?? titles.length}` : name}
        disabled={!onAll}
        onPress={onAll}
        style={styles.shelfHead}
      >
        <Text style={styles.shelfName} numberOfLines={1}>
          {name}
        </Text>
        {onAll ? <Text style={styles.chevron}>›</Text> : null}
      </Pressable>
      <FlatList
        horizontal
        data={titles}
        keyExtractor={(title) => title.key}
        renderItem={({ item }) => (
          <PosterTile
            title={item}
            width={width}
            {...(lines ? { line: lines(item) ?? "" } : {})}
            done={done?.(item) ?? null}
            onPress={onPress}
            {...(onLongPress ? { onLongPress } : {})}
          />
        )}
        contentContainerStyle={styles.shelfRow}
        showsHorizontalScrollIndicator={false}
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={3}
      />
    </View>
  );
}

/** A shelf's place while its titles first come: a still heading and a few still posters. */
export function PlaceholderShelf() {
  const width = Math.min(usePosterWidth(3), 120);
  return (
    <Placeholders style={styles.shelf} testID="placeholder-shelf">
      <View style={styles.shelfHead}>
        <Shape style={styles.headShape} />
      </View>
      <View style={[styles.shelfRow, styles.stillRow]}>
        {Array.from({ length: 4 }, (_, index) => (
          <View key={index} style={{ width }}>
            <Shape style={{ width, height: Math.round(width * 1.5), borderRadius: 6 }} />
            <Shape style={styles.captionShape} />
          </View>
        ))}
      </View>
    </Placeholders>
  );
}

/** Text tabs under the title, as the desktop's Movies and Series have them. */
export function TextTabs<T extends string>({
  tabs,
  value,
  onChange,
  lead,
}: {
  tabs: readonly { readonly value: T; readonly label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** A control before the tabs, in the same row, as Live's country. */
  lead?: ReactNode;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.tabs}
      accessibilityRole="tablist"
    >
      {lead}
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.value)}
            style={styles.tab}
            testID={`tab-${tab.value}`}
          >
            <Text style={[styles.tabLabel, selected && styles.tabSelected]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A grid's place while its titles first come: what goes above it, then three rows of posters. */
export function PlaceholderGrid({ header }: { header?: ReactNode }) {
  const width = usePosterWidth(3);
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.grid}
      contentInsetAdjustmentBehavior="automatic"
      scrollEnabled={false}
    >
      {header}
      <Placeholders style={styles.stillGrid} testID="placeholder-grid">
        {Array.from({ length: 9 }, (_, index) => (
          <Shape key={index} style={{ width, height: Math.round(width * 1.5), borderRadius: 6 }} />
        ))}
      </Placeholders>
    </ScrollView>
  );
}

/** A virtualised grid of posters, three to a row, with what goes above it. */
export function PosterGrid({
  titles,
  onPress,
  header,
  empty,
  testID,
}: {
  titles: readonly Title[];
  onPress: (title: Title) => void;
  header?: ReactNode;
  empty?: ReactNode;
  testID?: string;
}) {
  const width = usePosterWidth(3);
  const inset = useDockInset();
  return (
    <FlatList
      style={styles.screen}
      data={titles}
      numColumns={3}
      keyExtractor={(title) => title.key}
      renderItem={({ item }) => <PosterTile title={item} width={width} onPress={onPress} />}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={[styles.grid, { paddingBottom: 24 + inset }]}
      contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={header ? <>{header}</> : undefined}
      ListEmptyComponent={empty ? <>{empty}</> : undefined}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={7}
      removeClippedSubviews
      testID={testID}
    />
  );
}

/** A genre's or service's tile: its most popular title's picture, its name and count. */
export function CollectionTileView({
  name,
  count,
  artworkUrl,
  onPress,
}: {
  name: string;
  count: number;
  artworkUrl: string | null;
  onPress: () => void;
}) {
  const { width } = useWindowDimensions();
  const tile = Math.floor((width - 42) / 2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => [{ width: tile }, pressed && styles.pressed]}
    >
      <Artwork
        url={artworkUrl}
        name={name}
        width={342}
        plain
        style={{ width: tile, height: Math.round((tile * 9) / 16), borderRadius: 6 }}
      />
      <Text style={styles.caption} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.line}>{count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  art: { overflow: "hidden", alignItems: "center", justifyContent: "center", padding: 8 },
  artName: { fontSize: 13, fontWeight: "600", textAlign: "center" },
  pressed: { opacity: 0.6 },
  track: { height: 3, backgroundColor: colors.line, marginTop: 4, borderRadius: 2 },
  done: { height: 3, backgroundColor: colors.text, borderRadius: 2 },
  caption: { color: colors.text, fontSize: 13, marginTop: 6 },
  line: { color: colors.dim, fontSize: 12, marginTop: 1 },
  shelf: { marginTop: 18 },
  shelfHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    minHeight: 32,
  },
  shelfName: { color: colors.text, fontSize: 20, fontWeight: "700", flexShrink: 1 },
  chevron: { color: colors.dim, fontSize: 22, fontWeight: "600" },
  shelfRow: { paddingHorizontal: 16, gap: 10 },
  tabs: { paddingHorizontal: 16, gap: 20 },
  tab: { minHeight: 44, justifyContent: "center" },
  tabLabel: { color: colors.dim, fontSize: 17 },
  tabSelected: { color: colors.text, fontWeight: "700" },
  grid: { paddingHorizontal: 16, paddingBottom: 24, gap: 14 },
  gridRow: { gap: 10 },
  headShape: { width: 120, height: 18 },
  stillRow: { flexDirection: "row", overflow: "hidden" },
  captionShape: { width: "70%", height: 10, marginTop: 8 },
  stillGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, rowGap: 14 },
});
