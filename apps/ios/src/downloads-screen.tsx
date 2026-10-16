import type { Download } from "@mrstreamer/contracts/downloads";
import { formatBytes, t } from "@mrstreamer/core/i18n";
import { runtime, timeLeftOf } from "@mrstreamer/core/viewing/continue";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { memo, useMemo, useRef, type ReactNode } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  actionsOf,
  episodeLine,
  statusLine,
  transferred,
  type DownloadAction,
  showActions,
} from "./download-controls.tsx";
import { playDownload, useDownloads } from "./downloads.ts";
import { Glass } from "./glass.tsx";
import { Artwork } from "./titles-ui.tsx";
import { colors, Notice } from "./ui.tsx";

// Downloads as one list: the queue in the order added, then the copies on this iPhone, newest
// first, as the desktop's page. Empty sections are left out; how much the copies take and what is
// free closes the list. Each row has one trailing glass button for what fits its state, the
// rest in its long-press sheet, a swipe to the left and VoiceOver's actions. A copy plays offline
// when its row is tapped; queue rows don't answer a tap, so a stray touch cancels nothing.
// Home pushes it with providers saved, and Connect without any, as copies play with none.

/** A finished copy, or one whose file went, rather than something in the queue. */
const onPhone = (item: Download) =>
  item.status.kind === "complete" || item.status.kind === "missing";

interface Section {
  readonly key: "queue" | "copies";
  readonly title: string;
  readonly data: readonly Download[];
}

export function DownloadsScreen() {
  const list = useDownloads();
  const sections = useMemo(
    () =>
      (
        [
          { key: "queue", title: "Queue", data: list.items.filter((item) => !onPhone(item)) },
          { key: "copies", title: "On this iPhone", data: list.items.filter(onPhone) },
        ] satisfies readonly Section[]
      ).filter((section) => section.data.length > 0),
    [list.items],
  );
  const storage = [
    list.bytes > 0 ? `${formatBytes(list.bytes)} on this iPhone` : null,
    list.free !== null ? t("{size} free", { size: formatBytes(list.free) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SectionList<Download, Section>
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <Text style={styles.section} accessibilityRole="header">
          {section.title}
        </Text>
      )}
      renderSectionFooter={({ section }) =>
        section.key === "queue" ? (
          <Text style={styles.note}>Downloads continue only while the app is open.</Text>
        ) : null
      }
      renderItem={({ item }) => <Row item={item} />}
      ItemSeparatorComponent={Separator}
      ListEmptyComponent={
        <Notice
          failure={{
            headline: "Nothing downloaded yet.",
            advice: "Download a movie or an episode from its details.",
          }}
        />
      }
      {...(sections.length > 0 && storage
        ? { ListFooterComponent: <Text style={styles.note}>{storage}</Text> }
        : {})}
      contentContainerStyle={styles.content}
      testID="downloads"
    />
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

/** The trailing button's symbol and label for the first action of each state. */
const PRIMARY: Record<Download["status"]["kind"], { symbol: SFSymbol; label: string }> = {
  queued: { symbol: "xmark", label: "Cancel download" },
  waiting: { symbol: "xmark", label: "Cancel download" },
  transferring: { symbol: "xmark", label: "Cancel download" },
  failed: { symbol: "arrow.clockwise", label: "Retry" },
  complete: { symbol: "play.fill", label: "Play offline" },
  missing: { symbol: "trash", label: "Delete download" },
};

/** What a swipe to the left reveals: the state's destructive action, in a word. */
const SWIPED: Record<Download["status"]["kind"], string> = {
  queued: "Cancel",
  waiting: "Cancel",
  transferring: "Cancel",
  failed: "Remove",
  complete: "Delete",
  missing: "Delete",
};

const Row = memo(function Row({ item }: { item: Download }) {
  const { fontScale } = useWindowDimensions();
  const { status } = item;
  const copy = onPhone(item);
  const actions = actionsOf(item);
  const destructive = actions.find((action) => action.destructive);
  const sized = [
    copy && item.duration ? runtime(item.duration) : null,
    item.size ? formatBytes(item.size) : null,
  ];
  const facts = [episodeLine(item) ?? item.year, ...sized].filter(Boolean).join(" · ");
  const line = statusLine(item);
  const done = transferred(item);
  const watched =
    status.kind === "complete" &&
    item.progress &&
    item.progress.duration > 0 &&
    !isFinished(item.progress.position, item.progress.duration)
      ? item.progress
      : null;
  const left = watched ? timeLeftOf({ ...watched, finished: false }) : null;
  const kept = copy && !item.subscription ? "Provider removed, copy kept" : null;
  const red = status.kind === "failed" || status.kind === "missing";
  const primary = PRIMARY[status.kind];
  // One element for VoiceOver: "Paper Harbor, season 1 episode 3, The Tide Table, 42%, ...".
  const spoken = [
    item.name,
    spokenEpisode(item),
    item.title.kind === "movie" ? item.year : item.episodeName,
    ...sized,
    line.replaceAll(" · ", ", "),
    left,
    kept,
  ]
    .filter(Boolean)
    .join(", ");
  const act = (event: AccessibilityActionEvent) => {
    const { actionName } = event.nativeEvent;
    if (actionName === "activate") {
      if (status.kind === "complete") playDownload(item.id);
      return;
    }
    actions.find((action) => action.label === actionName)?.run();
  };
  return (
    <Swipe label={SWIPED[status.kind]} action={destructive}>
      <Pressable
        accessible
        accessibilityLabel={spoken}
        {...(status.kind === "complete" ? { accessibilityRole: "button" as const } : {})}
        accessibilityActions={[
          ...(status.kind === "complete" ? [{ name: "activate" }] : []),
          ...actions.map((action) => ({ name: action.label, label: action.label })),
        ]}
        onAccessibilityAction={act}
        // A queue row doesn't answer a tap: only its button and sheet change it.
        {...(status.kind === "complete" ? { onPress: () => playDownload(item.id) } : {})}
        onLongPress={() => showActions(item, actions)}
        style={({ pressed }) => [
          styles.row,
          fontScale > 1.2 && styles.top,
          pressed && status.kind === "complete" && styles.pressed,
        ]}
        testID={`download-${item.id}`}
      >
        <Artwork url={item.posterUrl} name={item.name} width={154} style={styles.poster} />
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={2}>
            {item.name}
          </Text>
          {facts ? (
            <Text style={styles.facts} numberOfLines={2}>
              {facts}
            </Text>
          ) : null}
          {done !== null ? <Bar done={done} style={styles.transfer} /> : null}
          {watched ? (
            <View style={styles.progress}>
              <Bar done={watched.position / watched.duration} style={styles.watched} />
              {left ? <Text style={styles.dim}>{left}</Text> : null}
            </View>
          ) : null}
          {line ? (
            <Text
              style={[styles.status, red && styles.red, status.kind === "queued" && styles.dim]}
            >
              {line}
            </Text>
          ) : null}
          {kept ? <Text style={styles.dim}>{kept}</Text> : null}
        </View>
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => actions[0]?.run()}
          style={({ pressed }) => [styles.target, pressed && styles.pressed]}
          testID={`download-${item.id}-${primary.label}`}
        >
          <Glass style={styles.circle}>
            <SymbolView
              name={primary.symbol}
              size={15}
              tintColor={red ? "#FF453A" : "#FFFFFF"}
              weight="semibold"
            />
          </Glass>
        </Pressable>
      </Pressable>
    </Swipe>
  );
});

/** "season 1 episode 3", or "special 3", as VoiceOver says an episode. */
function spokenEpisode({ title }: Download): string | null {
  if (title.kind !== "episode") return null;
  return title.season === 0
    ? `special ${title.episode}`
    : `season ${title.season} episode ${title.episode}`;
}

/** A still line of how far something got. */
function Bar({ done, style }: { done: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.bar, style]}>
      <View style={[styles.barDone, { width: `${Math.min(100, Math.round(done * 100))}%` }]} />
    </View>
  );
}

