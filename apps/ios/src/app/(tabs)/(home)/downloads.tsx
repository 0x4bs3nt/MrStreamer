import { DownloadsScreen } from "../../../downloads-screen.tsx";
import { useFixedTabBar } from "../../../tab-bar.ts";

/** Downloads, pushed from the top bar's button on any tab, Watch's and Settings' Downloads row. */
export default function Downloads() {
  // A virtualised list: iOS can't shrink the tab bar as it scrolls.
  useFixedTabBar(true);
  return <DownloadsScreen />;
}
