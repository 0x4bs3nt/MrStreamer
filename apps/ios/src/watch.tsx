import { router, usePathname } from "expo-router";
import { lockAsync, OrientationLock, unlockAsync } from "expo-screen-orientation";
import { isPictureInPictureSupported, VideoAirPlayButton, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Keyboard,
  PanResponder,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass, IconButton } from "./glass.tsx";
import { openOnTabs, useTabs, type TabScreen } from "./header.tsx";
import {
  closeWatch,
  onEndPictureInPicture,
  pictureInPicture,
  player,
  playingItem,
  playNext,
  type Playing,
  restoreFromPictureInPicture,
  retry,
  seekBy,
  seekTo,
  setAside,
  showVersions,
  stop,
  togglePause,
  trackChoices,
  unsetAside,
  usePlayback,
  usePlaybackClock,
  usePlaybackLength,
} from "./playback.ts";
import { colors } from "./ui.tsx";

/**
 * Watch: the player full screen, over the tabs, with A3's controls: a close button, AirPlay,
 * Picture in Picture, Downloads and Settings at the top, and everything else in one large glass
 * panel, all showing and hiding together. A movie or an episode adds a scrubber, its sound and
 * subtitle tracks and the next episode. It is the app's own layer rather than a route, because
 * the view that starts Picture in Picture has to stay while it plays: Watch then hides, and the
 * tabs and accessory take over. Closing it shows the screen under it, a title's details among
 * them. A movie or an episode turns Watch to landscape while it shows; the screens under it turn
 * as the phone does again once it closes.
 *
 * Downloads and Settings open on the tab under Watch without stopping what plays: where Picture in
 * Picture can, it takes the picture over, as its own button does; otherwise Watch is set aside,
 * paused, until the accessory brings it back (`setAside`). A screen over the tabs, as Search,
 * closes first. With no provider saved there are no tabs and no accessory: Downloads is the
 * offline list, offered only while Picture in Picture can take the picture, and Settings isn't
 * offered. If the tabs go while Watch is set aside, as when the last provider is removed and a
 * downloaded copy waits there, Watch shows that copy again as it stands.
 */
