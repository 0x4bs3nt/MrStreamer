import { DarkTheme, Stack, ThemeProvider, usePathname } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useRoster } from "../account.ts";
import { startDownloads } from "../downloads.ts";
import { onScreen } from "../playback.ts";
import { holdLaunchScreen, StartupScreen } from "../startup-screen.tsx";
import { startUp, useStartup } from "../startup.ts";
import { onTelemetryScreen, startTelemetry } from "../telemetry/index.ts";
import { WatchLayer } from "../watch.tsx";

// The app: Connect until a subscription is saved, then the four tabs, with Search over them.
// Without one, Connect also opens Downloads (`offline`), as copies play with no provider. Watch
// lies over all of them, outside navigation, so the one player view it shows lives on under
// Picture in Picture while the tabs are used. The launch screen covers them until the app opens
// with what the phone saved (startup.ts); the tabs are there under it from when the subscriptions
// are read, so navigation, links and downloads work as they would without it.

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "#000000",
    card: "#000000",
    text: "#FFFFFF",
    primary: "#FFFFFF",
  },
};

holdLaunchScreen();

export default function RootLayout() {
  const roster = useRoster();
  const startup = useStartup();
  const pathname = usePathname();
  useEffect(() => {
    startTelemetry();
    void startUp();
    startDownloads();
  }, []);
  // A request still waiting when the viewer moves to another screen lapses (playback.ts).
  useEffect(() => {
    onScreen(pathname);
    onTelemetryScreen(pathname);
  }, [pathname]);
  const opening = roster.kind === "restoring" || startup.kind === "opening";
  return (
    <View style={styles.black}>
      {roster.kind === "ready" ? <App signedIn={roster.members.length > 0} /> : null}
      {opening ? <StartupScreen /> : null}
    </View>
  );
}

/** The screens, Connect's or the tabs', with Watch over them. */
function App({ signedIn }: { readonly signedIn: boolean }) {
  return (
    <ThemeProvider value={theme}>
      <View style={styles.black}>
        <Stack screenOptions={{ headerShown: false, contentStyle: styles.black }}>
          {/* Explicit, or Expo Router falls back to the first open route: Runtime proof. */}
          <Stack.Protected guard={signedIn} redirectTo="/connect">
            <Stack.Screen name="(tabs)" />
            {/* Over the tab it opened from, which stays as it was under it. */}
            <Stack.Screen name="search" options={{ animation: "fade", animationDuration: 180 }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn} redirectTo="/">
            <Stack.Screen name="connect" />
            <Stack.Screen
              name="offline"
              options={{
                headerShown: true,
                title: "Downloads",
                headerBackButtonDisplayMode: "minimal",
                headerTintColor: "#FFFFFF",
                headerTitleStyle: { color: "#FFFFFF" },
              }}
            />
          </Stack.Protected>
          <Stack.Screen
            name="proof"
            options={{ presentation: "modal", headerShown: true, title: "Runtime proof" }}
          />
        </Stack>
        <WatchLayer />
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({ black: { flex: 1, backgroundColor: "#000000" } });
