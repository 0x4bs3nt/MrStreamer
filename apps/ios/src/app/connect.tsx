import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { startDemo } from "../account.ts";
import { DownloadsLink } from "../downloads-screen.tsx";
import { useDownloads } from "../downloads.ts";
import { ProviderForm } from "../provider-form.tsx";
import { colors, TextButton } from "../ui.tsx";

/**
 * Adds the first Xtream subscription, on the provider form Settings adds the next ones with. The
 * root layout shows the tabs once one is saved. Downloads kept on the phone open from here too,
 * as they play with no provider.
 */
export default function Connect() {
  const downloads = useDownloads();
  const [trying, setTrying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const tryDemo = () => {
    setTrying(true);
    setNote(null);
    void startDemo()
      .then((result) => {
        setTrying(false);
        if (result.kind === "incomplete")
          setNote("Earlier demo data couldn't all be removed. Try again.");
        else if (result.kind === "refused") setNote("Demo isn't available right now. Try again.");
      })
      .catch(() => {
        setTrying(false);
        setNote("Demo isn't available right now. Try again.");
      });
  };
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <View>
        <Text style={styles.title} accessibilityRole="header">
          Mr. Streamer
        </Text>
        <Text style={styles.lead}>Add your provider</Text>
      </View>
      <ProviderForm mode={{ kind: "connect" }} />
      <Text style={styles.footnote}>The password stays in this iPhone's Keychain.</Text>
      <TextButton label="Try demo" onPress={tryDemo} disabled={trying} testID="connect-demo" />
      {note ? (
        <Text accessibilityRole="alert" style={styles.footnote}>
          {note}
        </Text>
      ) : null}
      {downloads.items.length > 0 ? (
        <View style={styles.downloads}>
          <DownloadsLink onPress={() => router.push("/offline")} />
        </View>
      ) : null}
      {__DEV__ ? <TextButton label="Runtime proof" onPress={() => router.push("/proof")} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { padding: 24, gap: 16 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700" },
  lead: { color: colors.text, fontSize: 17, marginTop: 4, marginBottom: 8 },
  footnote: { color: colors.dim, fontSize: 13 },
  // The link's own row insets by 16; Connect's content already does by 24.
  downloads: { marginHorizontal: -16, marginTop: 8 },
});
