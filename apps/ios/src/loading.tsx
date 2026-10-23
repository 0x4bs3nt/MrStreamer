import { useIsFocused } from "expo-router";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Loadable, Member } from "./account.ts";
import { Glass, IconButton, useMotionAllowed } from "./glass.tsx";
import { usePlayback } from "./playback.ts";
import {
  dismissProviderNotice,
  useProviderNotices,
  type ProviderFailureKind,
} from "./provider-notice.ts";
import { store, useStore } from "./store.ts";
import { colors, TextButton } from "./ui.tsx";

// How screens show that something loads or failed to, all from the subscriptions'
// lists as account.ts and titles.ts keep them: nothing here reads, retries or times anything.
//
// Content that is missing gets still shapes where it will go, a few, never a count of results.
// While the viewer sees them (the screen in front, Watch closed, the app active) and iOS has said
// Reduce Motion is off, a soft band crosses each shape about once every 2.7 seconds, one clock per
// group of shapes on the native driver. What loads or failed is a line of text in glass
// at the bottom of the screen (`Docked`), over content that stays usable and scrolls clear of it;
// the whole line takes at most 40% of the height its host measures and scrolls beyond that.
// Search leads its results with the line instead where that share can't show a whole line.
// Provider failures over usable lists are compact notices; closing one acknowledges that incident.
// Missing/empty lists keep their explanation and recovery inline, independent of acknowledgement.

/** A button on the status line. */
export interface Action {
  readonly label: string;
  readonly onPress: () => void;
}

/** What the status line says, and what it offers. */
export interface Status {
  readonly text: string;
  readonly actions?: readonly Action[];
  /** How many providers are in, as a share, where the screen knows the count. */
  readonly progress?: number;
  /** VoiceOver reads it out when its words change; transient lines, as Searching, are not. */
  readonly announce?: boolean;
  /** Provider failures over usable lists. Resolved against the shared incident owner. */
  readonly providerFailures?: {
    readonly failures: readonly {
      readonly id: string;
      readonly label: string;
      readonly kind: ProviderFailureKind;
    }[];
    readonly settings: () => void;
  };
  readonly dismiss?: Action;
  /** Missing/empty lists keep their explanation and recovery in the screen's layout. */
  readonly inline?: boolean;
}

type Verb = "stale" | "failed" | "loading";

/** Failures first, so Retry sits beside what it retries. */
const VERBS: readonly Verb[] = ["stale", "failed", "loading"];

const sentence = (verb: Verb, what: string, from: readonly string[], several: boolean) => {
  const providers = new Intl.ListFormat("en", { type: "conjunction" }).format(from);
  switch (verb) {
    case "stale":
      return `Couldn't update ${what} from ${providers}. Showing the last ${several ? "lists" : "list"}.`;
    case "failed":
      return `Couldn't load ${what} from ${providers}.`;
    case "loading":
      return `Loading ${what} from ${providers}.`;
  }
};

/**
 * A list's state in words: nothing before it, or the last one kept after it failed. A list that
 * loads again while its last one shows, at launch or on Retry, says nothing: what shows is usable.
 */
function verbOf(list: Loadable<unknown>): Verb | null {
  switch (list.kind) {
    case "idle":
      return "loading";
    case "loading":
      return list.last ? null : "loading";
    case "failed":
      return list.last ? "stale" : "failed";
    case "ready":
      return null;
  }
}

/**
 * The status line for the lists a screen shows, or null when every provider's are in or show
 * their last list while they load again: what loads for the first time or failed, by provider,
 * providers in the same state named together. Over usable lists, failure metadata becomes a compact
 * notice through `useProviderStatus`. Empty/first-load failures keep Retry and Settings inline.
 */
