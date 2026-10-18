import { Stack } from "expo-router";
import { tabScreenOptions } from "../../../header.tsx";

/** Live, with the shared top bar: Downloads and Settings open on its stack and close as it's left. */
export default function LiveLayout() {
  return (
    <Stack screenOptions={tabScreenOptions("live")}>
      <Stack.Screen name="index" options={{ title: "Live" }} />
      <Stack.Screen name="downloads" options={{ title: "Downloads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
    </Stack>
  );
}
