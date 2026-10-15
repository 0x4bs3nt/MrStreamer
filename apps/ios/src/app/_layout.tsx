import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { restore, useSession } from "../account.ts";
import { WatchLayer } from "../watch.tsx";

// The app: Connect until a subscription is signed in, then the five tabs. Watch lies over both,
// outside navigation, so the one player view it shows lives on under Picture in Picture while
// the tabs are used.

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

let restored: Promise<void> | null = null;

export default function RootLayout() {
  const session = useSession();
  useEffect(() => {
    restored ??= restore();
  }, []);
  if (session.kind === "restoring") return <View style={styles.black} />;
  const signedIn = session.kind === "signed-in";
  return (
    <ThemeProvider value={theme}>
      <View style={styles.black}>
        <Stack screenOptions={{ headerShown: false, contentStyle: styles.black }}>
          {/* Explicit, or Expo Router falls back to the first open route: Runtime proof. */}
          <Stack.Protected guard={signedIn} redirectTo="/connect">
            <Stack.Screen name="(tabs)" />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn} redirectTo="/">
            <Stack.Screen name="connect" />
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
