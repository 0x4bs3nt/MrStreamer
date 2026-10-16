import { DownloadsScreen } from "../../../downloads-screen.tsx";
import { useFixedTabBar } from "../../../tab-bar.ts";

/** Downloads, pushed from Home's glass button and Settings' Downloads row. */
export default function Downloads() {
  // A virtualised list: iOS can't shrink the tab bar as it scrolls.
  useFixedTabBar(true);
  return <DownloadsScreen />;
}
