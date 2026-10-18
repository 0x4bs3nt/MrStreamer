import { NativeTabs } from "expo-router/native-tabs";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { IconButton } from "./glass.tsx";
import { openWatch, stop, togglePause, usePlayback } from "./playback.ts";
import { colors } from "./ui.tsx";

/**
 * The now playing accessory over the tabs, on the system's own glass. iOS draws it twice, above
 * the bar and inline in a shrunk bar, so it keeps no state: both read and control the one player.
 * Set aside for Downloads or Settings, it says how the stream stands: paused, connecting, playing
 * or why it failed.
 */
export function NowPlaying() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const { phase, pip, external } = usePlayback();
  if (phase.kind === "idle") return null;
  const where = external
    ? "AirPlay"
    : pip
      ? "Picture in Picture"
      : phase.kind === "paused"
        ? "Paused"
        : phase.kind === "loading"
          ? "Connecting"
          : "Playing";
  const status = phase.kind === "failed" ? phase.error : where;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${phase.item.title}, ${status}`}
        accessibilityHint="Opens Watch"
        onPress={openWatch}
        style={styles.open}
        testID="accessory-open"
      >
        <SymbolView
          name={external ? "airplay.video" : pip ? "pip" : "play.rectangle"}
          size={18}
          tintColor={colors.text}
        />
        <View style={styles.names}>
          <Text style={styles.title} numberOfLines={1}>
            {phase.item.title}
          </Text>
          {placement === "regular" ? (
            <Text style={styles.where} numberOfLines={1}>
              {status}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {phase.kind === "playing" || phase.kind === "paused" ? (
        <IconButton
          symbol={phase.kind === "playing" ? "pause.fill" : "play.fill"}
          label={phase.kind === "playing" ? "Pause" : "Play"}
          onPress={togglePause}
          testID="accessory-pause"
        />
      ) : null}
      {placement === "regular" ? (
        <IconButton symbol="xmark" label="Stop" onPress={stop} testID="accessory-stop" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 8 },
  open: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  names: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 15, fontWeight: "600" },
  where: { color: colors.dim, fontSize: 12 },
});