export function libraryStatus(
  members: readonly Member[],
  shows: {
    readonly channels?: boolean;
    readonly titles?: boolean;
    readonly retry: (subscriptionId: string) => void;
    readonly settings: () => void;
  },
): Status | null {
  const groups = new Map<Verb, Map<string, string[]>>();
  const passwords: string[] = [];
  const failed: string[] = [];
  const failures: { id: string; label: string; kind: ProviderFailureKind }[] = [];

  for (const member of members) {
    if (member.needsSecret) {
      passwords.push(`Enter the password for ${member.label} in Settings.`);
      failures.push({ id: member.entry.id, label: member.label, kind: "password" });
      continue;
    }
    const lists = [
      ...(shows.channels ? [["channels", member.live] as const] : []),
      ...(shows.titles ? [["movies and series", member.titles] as const] : []),
    ];
    const byVerb = new Map<Verb, string[]>();
    for (const [noun, list] of lists) {
      const verb = verbOf(list);
      if (verb) byVerb.set(verb, [...(byVerb.get(verb) ?? []), noun]);
    }
    if (byVerb.has("stale") || byVerb.has("failed")) {
      failures.push({ id: member.entry.id, label: member.label, kind: "unavailable" });
    }
    for (const [verb, nouns] of byVerb) {
      const what = nouns.length > 1 ? "channels, movies and series" : nouns[0]!;
      const group = groups.get(verb) ?? new Map<string, string[]>();
      group.set(what, [...(group.get(what) ?? []), member.label]);
      groups.set(verb, group);
      if (verb === "stale" || verb === "failed") failed.push(member.entry.id);
    }
  }
  const sentences = [
    ...VERBS.flatMap((verb) =>
      [...(groups.get(verb) ?? [])].map(([what, from]) =>
        sentence(verb, what, from, from.length > 1 || what.includes(",")),
      ),
    ),
    ...passwords,
  ];
  if (sentences.length === 0) return null;
  const hasContent =
    failures.length > 0 &&
    members.some((member) => {
      const live =
        member.live.kind === "ready"
          ? member.live.value
          : member.live.kind === "idle"
            ? null
            : member.live.last;
      const titles =
        member.titles.kind === "ready"
          ? member.titles.value
          : member.titles.kind === "idle"
            ? null
            : member.titles.last;
      return (
        (shows.channels && !!live?.channels.length) ||
        (shows.titles && !!titles && (titles.movies.length > 0 || titles.series.length > 0))
      );
    });
  if (failures.length > 0 && hasContent) {
    return {
      text: [...(groups.get("loading") ?? [])]
        .map(([what, from]) =>
          sentence("loading", what, from, from.length > 1 || what.includes(",")),
        )
        .join(" "),
      providerFailures: { failures, settings: shows.settings },
    };
  }
  const ids = [...new Set(failed)];
  return {
    text: sentences.join(" "),
    inline: failures.length > 0,
    actions: [
      ...(ids.length > 0 ? [{ label: "Retry", onPress: () => ids.forEach(shows.retry) }] : []),
      ...(failures.length > 0 ? [{ label: "Settings", onPress: shows.settings }] : []),
    ],
  };
}

/** Resolve provider notices before measuring or announcing a composed status, as Search does. */
export function useProviderStatus(status: Status | null): Status | null {
  const incidents = useProviderNotices();
  if (!status?.providerFailures) return status;
  const { providerFailures, ...normal } = status;
  const visible = providerFailures.failures.flatMap((failure) => {
    const incident = incidents.get(failure.id);
    return incident?.kind === failure.kind && !incident.acknowledged
      ? [{ ...failure, token: incident.token }]
      : [];
  });
  if (visible.length === 0) {
    return normal.text || normal.progress !== undefined || normal.actions?.length ? normal : null;
  }
  const words = (["unavailable", "password"] as const).flatMap((kind) => {
    const names = visible
      .filter((failure) => failure.kind === kind)
      .map((failure) => failure.label);
    if (names.length === 0) return [];
    return [
      `${new Intl.ListFormat("en", { type: "conjunction" }).format(names)} ${kind === "password" ? (names.length === 1 ? "needs a password" : "need passwords") : "unavailable"}`,
    ];
  });
  return {
    ...normal,
    text: [...words, normal.text].filter(Boolean).join(". "),
    actions: [{ label: "Details", onPress: providerFailures.settings }, ...(normal.actions ?? [])],
    dismiss: {
      label: "Dismiss provider notice",
      onPress: () => visible.forEach(({ id, token }) => dismissProviderNotice(id, token)),
    },
  };
}

