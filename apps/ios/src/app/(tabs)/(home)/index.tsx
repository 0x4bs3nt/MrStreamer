import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { VideoView } from "expo-video";
import { useCallback, useMemo } from "react";
import { ActionSheetIOS, ScrollView, StyleSheet, Text, View } from "react-native";
import { loadCatalogue, playChannel, useCatalogue } from "../../../account.ts";
import { describeError } from "../../../errors.ts";
import { Glass, IconButton } from "../../../glass.tsx";
import type { Library } from "../../../library.ts";
import {
  openWatch,
  player,
  retry,
  setMuted,
  playingId,
  usePlayback,
  type Playback,
} from "../../../playback.ts";
import { openDetails, resume, useContinueWatching } from "../../../resume.ts";
import { useSavedState } from "../../../storage.ts";
import { named, useMetadataVersion, useTitleLists } from "../../../titles.ts";
import { Shelf } from "../../../titles-ui.tsx";
import { ChannelRow, colors, Message, useRowHeight } from "../../../ui.tsx";
import { removeFromContinue } from "../../../viewing.ts";
import { useWatchlist, watchlistTitles } from "../../../watchlist.ts";

const RECENT_LINES = 5;

/**
 * Home: the Stage, a muted preview of what plays, then Continue watching, the watchlist and the
 * channels watched lately. Downloads join it as they come to iOS.
 */
export default function Home() {
  const catalogue = useCatalogue();
  const { recent } = useSavedState();
  const playback = usePlayback();
  const height = useRowHeight();
  const continuing = useContinueWatching();
  const saved = useWatchlist();
  const titlesShown = continuing.length > 0 || saved.length > 0;
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
  const playing = playingId(playback.phase);

  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Stage
        playback={playback}
        last={recentChannels[0] ?? null}
        onPlayLast={() => recentChannels[0] && preview(recentChannels[0])}
      />
      <TitleRows />
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
                playing={channel.id === playing}
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
      {library && recentChannels.length === 0 && playback.phase.kind === "idle" && !titlesShown ? (
        <Message text="Pick a channel in Live, or a film or series." />
      ) : null}
    </ScrollView>
  );
}

const placeOf = (library: Library, channel: ListedChannel) => library.placeOf.get(channel.id) ?? "";

/** Continue watching and the watchlist, as rows of posters. */
function TitleRows() {
  const continuing = useContinueWatching();
  const lists = useTitleLists();
  const saved = useWatchlist();
  const metadata = useMetadataVersion();
  const watchlist = useMemo(
    () =>
      lists.kind === "ready"
        ? watchlistTitles(lists.index, saved).flatMap(({ title }) => (title ? [named(title)] : []))
        : [],
    // A new metadata version renames titles.
    [lists, saved, metadata],
  );
  const entryOf = (key: string) => continuing.find((entry) => entry.title.key === key);
  return (
    <>
      {continuing.length > 0 ? (
        <Shelf
          name="Continue watching"
          titles={continuing.map((entry) => entry.title)}
          lines={(title) => entryOf(title.key)?.line}
          done={(title) => entryOf(title.key)?.done ?? null}
          onPress={(title) => {
            const entry = entryOf(title.key);
            if (entry) resume(entry);
          }}
          onLongPress={(title) =>
            ActionSheetIOS.showActionSheetWithOptions(
              {
                title: title.title,
                options: ["Details", "Remove from Continue watching", "Cancel"],
                destructiveButtonIndex: 1,
                cancelButtonIndex: 2,
              },
              (index) => {
                if (index === 0) openDetails({ ...title, ...entryOf(title.key)?.version });
                if (index === 1) void removeFromContinue(title).catch(() => undefined);
              },
            )
          }
        />
      ) : null}
      {watchlist.length > 0 ? (
        <Shelf name="Watchlist" titles={watchlist} onPress={(title) => openDetails(title)} />
      ) : null}
    </>
  );
}

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
  const title = phase.kind === "idle" ? (last?.title ?? "Nothing playing") : phase.item.title;
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
