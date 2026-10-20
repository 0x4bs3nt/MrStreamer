import { Stack } from "expo-router";
import { tabScreenOptions } from "../../../header.tsx";

/**
 * Live: its tabs of shelves, tiles and the channel list, with a category's channels pushed over
 * them, and the shared top bar's Downloads and Settings, which close as the viewer leaves the tab.
 */
export default function LiveLayout() {
  return (
    <Stack screenOptions={tabScreenOptions("live")}>
      <Stack.Screen name="index" options={{ title: "Live", headerLargeTitle: true }} />
      <Stack.Screen name="category" options={{ title: "" }} />
      <Stack.Screen name="downloads" options={{ title: "Downloads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
      <Stack.Screen name="licences" options={{ title: "Licences" }} />
      <Stack.Screen name="licence" options={{ title: "" }} />
    </Stack>
  );
}
