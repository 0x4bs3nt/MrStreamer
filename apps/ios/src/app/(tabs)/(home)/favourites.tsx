import { FavouritesScreen } from "../../../favourites-screen.tsx";
import { useFixedTabBar } from "../../../tab-bar.ts";

/** Every favourite, pushed from its heading on Home. */
export default function Favourites() {
  // A virtualised list: iOS can't shrink the tab bar as it scrolls.
  useFixedTabBar(true);
  return <FavouritesScreen />;
}
