import type { DownloadList } from "@mrstreamer/contracts/downloads";
import { formatBytes, formatPercent } from "@mrstreamer/core/i18n";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text } from "react-native";
import { useDownloads } from "./downloads.ts";

/** The queue's most immediate state, derived from the existing owner without another timer. */
function downloadStatus({ items }: DownloadList): { short: string; text: string } | null {
  const transferring = items.find((item) => item.status.kind === "transferring");
  if (transferring?.status.kind === "transferring") {
    const { received, size } = transferring.status;
    const progress =
      size !== null && size > 0
        ? formatPercent(Math.min(1, Math.max(0, Math.floor((received / size) * 100) / 100)))
        : received < 1000
          ? `${received} B`
          : formatBytes(received);
    return { short: progress, text: `${transferring.name}, ${progress} downloaded` };
  }
  const waiting = items.find((item) => item.status.kind === "waiting");
  if (waiting)
    return {
      short: "Wait",
      text: waiting.subscription
        ? `Waiting while ${waiting.subscription.name} plays`
        : "Waiting for playback",
    };
  const queued = items.filter((item) => item.status.kind === "queued").length;
  if (queued) return { short: String(queued), text: `${queued} queued` };
  const failed = items.filter((item) => item.status.kind === "failed" && item.subscription).length;
  return failed ? { short: "!", text: `${failed} failed, open Downloads to retry` } : null;
}

/** One Downloads action on tab headers, Search and Watch. It never starts or changes a transfer. */
export function DownloadStatusButton({
  onPress,
  testID,
  onlyActive = false,
}: {
  onPress: () => void;
  testID?: string;
  onlyActive?: boolean;
}) {
  const status = downloadStatus(useDownloads());
  if (onlyActive && !status) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={status ? `Downloads, ${status.text}` : "Downloads"}
      onPress={onPress}
      style={styles.button}
      testID={testID}
    >
      <SymbolView
        name="arrow.down.circle"
        size={status ? 17 : 20}
        tintColor="#FFFFFF"
        weight="semibold"
      />
      {status ? (
        <Text style={styles.progress} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {status.short}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  progress: { color: "#FFFFFF", fontSize: 11, fontWeight: "600" },
});
