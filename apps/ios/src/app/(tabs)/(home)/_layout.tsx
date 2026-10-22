import { Stack } from "expo-router";
import { tabScreenOptions } from "../../../header.tsx";

/**
 * Home, with the shared top bar (`header.tsx`): Downloads and Settings open on its stack, and
 * Settings' provider form and Licences above Settings. Those close as the viewer leaves for
 * another tab. The Watchlist and Favourites are Home's own, and stay, as Movies' and Series'
 * details do.
 */
export default function HomeLayout() {
  return (
    <Stack screenOptions={tabScreenOptions("(home)")}>
      <Stack.Screen name="index" options={{ title: "", headerTransparent: true }} />
      <Stack.Screen name="watchlist" options={{ title: "Watchlist" }} />
      <Stack.Screen name="favourites" options={{ title: "Favourites" }} />
      <Stack.Screen name="downloads" options={{ title: "Downloads" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="provider" options={{ title: "" }} />
      <Stack.Screen name="licences" options={{ title: "Licences" }} />
      <Stack.Screen name="licence" options={{ title: "" }} />
    </Stack>
  );
}