export function WatchLayer() {
  const { phase, watch, pip, external } = usePlayback();
  const view = useRef<VideoView>(null);
  const [controls, setControls] = useState(true);
  const tabs = useTabs();
  const tab = tabs?.tab ?? null;
  const pathname = usePathname();
  // The press waiting for Picture in Picture to take over, with its fallback's timer. Picture in
  // Picture starting, Watch closing or showing again, the stream failing (its view goes, and Try
  // again plays the same item anew), another item, another tab or none, and Watch going each
  // retire it, so a fallback acts only for the press, stream and tabs it was for.
  const waiting = useRef<{ timer?: ReturnType<typeof setTimeout> } | null>(null);
  const retire = () => {
    clearTimeout(waiting.current?.timer);
    waiting.current = null;
  };
  const item = phase.kind === "idle" ? null : phase.item;
  const failed = phase.kind === "failed";
  useEffect(() => retire, [watch, pip, item, failed, tab]);
  useEffect(() => {
    if (!tab) unsetAside();
  }, [tab]);
  const pictureCanTake = phase.kind === "playing" && !external && isPictureInPictureSupported();
  const screens: readonly TabScreen[] = tab
    ? ["downloads", "settings"]
    : pictureCanTake
      ? ["downloads"]
      : [];
  const openScreen = (screen: TabScreen) => {
    retire();
    if (tabs) openOnTabs(tabs, screen);
    // Offline Downloads is usually the screen Watch opened over: then it only has to show.
    else if (pathname !== "/offline") router.push("/offline");
    const shown = view.current;
    if (!pictureCanTake || !shown) {
      if (tabs) setAside();
      return;
    }
    // Picture in Picture reports starting, which closes Watch over the screen just opened. If it
    // refuses, or doesn't start within a second, Watch is set aside instead of staying over it;
    // with no tabs to come back from, Watch stays as it was.
    const mine: { timer?: ReturnType<typeof setTimeout> } = {};
    waiting.current = mine;
    const unless = () => {
      if (waiting.current !== mine) return;
      waiting.current = null;
      if (tabs) setAside();
    };
    void shown.startPictureInPicture().then(() => {
      if (waiting.current === mine) mine.timer = setTimeout(unless, 1000);
    }, unless);
  };

  useEffect(() => {
    onEndPictureInPicture(() => void view.current?.stopPictureInPicture());
    return () => onEndPictureInPicture(null);
  }, []);
  // A return from Picture in Picture, answered once Watch has committed what it returns to: AVKit
  // then brings the picture back into a view on screen. The answer goes to the view that asked,
  // with the number its request carried, so a late answer can't complete a newer request.
  // Anything else playing by then, or Watch closed, answers no. If the view goes first, the
  // native view answers no as it goes.
  const [restoring, setRestoring] = useState<{
    readonly from: VideoView;
    readonly request: number;
    readonly item: Playing;
  } | null>(null);
  useEffect(() => {
    if (!restoring) return;
    setRestoring(null);
    const { from, request, item } = restoring;
    void from.finishPictureInPictureRestore(request, watch && playingItem(phase) === item);
  }, [restoring, watch, phase]);
  const restore = (request: number) => {
    const from = view.current;
    if (!from) return;
    const item = restoreFromPictureInPicture();
    if (item === null) void from.finishPictureInPictureRestore(request, false);
    else setRestoring({ from, request, item });
  };
  const landscape = watch && phase.kind !== "idle" && !phase.item.live;
  useEffect(() => {
    if (!landscape) return;
    turn(() => lockAsync(OrientationLock.LANDSCAPE));
    // Closing gives the screens back the app's own rotation: iOS turns them as the phone is held.
    return () => turn(unlockAsync);
  }, [landscape]);
  useEffect(() => {
    if (!watch) return;
    setControls(true);
    // A search field left focused under Watch would keep its keyboard over the picture.
    Keyboard.dismiss();
  }, [watch]);

  if (!watch && !pip) return null;
  const streaming = phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused";
  return (
    <View
      style={[StyleSheet.absoluteFill, watch ? styles.layer : styles.hidden]}
      pointerEvents={watch ? "auto" : "none"}
      // Watch lies over the tabs rather than replacing them, so VoiceOver is kept to it.
      accessibilityViewIsModal={watch}
      accessibilityElementsHidden={!watch}
      importantForAccessibility={watch ? "auto" : "no-hide-descendants"}
      testID="watch"
    >
      <StatusBar hidden={watch} />
      {streaming ? (
        <VideoView
          ref={view}
          player={player()}
          nativeControls={false}
          contentFit="contain"
          allowsPictureInPicture
          startsPictureInPictureAutomatically
          onPictureInPictureStart={() => pictureInPicture(true)}
          onPictureInPictureStop={() => pictureInPicture(false)}
          onPictureInPictureRestore={({ nativeEvent }) => restore(nativeEvent.request)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {watch ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel={controls ? "Hide controls" : "Show controls"}
          onPress={() => setControls((shown) => !shown)}
        />
      ) : null}
      {watch && controls ? (
        <Controls
          onPictureInPicture={() => void view.current?.startPictureInPicture()}
          screens={screens}
          onScreen={openScreen}
        />
      ) : null}
    </View>
  );
}

/** Orientation changes, made in the order asked so a quick close and reopen can't swap them. */
let turning = Promise.resolve();
function turn(change: () => Promise<void>) {
  turning = turning.then(change).catch(() => undefined);
}

function Controls({
  onPictureInPicture,
  screens,
  onScreen,
}: {
  onPictureInPicture: () => void;
  /** The screens Watch can open from here. */
  screens: readonly TabScreen[];
  onScreen: (screen: TabScreen) => void;
}) {
  const { phase } = usePlayback();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  if (phase.kind === "idle") return null;
  const wide = width >= 600;
  const edge = { left: insets.left + 16, right: insets.right + 16 };
  const streaming = phase.kind !== "failed";
  return (
    <>
      <Glass style={[styles.circle, { top: insets.top + 12, left: edge.left }]}>
        <IconButton symbol="xmark" label="Close" onPress={closeWatch} testID="watch-close" />
      </Glass>
      {streaming || screens.length > 0 ? (
        <Glass style={[styles.capsule, { top: insets.top + 12, right: edge.right }]}>
          {streaming ? (
            <>
              <VideoAirPlayButton
                style={styles.airplay}
                tint={colors.text}
                activeTint={colors.text}
                accessibilityLabel="AirPlay"
              />
              {isPictureInPictureSupported() ? (
                <IconButton
                  symbol="pip.enter"
                  label="Picture in Picture"
                  onPress={onPictureInPicture}
                  testID="watch-pip"
                />
              ) : null}
            </>
          ) : null}
          {screens.includes("downloads") ? (
            <IconButton
              symbol="arrow.down.circle"
              label="Downloads"
              onPress={() => onScreen("downloads")}
              testID="watch-downloads"
            />
          ) : null}
          {screens.includes("settings") ? (
            <IconButton
              symbol="gearshape"
              label="Settings"
              onPress={() => onScreen("settings")}
              testID="watch-settings"
            />
          ) : null}
        </Glass>
      ) : null}
      <Glass style={[styles.panel, { bottom: insets.bottom + 12, ...edge }]}>
        <View style={[styles.top, !wide && styles.stacked]}>
          <View style={styles.names}>
            <Text style={styles.title} numberOfLines={1}>
              {phase.item.title}
            </Text>
            <Text style={styles.place} numberOfLines={2} testID="watch-status">
              {phase.kind === "failed"
                ? phase.error
                : phase.kind === "loading"
                  ? "Connecting"
                  : phase.item.place}
            </Text>
          </View>
          <View style={styles.buttons}>
            {phase.kind === "failed" ? (
              <>
                <IconButton
                  symbol="arrow.clockwise"
                  label="Try again"
                  onPress={retry}
                  size={26}
                  testID="watch-retry"
                />
                {phase.item.versions ? (
                  <IconButton
                    symbol="square.stack"
                    label="Other versions"
                    onPress={() => {
                      closeWatch();
                      showVersions();
                    }}
                    size={22}
                    testID="watch-versions"
                  />
                ) : null}
              </>
            ) : (
              <>
                <IconButton
                  symbol="gobackward.10"
                  label="Back 10 seconds"
                  onPress={() => seekBy(-10)}
                  size={24}
                />
                <IconButton
                  symbol={phase.kind === "paused" ? "play.fill" : "pause.fill"}
                  label={phase.kind === "paused" ? "Play" : "Pause"}
                  onPress={togglePause}
                  size={32}
                  testID="watch-pause"
                />
                <IconButton
                  symbol="goforward.10"
                  label="Forward 10 seconds"
                  onPress={() => seekBy(10)}
                  size={24}
                />
              </>
            )}
            <IconButton
              symbol="stop.fill"
              label="Stop"
              onPress={stop}
              size={22}
              testID="watch-stop"
            />
          </View>
        </View>
        {streaming ? phase.item.live ? <Clock /> : <Scrubber /> : null}
        {streaming && !phase.item.live ? <TitleButtons next={phase.item.next} /> : null}
      </Glass>
    </>
  );
}

/** How long the stream has played, and that it is live. Only this redraws every second. */
function Clock() {
  const seconds = Math.floor(usePlaybackClock());
  const minutes = Math.floor(seconds / 60);
  return (
    <View style={styles.clock}>
      <Text style={styles.time} testID="watch-time">
        {`${minutes}:${String(seconds % 60).padStart(2, "0")}`}
      </Text>
      <View style={styles.spacer} />
      <Text style={styles.time}>Live</Text>
    </View>
  );
}

/** "1:02:13" or "24:51". */
function clockOf(seconds: number): string {
  // Before a title loaded, the player can report no time at all.
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * Where a title is and how much is left, on a line to drag or tap. VoiceOver adjusts it ten
 * seconds at a time. Only this redraws every second.
 */
function Scrubber() {
  const position = usePlaybackClock();
  const length = usePlaybackLength();
  const [width, setWidth] = useState(1);
  const [dragged, setDragged] = useState<number | null>(null);
  const at = dragged ?? (Number.isFinite(position) ? position : 0);
  const fraction = length > 0 ? Math.min(1, Math.max(0, at / length)) : 0;
  const toTime = (x: number) => (Math.min(width, Math.max(0, x)) / width) * length;
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => setDragged(toTimeRef.current(event.nativeEvent.locationX)),
      onPanResponderMove: (event) => setDragged(toTimeRef.current(event.nativeEvent.locationX)),
      onPanResponderRelease: (event) => {
        seekTo(toTimeRef.current(event.nativeEvent.locationX));
        setDragged(null);
      },
      onPanResponderTerminate: () => setDragged(null),
    }),
  ).current;
  const toTimeRef = useRef(toTime);
  toTimeRef.current = toTime;
  return (
    <View style={styles.clock}>
      <Text style={styles.time} testID="watch-time">
        {clockOf(at)}
      </Text>
      <View
        style={styles.scrub}
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width || 1)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Position"
        accessibilityValue={{ text: `${clockOf(at)} of ${clockOf(length)}` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event: AccessibilityActionEvent) =>
          seekBy(event.nativeEvent.actionName === "increment" ? 10 : -10)
        }
        testID="watch-scrubber"
        {...responder.panHandlers}
      >
        <View style={styles.rail}>
          <View style={[styles.filled, { width: `${fraction * 100}%` }]} />
        </View>
        <View style={[styles.knob, { left: fraction * width - 7 }]} />
      </View>
      <Text style={styles.time} testID="watch-left">
        {length > 0 ? `-${clockOf(length - at)}` : ""}
      </Text>
    </View>
  );
}

