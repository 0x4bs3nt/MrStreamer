import { Stack } from "expo-router";

/** Movies: its tabs of shelves and grids, with collections and details pushed over them. */
export default function FilmsLayout() {
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: "#000000" },
        headerTintColor: "#FFFFFF",
        headerTitleStyle: { color: "#FFFFFF" },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Movies", headerLargeTitle: true }} />
      <Stack.Screen name="collection/[id]" options={{ title: "" }} />
      <Stack.Screen name="title/[id]" options={{ title: "", headerTransparent: true }} />
    </Stack>
  );
}
