import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { VideoView } from "expo-video";
import { useCallback } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { loadCatalogue, playChannel, useCatalogue } from "../../../account.ts";
import { describeError } from "../../../errors.ts";
import { Glass, IconButton } from "../../../glass.tsx";
import type { Library } from "../../../library.ts";
import {
  openWatch,
  player,
  retry,
  setMuted,
  playingChannelId,
  usePlayback,
  type Playback,
} from "../../../playback.ts";
import { useSavedState } from "../../../storage.ts";
import { ChannelRow, colors, Message, useRowHeight } from "../../../ui.tsx";

const RECENT_LINES = 5;

/**
 * Home: the Stage, a muted preview of what plays, then the channels watched lately. Films and
 * series rows, the watchlist and downloads join it as they come to iOS.
 */
export default function Home() {
  const catalogue = useCatalogue();
  const { recent } = useSavedState();
  const playback = usePlayback();
  const height = useRowHeight();
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const recentChannels = library
    ? recent.flatMap((id) => {
        const channel = library.byId.get(id);
        return channel ? [channel] : [];
      })
    : [];
  const preview = useCallback(
    (channel: ListedChannel) =>
      library && playChannel(channel, placeOf(library, channel), { watch: false }),
    [library],
  );
  const playingId = playingChannelId(playback.phase);

  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Stage
        playback={playback}
        last={recentChannels[0] ?? null}
        onPlayLast={() => recentChannels[0] && preview(recentChannels[0])}
      />
      {recentChannels.length > 0 ? (
        <Text style={styles.section} accessibilityRole="header">
          Recently watched
        </Text>
      ) : null}
      {library
        ? recentChannels
            .slice(0, RECENT_LINES)
            .map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                detail={placeOf(library, channel)}
                playing={channel.id === playingId}
                height={height}
                onPress={preview}
              />
            ))
        : null}
      {catalogue.kind === "loading" ? <Message text="Loading channels" /> : null}
      {catalogue.kind === "failed" ? (
        <Message
          text={describeError(catalogue.error)}
          action={{ label: "Try again", onPress: loadCatalogue }}
        />
      ) : null}
      {library && recentChannels.length === 0 && playback.phase.kind === "idle" ? (
        <Message text="Pick a channel in Live." />
      ) : null}
    </ScrollView>
  );
}

const placeOf = (library: Library, channel: ListedChannel) => library.placeOf.get(channel.id) ?? "";

/**
 * The preview of the one player, muted until unmuted here or opened in Watch. It shows no
 * picture while Watch, Picture in Picture or AirPlay shows it instead.
 */
function Stage({
  playback,
  last,
  onPlayLast,
}: {
  playback: Playback;
  last: ListedChannel | null;
  onPlayLast: () => void;
}) {
  const { phase, watch, pip, external, muted } = playback;
  const shows =
    (phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused") &&
    !watch &&
    !pip;
  const title = phase.kind === "idle" ? (last?.title ?? "Nothing playing") : phase.channel.title;
  const status =
    phase.kind === "idle"
      ? last
        ? "Last watched"
        : ""
      : phase.kind === "failed"
        ? phase.error
        : external
          ? "Playing on AirPlay"
          : pip
            ? "Picture in Picture"
            : phase.kind === "loading"
              ? "Connecting"
              : phase.kind === "paused"
                ? "Paused"
                : muted
                  ? "Muted"
                  : "Live";
  return (
    <View style={styles.stage} testID="home-stage">
      {shows ? (
        <VideoView
          player={player()}
          nativeControls={false}
          contentFit="contain"
          allowsPictureInPicture={false}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View style={styles.caption} pointerEvents="none">
        <Text style={styles.stageTitle} numberOfLines={1}>
          {title}
        </Text>
        {status ? (
          <Text style={styles.stageStatus} numberOfLines={2} testID="home-stage-status">
            {status}
          </Text>
        ) : null}
      </View>
      {phase.kind === "idle" && !last ? null : (
        <Glass style={styles.capsule}>
          {phase.kind === "idle" ? (
            <IconButton
              symbol="play.fill"
              label={`Play ${title}`}
              onPress={onPlayLast}
              testID="home-play"
            />
          ) : phase.kind === "failed" ? (
            <IconButton
              symbol="arrow.clockwise"
              label="Try again"
              onPress={retry}
              testID="home-retry"
            />
          ) : (
            <>
              <IconButton
                symbol={muted ? "speaker.slash.fill" : "speaker.wave.2.fill"}
                label={muted ? "Unmute" : "Mute"}
                onPress={() => setMuted(!muted)}
                testID="home-mute"
              />
              <IconButton
                symbol="arrow.up.left.and.arrow.down.right"
                label="Full screen"
                onPress={openWatch}
                testID="home-watch"
              />
            </>
          )}
        </Glass>
      )}
    </View>
  );
}

const shadow = {
  textShadowColor: "#000000",
  textShadowRadius: 6,
  textShadowOffset: { width: 0, height: 1 },
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  stage: {
    marginHorizontal: 16,
    marginTop: 4,
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#000000",
    borderColor: colors.line,
    borderWidth: StyleSheet.hairlineWidth,
  },
  caption: { position: "absolute", left: 12, right: 120, bottom: 12 },
  stageTitle: { color: colors.text, fontSize: 17, fontWeight: "700", ...shadow },
  stageStatus: { color: colors.text, fontSize: 13, marginTop: 2, ...shadow },
  capsule: {
    position: "absolute",
    right: 10,
    bottom: 10,
    flexDirection: "row",
    borderRadius: 22,
    paddingHorizontal: 2,
  },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 20,
    marginBottom: 4,
    marginHorizontal: 16,
  },
});
