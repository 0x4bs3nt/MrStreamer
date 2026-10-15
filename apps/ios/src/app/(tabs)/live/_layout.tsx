import { Stack } from "expo-router";

export default function LiveLayout() {
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: "#000000" },
        headerTintColor: "#FFFFFF",
        headerTitleStyle: { color: "#FFFFFF" },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Live" }} />
    </Stack>
  );
}
