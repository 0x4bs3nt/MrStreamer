import { isPictureInPictureSupported, VideoAirPlayButton, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass, IconButton } from "./glass.tsx";
import {
  closeWatch,
  onEndPictureInPicture,
  pictureInPicture,
  player,
  retry,
  seekBy,
  stop,
  togglePause,
  usePlayback,
  usePlaybackClock,
} from "./playback.ts";
import { colors } from "./ui.tsx";

/**
 * Watch: the player full screen, over the tabs, with A3's controls: a close button, AirPlay and
 * Picture in Picture at the top, and everything else in one large glass panel. It is the app's own
 * layer rather than a route, because the view that starts Picture in Picture has to stay while it
 * plays: Watch then hides, and the tabs and accessory take over.
 */
export function WatchLayer() {
  const { phase, watch, pip } = usePlayback();
  const view = useRef<VideoView>(null);
  const [controls, setControls] = useState(true);

  useEffect(() => {
    onEndPictureInPicture(() => void view.current?.stopPictureInPicture());
    return () => onEndPictureInPicture(null);
  }, []);
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
        <Controls onPictureInPicture={() => void view.current?.startPictureInPicture()} />
      ) : null}
    </View>
  );
}

function Controls({ onPictureInPicture }: { onPictureInPicture: () => void }) {
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
      {streaming ? (
        <Glass style={[styles.capsule, { top: insets.top + 12, right: edge.right }]}>
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
        </Glass>
      ) : null}
      <Glass style={[styles.panel, { bottom: insets.bottom + 12, ...edge }]}>
        <View style={[styles.top, !wide && styles.stacked]}>
          <View style={styles.names}>
            <Text style={styles.title} numberOfLines={1}>
              {phase.channel.title}
            </Text>
            <Text style={styles.place} numberOfLines={2} testID="watch-status">
              {phase.kind === "failed"
                ? phase.error
                : phase.kind === "loading"
                  ? "Connecting"
                  : phase.channel.place}
            </Text>
          </View>
          <View style={styles.buttons}>
            {phase.kind === "failed" ? (
              <IconButton
                symbol="arrow.clockwise"
                label="Try again"
                onPress={retry}
                size={26}
                testID="watch-retry"
              />
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
        {streaming ? <Clock /> : null}
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
  time: { color: colors.text, fontSize: 13, fontVariant: ["tabular-nums"] },
  spacer: { flex: 1 },
});
