import { NativeTabs } from "expo-router/native-tabs";
import { useSegments } from "expo-router";
import { NowPlaying } from "../../accessory.tsx";
import { usePlayback } from "../../playback.ts";

// The system tab bar, Liquid Glass from iOS 26. While Picture in Picture or AirPlay plays and
// Watch is closed, the now playing accessory sits above it. The bar shrinks on Home's scrolling
// only: iOS can't follow Live's and Search's virtualised lists, so there it stays put.
export default function TabsLayout() {
  const { phase, watch, pip, external } = usePlayback();
  const segments: readonly string[] = useSegments();
  const accessory = phase.kind !== "idle" && !watch && (pip || external);
  return (
    <NativeTabs
      tintColor="#FFFFFF"
      backgroundColor="#000000"
      disableTransparentOnScrollEdge
      minimizeBehavior={segments[1] === "(home)" ? "onScrollDown" : "never"}
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
        <NativeTabs.Trigger.Label>Films</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="series" testID="tab-series">
        <NativeTabs.Trigger.Icon sf="rectangle.stack" />
        <NativeTabs.Trigger.Label>Series</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search" testID="tab-search">
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
