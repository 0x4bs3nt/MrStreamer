import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { SymbolView } from "expo-symbols";
import type { Channel } from "./library.ts";
import { memo } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type AccessibilityActionEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useArtwork } from "./artwork-cache.ts";
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
 * read, or its monogram when it has none or the logo doesn't load. The tile stays empty while the
 * logo is fetched (artwork-cache.ts).
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
  const logo = useArtwork(channel.logoUrl);
  return (
    <View style={[styles.mark, style]}>
      {logo.kind === "shown" ? (
        <Image
          source={{ uri: logo.uri }}
          style={styles.logo}
          resizeMode="contain"
          onError={logo.broke}
          accessibilityIgnoresInvertColors
        />
      ) : logo.kind === "pending" ? null : (
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

/**
 * A channel as a row that plays it when pressed. With `onFavourite`, a star at its end stars or
 * unstars it without playing, which VoiceOver offers as the row's action.
 */
export const ChannelRow = memo(function ChannelRow({
  channel,
  detail,
  status,
  height,
  onPress,
  favourite = false,
  onFavourite,
}: {
  channel: Channel;
  detail: string;
  /** How the channel stands while it is the one playing (`channelStatus`), in place of `detail`. */
  status: string | null;
  height: number;
  onPress: (channel: Channel) => void;
  favourite?: boolean;
  onFavourite?: ((channel: Channel, favourite: boolean) => void) | undefined;
}) {
  const tags = channel.tags.join(" ");
  const star = favourite ? "Remove from Favourites" : "Add to Favourites";
  return (
    <View style={[styles.row, { height }, onFavourite && styles.starred]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[channel.title, favourite && "favourite", status?.toLowerCase()]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={detail}
        {...(onFavourite
          ? {
              accessibilityActions: [{ name: "activate" }, { name: "favourite", label: star }],
              onAccessibilityAction: ({ nativeEvent }: AccessibilityActionEvent) => {
                if (nativeEvent.actionName === "activate") onPress(channel);
                if (nativeEvent.actionName === "favourite") onFavourite(channel, !favourite);
              },
            }
          : {})}
        onPress={() => onPress(channel)}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        testID={`channel-${channel.key}`}
      >
        <ChannelLogo channel={channel} style={styles.rowMark} />
        <View style={styles.names}>
          <Text style={styles.title} numberOfLines={1}>
            {channel.title}
            {tags ? <Text style={styles.tags}>{`  ${tags}`}</Text> : null}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {status ?? detail}
          </Text>
        </View>
      </Pressable>
      {onFavourite ? (
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          accessibilityLabel={star}
          onPress={() => onFavourite(channel, !favourite)}
          style={({ pressed }) => [styles.star, pressed && styles.pressed]}
          testID={`star-${channel.key}`}
        >
          <SymbolView
            name={favourite ? "star.fill" : "star"}
            size={18}
            tintColor={colors.text}
            weight="semibold"
          />
        </Pressable>
      ) : null}
    </View>
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
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled ?? false }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, (pressed || disabled) && styles.pressed]}
      testID={testID}
    >
      <Text style={[styles.textButtonLabel, destructive && styles.destructive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16 },
  starred: { paddingRight: 4 },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, alignSelf: "stretch" },
  star: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
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
