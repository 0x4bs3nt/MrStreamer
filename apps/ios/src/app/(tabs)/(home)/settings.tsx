import type { AppError } from "@mrstreamer/contracts/errors";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { router } from "expo-router";
import { isPictureInPictureSupported } from "expo-video";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { disconnect, loadCatalogue, useCatalogue, useSession } from "../../../account.ts";
import { describeError } from "../../../errors.ts";
import { colors, TextButton } from "../../../ui.tsx";

/**
 * The subscription, so far. Several subscriptions, guides, languages, preferences and privacy
 * come here as they come to iOS.
 */
export default function Settings() {
  const session = useSession();
  const catalogue = useCatalogue();
  if (session.kind !== "signed-in") return null;
  const { subscription, account } = session;
  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Text style={styles.section} accessibilityRole="header">
        Subscription
      </Text>
      <Line label="Server" value={subscription.server.replace(/^https?:\/\//, "")} />
      <Line label="Username" value={subscription.username} />
      <Line label="Account" value={accountLine(account)} />
      <Line
        label="Channels"
        value={
          catalogue.kind === "ready"
            ? String(catalogue.library.byId.size)
            : catalogue.kind === "failed"
              ? describeError(catalogue.error)
              : "Loading"
        }
      />
      <View style={styles.actions}>
        <TextButton label="Reload channels" onPress={loadCatalogue} />
        <TextButton label="Disconnect" onPress={() => void disconnect()} destructive />
      </View>
      {__DEV__ ? (
        <>
          <Text style={styles.section} accessibilityRole="header">
            Development
          </Text>
          <Line
            label="Picture in Picture"
            value={isPictureInPictureSupported() ? "Supported" : "Not supported here"}
          />
          <View style={styles.actions}>
            <TextButton label="Runtime proof" onPress={() => router.push("/proof")} />
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function accountLine(account: AccountStatus | AppError | null): string {
  if (!account) return "Checking";
  if ("kind" in account) return describeError(account);
  const parts = [account.state === "active" ? "Active" : account.state];
  if (account.expiresAt) parts.push(`until ${new Date(account.expiresAt).toLocaleDateString()}`);
  if (account.maxConnections !== null) {
    parts.push(`${account.activeConnections ?? 0} of ${account.maxConnections} connections`);
  }
  return parts.join(" · ");
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 16,
    marginHorizontal: 16,
  },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
    alignItems: "center",
    marginHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: { color: colors.text, fontSize: 17 },
  value: { color: colors.dim, fontSize: 17, flexShrink: 1, textAlign: "right" },
  actions: { marginHorizontal: 16, marginTop: 8 },
});
