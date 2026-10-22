import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { memo, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { playChannel, useCatalogue } from "./account.ts";
import { appError, describeError } from "./errors.ts";
import {
  currentFavourites,
  sameFavourites,
  starChannel,
  useFavourites,
  type Favourite,
  type FavouriteList,
  type Hidden,
  type Unavailable,
} from "./favourites.ts";
import type { Channel } from "./library.ts";
import { useDockInset } from "./loading.tsx";
import { channelStatus, usePlayback } from "./playback.ts";
import { ChannelLogo, colors, Notice, TextButton, useRowHeight } from "./ui.tsx";
import { reorderFavourites } from "./viewing.ts";

// Every favourite, of every provider, in the order the viewer gave them: pushed on Live from its
// Favourites row, and on Home from its row's heading. A row plays its channel in Watch; its star
// takes it out of the favourites and plays nothing. Edit arranges the rows with each one's Move up
// and Move down, or VoiceOver's actions; Save sends the order, Cancel and leaving the list throw it
// away. Favourites that don't show (favourites.ts) are counted under the rows by provider, keep
// their places, and open nothing. Save, and Try again after a write viewing.json didn't take, send
// the order only while the favourites show the rows it was arranged from, as the record, the
// providers and their channels stand then: one a list or a password changed meanwhile is refused
// with nothing moved, as is one whose list was closed. A refused write keeps the draft.

/** What a provider's favourites that don't show say, after its name. */
const WHY: Record<Unavailable, string> = {
  loading: "channels still loading",
  failed: "channels didn't load",
  "needs-secret": "password needed in Settings",
  "not-listed": "no longer listed",
};

/** "2 saved from Home: password needed in Settings", or "Saved from Home: …" without a count. */
const hiddenLine = ({ label, why, count }: Hidden) =>
  `${count === null ? "Saved" : `${count} saved`} from ${label}: ${WHY[why]}`;

/** Nothing was moved: the favourites no longer show the rows the order was made of. */
const changedAlert = () =>
  Alert.alert(
    "Favourites changed",
    "Nothing was moved. They changed while you arranged them: edit them as they are now.",
  );

/** The rows as being arranged, from the favourites they were arranged from. */
interface Draft {
  readonly original: FavouriteList["original"];
  readonly listed: readonly Favourite[];
  readonly order: readonly Favourite[];
  readonly saving: boolean;
}

/** Live's row that opens every favourite, with how many open. */
export function FavouritesEntry() {
  const favourites = useFavourites();
  const count = favourites?.shown.length ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Favourites, ${count}` : "Favourites"}
      onPress={() => router.push("/live/favourites")}
      style={({ pressed }) => [styles.entry, pressed && styles.pressed]}
      testID="live-favourites"
    >
      <Text style={styles.entryName}>Favourites</Text>
      {count > 0 ? <Text style={styles.entryCount}>{count}</Text> : null}
      <View style={styles.spacer} />
      <SymbolView name="chevron.right" size={13} tintColor={colors.text} weight="semibold" />
    </Pressable>
  );
}

export function FavouritesScreen() {
  const favourites = useFavourites();
  const catalogue = useCatalogue();
  const inset = useDockInset();
  const height = useRowHeight();
  const playing = channelStatus(usePlayback().phase);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The draft on show, for an answer or a Try again that comes later; none once the list closed.
  const open = useRef<Draft | null>(null);
  useEffect(() => {
    open.current = draft;
  }, [draft]);
  useEffect(() => () => void (open.current = null), []);
  if (!favourites) return <View style={styles.screen} />;
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const placeOf = (channel: Channel) => library?.placeOf.get(channel.key) ?? "";
  const rows = draft?.order ?? favourites.shown;

  const edit = () =>
    setDraft({
      original: favourites.original,
      listed: favourites.shown,
      order: favourites.shown,
      saving: false,
    });
  const move = (favourite: Favourite, by: number) => {
    if (!draft || draft.saving) return;
    const from = draft.order.indexOf(favourite);
    const to = Math.min(Math.max(from + by, 0), draft.order.length - 1);
    if (from < 0 || to === from) return;
    const order = draft.order.toSpliced(from, 1).toSpliced(to, 0, favourite);
    setDraft({ ...draft, order });
    AccessibilityInfo.announceForAccessibility(
      `${favourite.channel.title}, ${to + 1} of ${order.length}`,
    );
  };
  const save = (from: Draft) => {
    if (open.current !== from) {
      Alert.alert("The order wasn't saved", "Nothing was moved: the list was closed.");
      return;
    }
    if (from.order.every((each, at) => each === from.listed[at])) return setDraft(null);
    // As they stand now, not as this screen last drew them.
    if (!sameFavourites({ original: from.original, shown: from.listed }, currentFavourites())) {
      setDraft(null);
      return changedAlert();
    }
    const sent = { ...from, saving: true };
    setDraft(sent);
    open.current = sent;
    reorderFavourites({
      original: from.original,
      order: from.order.map((each) => each.saved),
    }).then(
      () => {
        if (open.current === sent) setDraft(null);
      },
      (cause: unknown) => {
        const error = appError(cause);
        // The list closed meanwhile: there is no draft left to send again.
        if (open.current !== sent) {
          Alert.alert("The order wasn't saved", "Nothing was moved.");
          return;
        }
        if (error.kind === "favourites-changed") {
          setDraft(null);
          return changedAlert();
        }
        const kept = { ...from, saving: false };
        setDraft(kept);
        open.current = kept;
        Alert.alert("Couldn't save the order", describeError(error), [
          { text: "Cancel", style: "cancel" },
          { text: "Try again", onPress: () => save(kept) },
        ]);
      },
    );
  };

  const empty = favourites.shown.length === 0 && favourites.hidden.length === 0;
  return (
    <FlatList
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      data={rows}
      keyExtractor={(favourite) => favourite.channel.key}
      // Rows draw again as editing starts, saves or ends, and as what plays changes.
      extraData={`${draft ? (draft.saving ? "saving" : "editing") : "list"} ${playing?.id ?? ""} ${playing?.word ?? ""}`}
      renderItem={({ item, index }) =>
        draft ? (
          <ArrangedRow
            favourite={item}
            position={index}
            count={rows.length}
            height={height}
            disabled={draft.saving}
            onMove={move}
          />
        ) : (
          <FavouriteRow
            favourite={item}
            detail={item.channel.key === playing?.id ? playing.word : placeOf(item.channel)}
            height={height}
            onPress={(channel) => playChannel(channel, placeOf(channel), { watch: true })}
          />
        )
      }
      ListHeaderComponent={
        rows.length > 1 || draft ? (
          <View style={styles.bar}>
            {draft ? (
              <>
                <TextButton
                  label="Cancel"
                  onPress={() => setDraft(null)}
                  disabled={draft.saving}
                  testID="favourites-cancel"
                />
                <TextButton
                  label="Save"
                  onPress={() => save(draft)}
                  disabled={draft.saving}
                  testID="favourites-save"
                />
              </>
            ) : (
              <>
                <View />
                <TextButton label="Edit" onPress={edit} testID="favourites-edit" />
              </>
            )}
          </View>
        ) : undefined
      }
      ListFooterComponent={
        favourites.hidden.length > 0 ? (
          <View style={styles.hidden} accessible testID="favourites-hidden">
            {favourites.hidden.map((each) => (
              <Text key={each.subscriptionId} style={styles.hiddenLine}>
                {hiddenLine(each)}
              </Text>
            ))}
          </View>
        ) : undefined
      }
      ListEmptyComponent={
        empty ? (
          <Notice failure={{ headline: "No favourites yet.", advice: "Star a channel in Live." }} />
        ) : undefined
      }
      contentContainerStyle={{ paddingBottom: 32 + inset }}
      testID="favourites"
    />
  );
}

const FavouriteRow = memo(function FavouriteRow({
  favourite,
  detail,
  height,
  onPress,
}: {
  favourite: Favourite;
  detail: string;
  height: number;
  onPress: (channel: Channel) => void;
}) {
  const { channel } = favourite;
  const act = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "activate") onPress(channel);
    if (nativeEvent.actionName === "unstar") starChannel(channel, false);
  };
  return (
    <View style={[styles.row, { height }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={channel.title}
        accessibilityHint={detail}
        accessibilityActions={[
          { name: "activate" },
          { name: "unstar", label: "Remove from Favourites" },
        ]}
        onAccessibilityAction={act}
        onPress={() => onPress(channel)}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        testID={`favourite-${channel.key}`}
      >
        <Names channel={channel} detail={detail} />
      </Pressable>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => starChannel(channel, false)}
        style={({ pressed }) => [styles.target, pressed && styles.pressed]}
        testID={`favourite-${channel.key}-star`}
      >
        <SymbolView name="star.fill" size={18} tintColor={colors.text} weight="semibold" />
      </Pressable>
    </View>
  );
});

/** A row being arranged: no playing, with Move up and Move down. */
function ArrangedRow({
  favourite,
  position,
  count,
  height,
  disabled,
  onMove,
}: {
  favourite: Favourite;
  position: number;
  count: number;
  height: number;
  disabled: boolean;
  onMove: (favourite: Favourite, by: number) => void;
}) {
  const { channel } = favourite;
  const first = position === 0;
  const last = position === count - 1;
  const act = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "up") onMove(favourite, -1);
    if (nativeEvent.actionName === "down") onMove(favourite, 1);
  };
  return (
    <View style={[styles.row, { height }]}>
      <View
        accessible
        accessibilityLabel={`${channel.title}, ${position + 1} of ${count}`}
        accessibilityActions={[
          ...(first || disabled ? [] : [{ name: "up", label: "Move up" }]),
          ...(last || disabled ? [] : [{ name: "down", label: "Move down" }]),
        ]}
        onAccessibilityAction={act}
        style={styles.main}
        testID={`arranged-${channel.key}`}
      >
        <Names channel={channel} detail="" />
      </View>
      <Move
        symbol="chevron.up"
        label={`Move ${channel.title} up`}
        disabled={first || disabled}
        onPress={() => onMove(favourite, -1)}
        testID={`arranged-${channel.key}-up`}
      />
      <Move
        symbol="chevron.down"
        label={`Move ${channel.title} down`}
        disabled={last || disabled}
        onPress={() => onMove(favourite, 1)}
        testID={`arranged-${channel.key}-down`}
      />
    </View>
  );
}

function Move({
  symbol,
  label,
  disabled,
  onPress,
  testID,
}: {
  symbol: "chevron.up" | "chevron.down";
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      // VoiceOver moves a row by its actions instead.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.target, (pressed || disabled) && styles.pressed]}
      testID={testID}
    >
      <SymbolView name={symbol} size={17} tintColor={colors.text} weight="semibold" />
    </Pressable>
  );
}

function Names({ channel, detail }: { channel: Channel; detail: string }) {
  const tags = channel.tags.join(" ");
  return (
    <>
      <ChannelLogo channel={channel} style={styles.mark} />
      <View style={styles.names}>
        <Text style={styles.title} numberOfLines={1}>
          {channel.title}
          {tags ? <Text style={styles.tags}>{`  ${tags}`}</Text> : null}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  pressed: { opacity: 0.5 },
  spacer: { flex: 1 },
  entry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  entryName: { color: colors.text, fontSize: 17, fontWeight: "600" },
  entryCount: { color: colors.dim, fontSize: 17 },
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 4 },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, alignSelf: "stretch" },
  mark: { width: 56, height: 36 },
  names: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17 },
  tags: { color: colors.dim, fontSize: 13 },
  detail: { color: colors.dim, fontSize: 13, marginTop: 2 },
  target: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  hidden: { paddingHorizontal: 16, paddingTop: 16, gap: 4 },
  hiddenLine: { color: colors.text, fontSize: 15 },
});
