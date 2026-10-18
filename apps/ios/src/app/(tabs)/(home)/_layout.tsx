import { Stack } from "expo-router";
import { tabScreenOptions } from "../../../header.tsx";

/**
 * Home, with the shared top bar (`header.tsx`): Downloads and Settings open on its stack, and
 * Settings' provider form above Settings. Home opens at its root from the other tabs: what it
 * pushed closes as the viewer leaves for another tab.
 */
export default function HomeLayout() {
  return (
    <Stack screenOptions={tabScreenOptions("(home)")}>
      <Stack.Screen name="index" options={{ title: "", headerTransparent: true }} />
      <Stack.Screen name="downloads" options={{ title: "Downloads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
    </Stack>
  );
}