/** How far the row slides to show its swiped action. */
const REVEAL = 92;

/**
 * A row that slides left under the finger to show `action` in red, as iOS's lists do. It follows
 * the finger and settles open or shut; tapping the red part runs the action, which asks first
 * where it would lose a download.
 */
function Swipe({
  label,
  action,
  children,
}: {
  label: string;
  action: DownloadAction | undefined;
  children: ReactNode;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const settle = (to: number) => {
    open.current = to !== 0;
    Animated.timing(x, { toValue: to, duration: 180, useNativeDriver: true }).start();
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, move) =>
        Math.abs(move.dx) > 12 && Math.abs(move.dx) > Math.abs(move.dy) * 1.5,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, move) =>
        x.setValue(Math.min(0, Math.max(-REVEAL * 1.3, (open.current ? -REVEAL : 0) + move.dx))),
      onPanResponderRelease: (_, move) =>
        settleRef.current((open.current ? -REVEAL : 0) + move.dx < -REVEAL / 2 ? -REVEAL : 0),
      onPanResponderTerminate: () => settleRef.current(open.current ? -REVEAL : 0),
    }),
  ).current;
  if (!action) return children;
  return (
    <View style={styles.swipe}>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => {
          settle(0);
          action.run();
        }}
        style={styles.reveal}
        testID="download-swiped"
      >
        <Text style={styles.revealLabel}>{label}</Text>
      </Pressable>
      <Animated.View
        style={[styles.slide, { transform: [{ translateX: x }] }]}
        {...pan.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

/**
 * The row Settings and Connect open Downloads with: its name, what the copies take ("None"
 * without any) and a chevron.
 */
export function DownloadsLink({ onPress }: { onPress: () => void }) {
  const { bytes } = useDownloads();
  const used = bytes > 0 ? formatBytes(bytes) : "None";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Downloads, ${used}`}
      onPress={onPress}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
      testID="downloads-link"
    >
      <Text style={styles.linkLabel}>Downloads</Text>
      <View style={styles.linkValue}>
        <Text style={styles.linkUsed}>{used}</Text>
        <SymbolView name="chevron.right" size={14} tintColor={colors.dim} weight="semibold" />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingBottom: 32 },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6,
  },
  note: { color: colors.dim, fontSize: 13, paddingHorizontal: 16, paddingTop: 8 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 72 },
  swipe: { overflow: "hidden" },
  slide: { backgroundColor: "#000000" },
  reveal: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: REVEAL,
    backgroundColor: "#FF453A",
    alignItems: "center",
    justifyContent: "center",
  },
  revealLabel: { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  top: { alignItems: "flex-start" },
  pressed: { opacity: 0.5 },
  poster: { width: 44, height: 66, borderRadius: 6 },
  text: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17, fontWeight: "600" },
  facts: { color: colors.dim, fontSize: 15 },
  status: { color: colors.text, fontSize: 15, fontVariant: ["tabular-nums"] },
  red: { color: "#FF453A" },
  dim: { color: colors.dim, fontSize: 13 },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" },
  barDone: { height: 4, backgroundColor: "#FFFFFF" },
  transfer: { marginTop: 6, marginBottom: 4 },
  progress: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  watched: { width: 72 },
  target: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  circle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
    paddingVertical: 10,
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  linkLabel: { color: colors.text, fontSize: 17, flexShrink: 1 },
  linkValue: { flexDirection: "row", alignItems: "center", gap: 6 },
  linkUsed: { color: colors.dim, fontSize: 17 },
});
