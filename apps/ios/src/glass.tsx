import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { ReactNode } from "react";
import {
  AccessibilityInfo,
  DynamicColorIOS,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { store, useStore } from "./store.ts";

// The app's own controls over pictures, drawn as Liquid Glass where iOS draws its bars that way:
// Home's preview buttons, Watch's panel and buttons. Before iOS 26, or with Reduce Transparency
// on, they are solid instead, and follow the setting as it changes. Lists and pictures are never
// glass, apart from the status line loading.tsx floats over them. Nothing here animates by
// itself; glass changes its style without animating under Reduce Motion.

const supported = isGlassEffectAPIAvailable() && isLiquidGlassAvailable();

const accessibility = store({ reduceTransparency: false, reduceMotion: false, motionRead: false });
let watching = false;
function watchAccessibility() {
  if (watching) return;
  watching = true;
  const set = (key: "reduceTransparency" | "reduceMotion") => (on: boolean) =>
    accessibility.set((current) =>
      current[key] === on && (key !== "reduceMotion" || current.motionRead)
        ? current
        : { ...current, [key]: on, motionRead: current.motionRead || key === "reduceMotion" },
    );
  void AccessibilityInfo.isReduceTransparencyEnabled().then(set("reduceTransparency"));
  void AccessibilityInfo.isReduceMotionEnabled().then(set("reduceMotion"));
  AccessibilityInfo.addEventListener("reduceTransparencyChanged", set("reduceTransparency"));
  AccessibilityInfo.addEventListener("reduceMotionChanged", set("reduceMotion"));
}

function useAccessibility() {
  watchAccessibility();
  return useStore(accessibility);
}

/** Whether Reduce Motion is on: what moves on its own, as Search arriving, fades instead. */
export function useReduceMotion(): boolean {
  return useAccessibility().reduceMotion;
}

/**
 * Whether something may move on its own for as long as it lasts, as loading shapes' highlight:
 * only once iOS has said Reduce Motion is off, so it never starts before the setting is known.
 */
export function useMotionAllowed(): boolean {
  const { reduceMotion, motionRead } = useAccessibility();
  return motionRead && !reduceMotion;
}

/** Whether the app's controls are glass now. */
export function useGlass(): boolean {
  return supported && !useAccessibility().reduceTransparency;
}

/** The solid fill in glass's place, lighter with Increase Contrast, which also adds an edge. */
const SOLID = DynamicColorIOS({
  dark: "#1C1C1E",
  light: "#1C1C1E",
  highContrastDark: "#3A3A3C",
  highContrastLight: "#3A3A3C",
});
const EDGE = DynamicColorIOS({
  dark: "#00000000",
  light: "#00000000",
  highContrastDark: "#FFFFFF",
  highContrastLight: "#FFFFFF",
});

/** A surface for controls: regular glass, dark so white symbols read over bright pictures. */
export function Glass({ style, children }: { style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const { reduceTransparency, reduceMotion } = useAccessibility();
  if (supported && !reduceTransparency) {
    return (
      <GlassView
        style={style}
        glassEffectStyle={{ style: "regular", animate: !reduceMotion }}
        colorScheme="dark"
        isInteractive
      >
        {children}
      </GlassView>
    );
  }
  return <View style={[style, styles.solid]}>{children}</View>;
}

/** A symbol button with a 44 point target. */
export function IconButton({
  symbol,
  label,
  onPress,
  size = 20,
  testID,
}: {
  symbol: SFSymbol;
  label: string;
  onPress: () => void;
  size?: number;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.button}
      testID={testID}
    >
      <SymbolView name={symbol} size={size} tintColor="#FFFFFF" weight="semibold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  solid: { backgroundColor: SOLID, borderColor: EDGE, borderWidth: 1 },
  button: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
});
