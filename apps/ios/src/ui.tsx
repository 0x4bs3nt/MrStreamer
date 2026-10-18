import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import type { Channel } from "./library.ts";
import { memo, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { Failure } from "./errors.ts";

// Plain true-black content: rows, logos, lines of text and the one text button. No glass here.

export const colors = { text: "#FFFFFF", dim: "#A1A1A6", fill: "#1C1C1E", line: "#2C2C2E" };

/** A row's height, which grows with Dynamic Type so lists can still measure rows up front. */
export function useRowHeight(): number {
  const { fontScale } = useWindowDimensions();
  return Math.round(Math.max(60, 24 + 38 * fontScale));
}

/** "VRT 1" as "V1", "Channel 4" as "C4": the stand-in for a channel without a logo. */
function monogram(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((word) => word[0]).join("") : title;
  return letters.slice(0, 3).toUpperCase();
}

/**
 * The channel's logo as its provider lists it, on a dark tile so dark and transparent logos still
 * read, or its monogram when it has none or the logo doesn't load.
 */
export function ChannelLogo({
  channel,
  style,
  large = false,
}: {
  channel: Pick<ListedChannel, "title" | "logoUrl">;
  style?: StyleProp<ViewStyle>;
  /** A tile, not a row's mark: the monogram larger. */
  large?: boolean;
}) {
  // The link that failed: a tile reused for another channel tries its own.
  const [failed, setFailed] = useState<string | null>(null);
  const url = channel.logoUrl && channel.logoUrl !== failed ? channel.logoUrl : null;
  return (
    <View style={[styles.mark, style]}>
      {url ? (
        <Image
          source={{ uri: url }}
          style={styles.logo}
          resizeMode="contain"
          onError={() => setFailed(url)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text
          style={[styles.markText, large && styles.markLarge]}
          allowFontScaling={false}
          numberOfLines={1}
        >
          {monogram(channel.title)}
        </Text>
      )}
    </View>
  );
}

export const ChannelRow = memo(function ChannelRow({
  channel,
  detail,
  playing,
  height,
  onPress,
}: {
  channel: Channel;
  detail: string;
  playing: boolean;
  height: number;
  onPress: (channel: Channel) => void;
}) {
  const tags = channel.tags.join(" ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${channel.title}${playing ? ", playing" : ""}`}
      accessibilityHint={detail}
      onPress={() => onPress(channel)}
      style={({ pressed }) => [styles.row, { height }, pressed && styles.pressed]}
      testID={`channel-${channel.key}`}
    >
      <ChannelLogo channel={channel} style={styles.rowMark} />
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

/**
 * What went wrong or why a screen is empty, in a line or two, with what the viewer can do about
 * it. White headline, the advice under it, the actions as text buttons.
 */
export function Notice({
  failure,
  actions = [],
}: {
  failure: Failure;
  actions?: readonly { label: string; onPress: () => void }[];
}) {
  return (
    <View style={styles.message}>
      <View accessible accessibilityLiveRegion="polite">
        <Text style={styles.headline} accessibilityRole="header">
          {failure.headline}
        </Text>
        {failure.advice ? <Text style={styles.messageText}>{failure.advice}</Text> : null}
      </View>
      {actions.map((action) => (
        <TextButton key={action.label} {...action} />
      ))}
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
    borderRadius: 6,
    backgroundColor: colors.fill,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  rowMark: { width: 56, height: 36 },
  logo: { position: "absolute", top: "10%", left: "8%", right: "8%", bottom: "10%" },
  markText: { color: colors.text, fontSize: 11, fontWeight: "700" },
  markLarge: { fontSize: 20 },
  names: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 17 },
  tags: { color: colors.dim, fontSize: 13 },
  detail: { color: colors.dim, fontSize: 13, marginTop: 2 },
  message: { padding: 24, gap: 12, alignItems: "flex-start" },
  messageText: { color: colors.dim, fontSize: 15, marginTop: 4 },
  headline: { color: colors.text, fontSize: 17, fontWeight: "600" },
  textButton: { minHeight: 44, justifyContent: "center" },
  textButtonLabel: { color: colors.text, fontSize: 17, fontWeight: "600" },
  destructive: { color: "#FF453A" },
});
