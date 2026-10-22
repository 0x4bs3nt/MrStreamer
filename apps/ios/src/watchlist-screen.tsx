import { SymbolView } from "expo-symbols";
import { memo, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { members, useRoster } from "./account.ts";
import { appError, describeError } from "./errors.ts";
import { openDetails } from "./resume.ts";
import { named, titleLists, titlesWorkedOut, useMetadataVersion, useTitleLists } from "./titles.ts";
import { Artwork } from "./titles-ui.tsx";
import { colors, Notice } from "./ui.tsx";
import {
  currentWatchlist,
  removeEntry,
  useWatchlist,
  watchlistRows,
  type Unlisted,
  type WatchlistOrder,
  type WatchlistRow,
} from "./watchlist.ts";

// The whole watchlist, pushed on Home: every saved movie and series as a compact row, the newest
// saved first or by name. A row the lists have opens its details; one they don't shows what was
// saved and why it isn't there, and opens nothing. Each row's ellipsis button, its long press
// and VoiceOver's actions offer Details where there are any and Remove, as a system sheet. Which
// entry a row is, where it stands and what Remove takes out are the watchlist's (watchlist.ts).

const ORDERS: readonly { readonly order: WatchlistOrder; readonly label: string }[] = [
  { order: "newest", label: "Newest" },
  { order: "name", label: "A–Z" },
];
const labelOf = (order: WatchlistOrder) => ORDERS.find((each) => each.order === order)?.label ?? "";

/** Why a row isn't in the lists, under its name. */
const UNLISTED: Record<Unlisted, string> = {
  loading: "Lists still loading",
  failed: "Lists didn't load",
  "needs-secret": "Password needed in Settings",
  "not-listed": "No longer listed",
};

const REMOVE = "Remove from Watchlist";

/** The order chosen, kept while the app runs. */
let kept: WatchlistOrder = "newest";

export function WatchlistScreen() {
  const list = useWatchlist();
  const lists = useTitleLists();
  const roster = useRoster();
  const metadata = useMetadataVersion();
  const [order, setOrder] = useState(kept);
  const index = lists.kind === "ready" ? lists.index : null;
  const members = roster.kind === "ready" ? roster.members : null;
  // Read as the lists or the subscriptions change, which draw this again.
  const complete = titlesWorkedOut();
  const rows = useMemo(
    () => watchlistRows(list, { index, complete, members: members ?? [], named }, order),
    // A new metadata version renames titles.
    [list, index, complete, members, order, metadata],
  );
  const choose = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...ORDERS.map((each) => each.label), "Cancel"],
        cancelButtonIndex: ORDERS.length,
      },
      (at) => {
        const chosen = ORDERS[at]?.order;
        if (!chosen) return;
        kept = chosen;
        setOrder(chosen);
      },
    );
  return (
    <FlatList
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => <Row row={item} />}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={
        rows.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sort, ${labelOf(order)}`}
            onPress={choose}
            style={({ pressed }) => [styles.sort, pressed && styles.pressed]}
            testID="watchlist-sort"
          >
            <Text style={styles.sortLabel}>{labelOf(order)}</Text>
            <SymbolView name="chevron.down" size={13} tintColor={colors.text} weight="semibold" />
          </Pressable>
        ) : undefined
      }
      ListEmptyComponent={
        <Notice
          failure={{
            headline: "Nothing saved yet.",
            advice: "Save a movie or series from its details.",
          }}
        />
      }
      contentContainerStyle={styles.content}
      testID="watchlist"
    />
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const Row = memo(function Row({ row }: { row: WatchlistRow }) {
  const { fontScale } = useWindowDimensions();
  const facts = [row.kind === "movie" ? "Movie" : "Series", row.year].filter(Boolean).join(" · ");
  const note = row.unlisted ? UNLISTED[row.unlisted] : null;
  const { title } = row;
  const act = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "activate" && title) openDetails(title);
    if (nativeEvent.actionName === "remove") remove(row);
  };
  return (
    <View style={[styles.row, fontScale > 1.2 && styles.top]}>
      <Pressable
        accessible
        accessibilityLabel={[row.name, facts, note].filter(Boolean).join(", ")}
        {...(title ? { accessibilityRole: "button" as const } : {})}
        accessibilityActions={[
          ...(title ? [{ name: "activate" }] : []),
          { name: "remove", label: REMOVE },
        ]}
        onAccessibilityAction={act}
        // A row the lists don't have opens nothing: only Remove applies to it.
        {...(title ? { onPress: () => openDetails(title) } : {})}
        onLongPress={() => showActions(row)}
        style={({ pressed }) => [styles.main, pressed && title && styles.pressed]}
        testID={`watchlist-${row.key}`}
      >
        <Artwork url={title?.posterUrl ?? null} name={row.name} width={154} style={styles.poster} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2}>
            {row.name}
          </Text>
          <Text style={styles.facts} numberOfLines={1}>
            {facts}
          </Text>
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => showActions(row)}
        style={({ pressed }) => [styles.target, pressed && styles.pressed]}
        testID={`watchlist-${row.key}-more`}
      >
        <SymbolView name="ellipsis" size={17} tintColor={colors.text} weight="semibold" />
      </Pressable>
    </View>
  );
});

/** Details where the lists have the row's title, and Remove, as a system sheet. */
function showActions(row: WatchlistRow) {
  const { title } = row;
  const options = [...(title ? ["Details"] : []), REMOVE, "Cancel"];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: row.name,
      options,
      destructiveButtonIndex: options.indexOf(REMOVE),
      cancelButtonIndex: options.length - 1,
    },
    (at) => {
      // Answered later: the row as it stands then, which may have lost its provider meanwhile.
      const now = options[at] === "Details" ? rowNow(row.key)?.title : null;
      if (now) openDetails(now);
      if (options[at] === REMOVE) remove(row);
    },
  );
}

/** Row `key` as the watchlist, the lists and the providers stand now. */
function rowNow(key: string): WatchlistRow | undefined {
  const lists = titleLists();
  return watchlistRows(
    currentWatchlist(),
    {
      index: lists.kind === "ready" ? lists.index : null,
      complete: titlesWorkedOut(),
      members: members(),
      named,
    },
    "newest",
  ).find((row) => row.key === key);
}

/**
 * Takes the row's entry out as the watchlist stands now. When the file won't take it, the row
 * stays and says why, with Try again.
 */
function remove(row: WatchlistRow) {
  try {
    removeEntry(row.entry);
  } catch (cause) {
    Alert.alert(`Couldn't remove ${row.name}`, describeError(appError(cause)), [
      { text: "Cancel", style: "cancel" },
      { text: "Try again", onPress: () => remove(row) },
    ]);
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingBottom: 32 },
  sort: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-end",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  sortLabel: { color: colors.text, fontSize: 17 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 72 },
  row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 4 },
  top: { alignItems: "flex-start" },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  pressed: { opacity: 0.5 },
  poster: { width: 44, height: 66, borderRadius: 6 },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  facts: { color: colors.dim, fontSize: 15 },
  note: { color: colors.dim, fontSize: 13, marginTop: 2 },
  target: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
