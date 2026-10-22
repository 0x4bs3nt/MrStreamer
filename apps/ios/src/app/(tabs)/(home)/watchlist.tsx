import { useFixedTabBar } from "../../../tab-bar.ts";
import { WatchlistScreen } from "../../../watchlist-screen.tsx";

/** The whole watchlist, pushed from its heading on Home. */
export default function Watchlist() {
  // A virtualised list: iOS can't shrink the tab bar as it scrolls.
  useFixedTabBar(true);
  return <WatchlistScreen />;
}
