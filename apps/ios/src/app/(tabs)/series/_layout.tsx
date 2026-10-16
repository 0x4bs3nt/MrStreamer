import { Stack } from "expo-router";

/** Series: its tabs of shelves and grids, with collections and details pushed over them. */
export default function SeriesLayout() {
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: "#000000" },
        headerTintColor: "#FFFFFF",
        headerTitleStyle: { color: "#FFFFFF" },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Series", headerLargeTitle: true }} />
      <Stack.Screen name="collection/[id]" options={{ title: "" }} />
      <Stack.Screen name="title/[id]" options={{ title: "", headerTransparent: true }} />
    </Stack>
  );
}