/** The status line while a screen's content is worked out with no provider's list to name. */
export const loadingStatus = (what: string): Status => ({ text: `Loading ${what}.` });

/** The room the status line takes over a screen's bottom edge, for its scrolling content. */
const DockInset = createContext(0);

/** Bottom padding scrolling content adds so its end clears the status line; 0 without one. */
export const useDockInset = () => useContext(DockInset);

/**
 * A screen's content with its status line floating over the bottom, inside the screen's own safe
 * area: above the tab bar, the now playing accessory and the home indicator, however iOS sizes
 * them. The line takes at most its share of that safe area's height, measured as laid out, and
 * shows once it is known. Scrolling content below reads `useDockInset` to clear it.
 *
 * The content comes first, so a screen's scroll view is the first view down its first subviews,
 * where iOS looks for the one a large title collapses with. The host stays one native view for
 * that: flattened, its background would become an empty view ahead of the content, and the title
 * would stay large over the rows.
 */
export function Docked({
  status: supplied,
  children,
}: {
  status: Status | null;
  children: ReactNode;
}) {
  const status = useProviderStatus(supplied);
  const [space, setSpace] = useState(0);
  const [height, setHeight] = useState(0);
  const shown = status !== null && space > GAP * 2;
  if (status?.inline) {
    return (
      <DockInset.Provider value={0}>
        <View
          style={styles.fill}
          collapsable={false}
          onLayout={(event) => setSpace(event.nativeEvent.layout.height)}
        >
          {children}
          <SafeAreaView edges={["bottom", "left", "right"]} style={styles.room}>
            <StatusLine status={status} space={space} />
          </SafeAreaView>
        </View>
      </DockInset.Provider>
    );
  }
  return (
    <DockInset.Provider value={shown ? height : 0}>
      <View style={styles.fill} collapsable={false}>
        {children}
        <SafeAreaView
          edges={["top", "bottom", "left", "right"]}
          style={styles.cover}
          pointerEvents="box-none"
        >
          <View
            style={styles.area}
            pointerEvents="box-none"
            onLayout={(event) => setSpace(event.nativeEvent.layout.height)}
          >
            {shown ? (
              <View
                style={styles.room}
                onLayout={(event) => setHeight(event.nativeEvent.layout.height + GAP * 2)}
              >
                <StatusLine status={status} space={space - GAP * 2} />
              </View>
            ) : null}
          </View>
        </SafeAreaView>
      </View>
    </DockInset.Provider>
  );
}

/** Space between the status line and content above it, and the screen's edge under it. */
const GAP = 8;
/** The share of its host's height the whole line may take: content keeps the rest. */
const SHARE = 0.4;

/** The status text's size, and the padding around it inside the line, top and bottom together. */
const TEXT_SIZE = 15;
const TEXT_PADDING = 24;

/**
 * Whether a status line bounded to its share of `space` shows at least one whole line of its
 * text at the current text size. A line is estimated from the text size the way `useRowHeight`
 * sizes rows; under that the line would be a sliver that shows part of a word and no action.
 */
export function useStatusFits(space: number): boolean {
  const { fontScale } = useWindowDimensions();
  const line = Math.max(44, Math.ceil(TEXT_SIZE * fontScale * 1.2) + TEXT_PADDING);
  return space * SHARE >= line;
}

/**
 * Provider notices use black with a top rule; normal progress keeps glass (solid before iOS 26). Given
 * `space`, the height its host has for content and line together, everything on it, its text,
 * provider bar and actions, is one scrolling column no taller than its share of that space, so
 * long provider states and wrapped actions at any text size leave the screen's content usable
 * and stay reachable by scrolling; with no room at all it isn't drawn. Without `space` it isn't
 * bounded and its host scrolls it, as Search's results do where the bottom has too little room.
 */
