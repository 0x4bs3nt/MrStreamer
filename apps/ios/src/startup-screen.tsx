import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "./ui.tsx";

// The launch screen, while the app opens (startup.ts): iOS's own from app.json, the mark over the
// name centred on black, until this one has drawn the same picture at the same place and size;
// then this one, over the screens, until the app opens. When opening takes a moment, a line says
// so near the bottom. Nothing moves and nothing counts down: it leaves as soon as the app opens.

/** As app.json's expo-splash-screen `imageWidth`: the picture's side, in points. */
const SIZE = 240;
/** How long opening may take before the line says so. */
const SAYS_AFTER = 1_000;

/** Keeps iOS's launch screen until `StartupScreen` has drawn over it; once, as the app starts. */
export function holdLaunchScreen() {
  void SplashScreen.preventAutoHideAsync().catch(() => undefined);
}

/** Lets iOS's launch screen go once the frame with this one's picture is on screen. */
const showOwn = () => requestAnimationFrame(() => SplashScreen.hide());

export function StartupScreen() {
  const insets = useSafeAreaInsets();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SAYS_AFTER);
    return () => {
      clearTimeout(timer);
      // Gone before its picture loaded: iOS's goes with it.
      SplashScreen.hide();
    };
  }, []);
  return (
    <View style={styles.screen} accessibilityViewIsModal>
      <Image
        source={require("../assets/splash.png") as number}
        style={styles.brand}
        onLoad={showOwn}
        onError={showOwn}
        accessible
        accessibilityLabel="Mr. Streamer"
      />
      {slow ? (
        <Text style={[styles.line, { bottom: insets.bottom + 40 }]} maxFontSizeMultiplier={2}>
          Opening your library
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000000",
  },
  brand: { width: SIZE, height: SIZE },
  line: {
    position: "absolute",
    left: 24,
    right: 24,
    color: colors.dim,
    fontSize: 15,
    textAlign: "center",
  },
});
