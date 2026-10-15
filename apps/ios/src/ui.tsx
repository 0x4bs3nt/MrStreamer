import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { memo } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";

// Plain true-black content: rows, lines of text and the one text button. No glass here.

export const colors = { text: "#FFFFFF", dim: "#A1A1A6", fill: "#1C1C1E", line: "#2C2C2E" };

/** A row's height, which grows with Dynamic Type so lists can still measure rows up front. */
export function useRowHeight(): number {
  const { fontScale } = useWindowDimensions();
  return Math.round(Math.max(60, 24 + 38 * fontScale));
}

/** "VRT 1" as "V1", "Channel 4" as "C4": a stand-in until channel logos come to iOS. */
function monogram(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((word) => word[0]).join("") : title;
  return letters.slice(0, 3).toUpperCase();
}

export const ChannelRow = memo(function ChannelRow({
  channel,
  detail,
  playing,
  height,
  onPress,
}: {
  channel: ListedChannel;
  detail: string;
  playing: boolean;
  height: number;
  onPress: (channel: ListedChannel) => void;
}) {
  const tags = channel.tags.join(" ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${channel.title}${playing ? ", playing" : ""}`}
      accessibilityHint={detail}
      onPress={() => onPress(channel)}
      style={({ pressed }) => [styles.row, { height }, pressed && styles.pressed]}
      testID={`channel-${channel.id}`}
    >
      <View style={styles.mark}>
        <Text style={styles.markText} allowFontScaling={false} numberOfLines={1}>
          {monogram(channel.title)}
        </Text>
      </View>
      <View style={styles.names}>
        <Text style={styles.title} numberOfLines={1}>
          {channel.title}
          {tags ? <Text style={styles.tags}>{`  ${tags}`}</Text> : null}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {playing ? "Playing" : detail}
        </Text>
      </View>
    </Pressable>
  );
});

/** A line of text where a screen has nothing else, with an optional action under it. */
export function Message({
  text,
  action,
}: {
  text: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
      {action ? <TextButton {...action} /> : null}
    </View>
  );
}

export function TextButton({
  label,
  onPress,
  disabled,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled ?? false }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, (pressed || disabled) && styles.pressed]}
    >
      <Text style={[styles.textButtonLabel, destructive && styles.destructive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 },
  pressed: { opacity: 0.5 },
  mark: {
    width: 44,
    height: 32,
    borderRadius: 6,
    backgroundColor: colors.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  markText: { color: colors.text, fontSize: 11, fontWeight: "700" },
  names: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17 },
  tags: { color: colors.dim, fontSize: 13 },
  detail: { color: colors.dim, fontSize: 13, marginTop: 2 },
  message: { padding: 24, gap: 12, alignItems: "flex-start" },
  messageText: { color: colors.dim, fontSize: 15 },
  textButton: { minHeight: 44, justifyContent: "center" },
  textButtonLabel: { color: colors.text, fontSize: 17, fontWeight: "600" },
  destructive: { color: "#FF453A" },
});
