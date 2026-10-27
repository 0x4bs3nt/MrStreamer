import { router } from "expo-router";
import { useState } from "react";
import { Image, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { DownloadsLink } from "../downloads-screen.tsx";
import { useDownloads } from "../downloads.ts";
import { openLink } from "../open-link.ts";
import { ProviderForm } from "../provider-form.tsx";
import { requestStatisticsChoice } from "../statistics-consent.ts";
import { colors, TextButton } from "../ui.tsx";

/** Welcome, an optional statistics choice, then the ordinary cancellable provider form. */
export default function Connect() {
  const { fontScale } = useWindowDimensions();
  const downloads = useDownloads();
  const [form, setForm] = useState(false);
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {form ? (
        <>
          <TextButton label="Back" onPress={() => setForm(false)} />
          <View style={styles.heading}>
            <Text style={styles.title} accessibilityRole="header">
              Add your provider
            </Text>
            <Text style={styles.lead}>Use the login from your IPTV provider.</Text>
          </View>
          <ProviderForm mode={{ kind: "connect" }} />
          <Text style={styles.footnote}>Your login goes only to your provider.</Text>
          <View style={styles.space} />
        </>
      ) : (
        <>
          <View style={[styles.brand, fontScale > 1.2 && styles.brandTop]}>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Image source={require("../../assets/mark.png") as number} style={styles.mark} />
            </View>
            <Text style={styles.brandName}>Mr. Streamer</Text>
          </View>
          <View style={styles.welcome}>
            <Text style={styles.welcomeTitle} accessibilityRole="header">
              {"Your TV.\nYour provider."}
            </Text>
            <Text style={styles.lead}>
              {"Live TV, movies and series.\nFrom your own provider."}
            </Text>
          </View>
          <View style={styles.space} />
          <TextButton
            label="Add provider"
            primary
            onPress={() => requestStatisticsChoice(() => setForm(true))}
          />
        </>
      )}
      <TextButton
        label="Privacy policy"
        onPress={() => openLink("https://mrstreamer.app/privacy")}
      />
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
  content: { flexGrow: 1, padding: 24, gap: 18 },
  heading: { gap: 10 },
  title: { color: colors.text, fontSize: 30, fontWeight: "700", letterSpacing: -1.05 },
  lead: { color: colors.dim, fontSize: 17, lineHeight: 25 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandTop: { alignItems: "flex-start" },
  mark: { width: 36, height: 36 },
  brandName: { flex: 1, minWidth: 0, color: colors.text, fontSize: 17, fontWeight: "600" },
  welcome: { paddingTop: 78, gap: 18 },
  welcomeTitle: {
    color: colors.text,
    fontSize: 34,
    fontWeight: "700",
    lineHeight: 40,
    letterSpacing: -1.19,
  },
  space: { flex: 1, minHeight: 24 },
  footnote: { color: colors.dim, fontSize: 14, lineHeight: 20 },
  // The link's own row insets by 16; Connect's content already does by 24.
  downloads: { marginHorizontal: -16, marginTop: 8 },
});