/** Audio, Subtitles and Next episode: what a title adds to the panel. */
function TitleButtons({ next }: { next: boolean }) {
  const choose = (of: "audio" | "subtitles") => {
    const choices = trackChoices(of);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: of === "audio" ? "Audio" : "Subtitles",
        options: [
          ...choices.map((choice) => (choice.selected ? `✓ ${choice.label}` : choice.label)),
          "Cancel",
        ],
        cancelButtonIndex: choices.length,
        ...(choices.length === 0 || (of === "subtitles" && choices.length === 1)
          ? { message: "None in this file." }
          : {}),
      },
      (index) => choices[index]?.choose(),
    );
  };
  return (
    <View style={styles.titleButtons}>
      <TextControl label="Audio" onPress={() => choose("audio")} testID="watch-audio" />
      <TextControl label="Subtitles" onPress={() => choose("subtitles")} testID="watch-subtitles" />
      {next ? <TextControl label="Next episode" onPress={playNext} testID="watch-next" /> : null}
    </View>
  );
}

function TextControl({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.textControl, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={styles.textControlLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  layer: { backgroundColor: "#000000" },
  // Under Picture in Picture the view stays, unseen and untouchable, so iOS can bring it back.
  hidden: { opacity: 0 },
  circle: { position: "absolute", borderRadius: 22 },
  capsule: { position: "absolute", flexDirection: "row", borderRadius: 22, paddingHorizontal: 2 },
  airplay: { width: 44, height: 44 },
  panel: { position: "absolute", borderRadius: 26, paddingHorizontal: 16, paddingVertical: 12 },
  top: { flexDirection: "row", alignItems: "center", gap: 12 },
  stacked: { flexDirection: "column", alignItems: "stretch" },
  names: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  place: { color: colors.text, fontSize: 13, marginTop: 2 },
  buttons: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  clock: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  time: { color: colors.text, fontSize: 13, fontVariant: ["tabular-nums"], minWidth: 44 },
  scrub: { flex: 1, height: 32, justifyContent: "center" },
  rail: { height: 4, borderRadius: 2, backgroundColor: "#FFFFFF40", overflow: "hidden" },
  filled: { height: 4, backgroundColor: "#FFFFFF" },
  knob: {
    position: "absolute",
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#FFFFFF",
  },
  titleButtons: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginTop: 4 },
  textControl: { minHeight: 44, justifyContent: "center" },
  textControlLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  pressed: { opacity: 0.5 },
  spacer: { flex: 1 },
});
