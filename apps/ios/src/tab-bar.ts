import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { store, useStore } from "./store.ts";

// Whether the tab bar may shrink as the screen scrolls. iOS follows a scroll view but not a
// virtualised list, so a screen showing one says so while it is in front, and the bar stays put.

const virtualised = store(false);

export const useVirtualisedScreen = () => useStore(virtualised);

/** Keeps the tab bar fixed while the calling screen is in front, when `shown`. */
export function useFixedTabBar(shown: boolean) {
  useFocusEffect(
    useCallback(() => {
      virtualised.set(shown);
      return () => virtualised.set(false);
    }, [shown]),
  );
}
