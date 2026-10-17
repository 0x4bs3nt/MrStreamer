import { router, Stack, useNavigation, useRoute } from "expo-router";
import { useEffect } from "react";

/**
 * Home, with Downloads and Settings opening from its system glass buttons, and Settings' provider
 * form above Settings. Home opens at its root from the other tabs: what it pushed closes as the
 * viewer leaves for another tab, while Movies and Series keep their stacks. A screen over all the
 * tabs, as Runtime proof, leaves it open to go back to.
 */
export default function HomeLayout() {
  const navigation = useNavigation();
  const { key } = useRoute();
  useEffect(
    () =>
      navigation.addListener("blur", () => {
        const tabs = navigation.getState();
        if (!tabs || tabs.routes[tabs.index]?.key === key) return;
        const stack = tabs.routes.find((route) => route.key === key)?.state?.key;
        if (stack) navigation.dispatch({ type: "POP_TO_TOP", target: stack });
      }),
    [navigation, key],
  );
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: "#000000" },
        headerTintColor: "#FFFFFF",
        headerTitleStyle: { color: "#FFFFFF" },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "",
          headerTransparent: true,
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: "Downloads",
              icon: { type: "sfSymbol", name: "arrow.down.circle" },
              onPress: () => router.push("/downloads"),
            },
            {
              type: "button",
              label: "Settings",
              icon: { type: "sfSymbol", name: "gearshape" },
              onPress: () => router.push("/settings"),
            },
          ],
        }}
      />
      <Stack.Screen name="downloads" options={{ title: "Downloads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
    </Stack>
  );
}
