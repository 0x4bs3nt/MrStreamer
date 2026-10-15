import { router, Stack } from "expo-router";

/** Home, with Downloads and Settings opening from its system glass buttons. */
export default function HomeLayout() {
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
    </Stack>
  );
}