export function StatusLine({ status: supplied, space }: { status: Status; space?: number }) {
  const status = useProviderStatus(supplied);
  const { text = "", actions = [], progress, announce = true, dismiss } = status ?? {};
  useStatusAnnouncement(status ? text || null : null, announce);
  if (!status) return null;
  const body = (
    <>
      <Text style={[styles.text, dismiss && styles.compactText]}>{text}</Text>
      {progress !== undefined ? (
        // A fixed bar: it moves only as a provider's lists come in.
        <View style={styles.rail} accessibilityElementsHidden importantForAccessibility="no">
          <View style={[styles.filled, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      ) : null}
      {actions.length > 0 || dismiss ? (
        <View style={[styles.actions, dismiss && styles.compactActions]}>
          {actions.map((action) => (
            <TextButton key={action.label} {...action} />
          ))}
          {dismiss ? (
            <IconButton
              symbol="xmark"
              label={dismiss.label}
              onPress={dismiss.onPress}
              testID="dismiss-provider-notice"
            />
          ) : null}
        </View>
      ) : null}
    </>
  );
  const plain = dismiss !== undefined || status.inline;
  const Surface = plain ? View : Glass;
  const surfaceStyle = plain ? styles.notice : styles.glass;
  const lineStyle = [styles.line, dismiss && styles.compactLine];
  if (space === undefined) {
    return (
      <Surface style={surfaceStyle}>
        <View style={lineStyle} testID="status-line">
          {body}
        </View>
      </Surface>
    );
  }
  const most = Math.max(0, space * SHARE);
  if (most === 0) return null;
  return (
    <Surface style={surfaceStyle}>
      <ScrollView
        style={{ maxHeight: most }}
        contentContainerStyle={lineStyle}
        indicatorStyle="white"
        // Retry and Settings take the first tap with Search's keyboard up, rather than it only
        // dismissing the keyboard, as Search's results list does.
        keyboardShouldPersistTaps="handled"
        testID="status-line"
      >
        {body}
      </ScrollView>
    </Surface>
  );
}

/**
 * Reads `text` out once per change of words, only while the viewer sees the calling screen: a
 * line behind another tab, under Watch or in the background stays quiet, and says its latest
 * words once it is back. Search calls it once for a line it moves between places.
 */
export function useStatusAnnouncement(text: string | null, announce: boolean) {
  const shown = useShown();
  const said = useRef<string | null>(null);
  useEffect(() => {
    if (!shown || !announce || text === null || said.current === text) return;
    said.current = text;
    AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
  }, [shown, announce, text]);
}

/**
 * Whether what the calling screen draws is what the viewer sees: it is in front in navigation,
 * Watch isn't open over it (Watch lies over the tabs without leaving them; Picture in Picture
 * and the accessory leave the screen in view) and the app is active.
 */
function useShown(): boolean {
  const focused = useIsFocused();
  const { watch } = usePlayback();
  const active = useForeground();
  return focused && !watch && active;
}

/** Whether the app is in front, not in the background or behind the app switcher. */
const foreground = store(true);
let following = false;
function useForeground(): boolean {
  if (!following) {
    following = true;
    foreground.set(AppState.currentState === "active");
    AppState.addEventListener("change", (state) => foreground.set(state === "active"));
  }
  return useStore(foreground);
}

/** One cycle: the band crosses in the first 1.1 s, then waits off the shape. */
const CYCLE = 2700;
const SWEEP = 1100 / CYCLE;
/** Ease in and out across the sweep, as points the native driver can follow. */
const TIMES = [0, 0.2, 0.4, 0.6, 0.8, 1].map((at) => at * SWEEP);
const EASED = [0, 0.104, 0.352, 0.648, 0.896, 1];
const INPUT = [...TIMES, 1];

const Clock = createContext<Animated.Value | null>(null);

/**
 * Still shapes standing in for content that hasn't come, hidden from VoiceOver, with one clock
 * for the highlight of every `Shape` in it. The clock runs only while the viewer sees the group
 * (its screen in front, Watch closed, the app active) and Reduce Motion is known to be off; it
 * stops, and the band goes, the moment any of that changes or the content replaces the group.
 */
export function Placeholders({
  style,
  children,
  testID,
}: {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  testID?: string;
}) {
  const [clock] = useState(() => new Animated.Value(0));
  const shown = useShown();
  const motion = useMotionAllowed();
  const moving = shown && motion;
  useEffect(() => {
    if (!moving) return;
    const loop = Animated.loop(
      Animated.timing(clock, {
        toValue: 1,
        duration: CYCLE,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      clock.setValue(0);
    };
  }, [clock, moving]);
  return (
    <Clock.Provider value={moving ? clock : null}>
      <View
        style={style}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        testID={testID}
      >
        {children}
      </View>
    </Clock.Provider>
  );
}

/** One still shape, sized by `style`, with the group's band crossing it while the clock runs. */
export function Shape({ style }: { style?: StyleProp<ViewStyle> }) {
  const clock = useContext(Clock);
  const [width, setWidth] = useState(0);
  return (
    <View
      style={[styles.shape, style]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {clock && width > 0 ? <Band clock={clock} width={width} /> : null}
    </View>
  );
}

function Band({ clock, width }: { clock: Animated.Value; width: number }) {
  const band = Math.max(24, Math.round(width * 0.45));
  const translateX = useMemo(
    () =>
      clock.interpolate({
        inputRange: INPUT,
        outputRange: [...EASED.map((done) => -band + done * (width + band)), width],
      }),
    [clock, width, band],
  );
  return <Animated.View style={[styles.band, { width: band, transform: [{ translateX }] }]} />;
}

/** Still rows at the list's real height while channels load. */
export function PlaceholderRows({ height, count = 8 }: { height: number; count?: number }) {
  return (
    <Placeholders testID="placeholder-rows">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[styles.row, { height }]}>
          <Shape style={styles.rowMark} />
          <View style={styles.names}>
            <Shape style={[styles.bar, { width: `${55 - (index % 3) * 10}%` }]} />
            <Shape style={[styles.bar, styles.barShort]} />
          </View>
        </View>
      ))}
    </Placeholders>
  );
}

/** Still lines of text, as a heading's or a paragraph's, while they load. */
export function PlaceholderLines({ widths }: { widths: readonly `${number}%`[] }) {
  return (
    <Placeholders style={styles.lines} testID="placeholder-lines">
      {widths.map((width, index) => (
        <Shape key={index} style={[styles.bar, { width }]} />
      ))}
    </Placeholders>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000000" },
  cover: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  area: { flex: 1, justifyContent: "flex-end" },
  room: { marginHorizontal: 12, marginBottom: GAP },
  glass: { borderRadius: 22, overflow: "hidden" },
  notice: {
    backgroundColor: "#000000",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  compactLine: { columnGap: 12 },
  compactText: { flexBasis: 120 },
  compactActions: { columnGap: 12, alignItems: "center" },
  line: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: 20,
    paddingHorizontal: 16,
    paddingVertical: 4,
    minHeight: 44,
  },
  // Takes the row; actions follow on the same line when they fit, else on their own.
  text: {
    color: colors.text,
    fontSize: TEXT_SIZE,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 180,
    paddingVertical: 8,
  },
  rail: {
    flexBasis: "100%",
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.line,
    overflow: "hidden",
    marginBottom: 6,
  },
  filled: { height: 2, backgroundColor: colors.text },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: 20 },
  shape: { backgroundColor: colors.fill, borderRadius: 4, overflow: "hidden" },
  band: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    backgroundImage:
      "linear-gradient(90deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0))",
  },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 },
  rowMark: { width: 56, height: 36, borderRadius: 6 },
  names: { flex: 1, minWidth: 0 },
  bar: { height: 12, borderRadius: 3 },
  barShort: { width: "30%", marginTop: 8 },
  lines: { gap: 10, paddingTop: 4 },
});
