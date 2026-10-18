import { NativeTabs } from "expo-router/native-tabs";
import { useSegments } from "expo-router";
import { NowPlaying } from "../../accessory.tsx";
import { useCloseOnTabChange } from "../../header.tsx";
import { usePlayback } from "../../playback.ts";
import { useVirtualisedScreen } from "../../tab-bar.ts";

// The system tab bar, Liquid Glass from iOS 26: Home, Live, Movies and Series, with Search in
// every screen's top bar instead of a tab of its own. While Watch is closed with something in
// Picture in Picture, on AirPlay or set aside for Downloads or Settings, the now playing accessory
// sits above the bar. The bar shrinks as Home, the shelves of Movies and Series and their details
// scroll: iOS can't follow a virtualised list, as Live's and the poster grids are, so there it
// stays put. Selecting another tab closes the Downloads, Settings and provider form the last one
// had open (`useCloseOnTabChange`).
export default function TabsLayout() {
  useCloseOnTabChange();
  const { phase, watch, pip, external, aside } = usePlayback();
  const segments: readonly string[] = useSegments();
  const virtualised = useVirtualisedScreen();
  const accessory = phase.kind !== "idle" && !watch && (pip || external || aside);
  const shrinks = ["(home)", "films", "series"].includes(segments[1] ?? "") && !virtualised;
  return (
    <NativeTabs
      tintColor="#FFFFFF"
      backgroundColor="#000000"
      disableTransparentOnScrollEdge
      minimizeBehavior={shrinks ? "onScrollDown" : "never"}
    >
      {accessory ? (
        <NativeTabs.BottomAccessory>
          <NowPlaying />
        </NativeTabs.BottomAccessory>
      ) : null}
      <NativeTabs.Trigger name="(home)" testID="tab-home">
        <NativeTabs.Trigger.Icon sf="house.fill" />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="live" testID="tab-live">
        <NativeTabs.Trigger.Icon sf="play.tv" />
        <NativeTabs.Trigger.Label>Live</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="films" testID="tab-films">
        <NativeTabs.Trigger.Icon sf="film" />
        <NativeTabs.Trigger.Label>Movies</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="series" testID="tab-series">
        <NativeTabs.Trigger.Icon sf="rectangle.stack" />
        <NativeTabs.Trigger.Label>Series</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
