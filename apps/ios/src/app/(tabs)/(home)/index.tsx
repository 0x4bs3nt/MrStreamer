import { router } from "expo-router";
import { VideoView } from "expo-video";
import { useCallback, useMemo } from "react";
import { ActionSheetIOS, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { playChannel, retryChannels, useCatalogue } from "../../../account.ts";
import { failureOf } from "../../../errors.ts";
import { Glass, IconButton } from "../../../glass.tsx";
import type { Channel, Library } from "../../../library.ts";
import {
  openWatch,
  player,
  retry,
  setMuted,
  playingChannel,
  usePlayback,
  type Playback,
} from "../../../playback.ts";
import { openDetails, resume, useContinueWatching } from "../../../resume.ts";
import { useSavedState } from "../../../storage.ts";
import { collectionOf, named, rowsOf, useMetadataVersion, useTitleLists } from "../../../titles.ts";
import { Shelf } from "../../../titles-ui.tsx";
import { ChannelLogo, colors, Message, Notice } from "../../../ui.tsx";
import { removeFromContinue } from "../../../viewing.ts";
import { useWatchlist, watchlistTitles } from "../../../watchlist.ts";

/** How many channels On now shows. */
const ON_NOW = 12;
/** How many movies Home shows before the Movies tab. */
const MOVIES = 20;

/**
 * Home: the Stage, a muted preview of what plays or of the channel to play, then On now,
 * Continue watching, the watchlist and Movies for you. On now lists the channels watched lately,
 * or the first of Live's country until there are any; their programmes join when iOS reads a
 * guide, favourites when iOS has them. Downloads join Home as they come to iOS.
 */
export default function Home() {
  const catalogue = useCatalogue();
  const { recentChannels: recent = [], region } = useSavedState();
  const playback = usePlayback();
  const continuing = useContinueWatching();
  const saved = useWatchlist();
  const titlesShown = continuing.length > 0 || saved.length > 0;
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const recentChannels = library
    ? recent.flatMap((key) => {
        const channel = library.byKey.get(key);
        return channel ? [channel] : [];
      })
    : [];
  const listed =
    recentChannels.length > 0
      ? recentChannels
      : ((library?.regions.find((each) => each.name === region) ?? library?.regions[0])?.channels ??
        []);
  const onNow = listed.slice(0, ON_NOW);
  const preview = useCallback(
    (channel: Channel) =>
      library && playChannel(channel, placeOf(library, channel), { watch: false }),
    [library],
  );
  const playing = playingChannel(playback.phase);
  const suggested = onNow[0] ?? null;
  const shown =
    playback.phase.kind === "idle"
      ? suggested
      : playback.phase.item.live
        ? (library?.byKey.get(playback.phase.item.id) ?? null)
        : null;

  return (
    <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic">
      <Stage
        playback={playback}
        channel={shown}
        line={
          !suggested
            ? ""
            : recentChannels.length > 0
              ? "Last watched"
              : library
                ? placeOf(library, suggested)
                : ""
        }
        onPlay={() => suggested && preview(suggested)}
      />
      {library && onNow.length > 0 ? (
        <OnNow channels={onNow} library={library} playing={playing} onPress={preview} />
      ) : null}
      {catalogue.kind === "failed" ? (
        <Notice
          failure={failureOf(catalogue.error, catalogue.member.entry.server)}
          actions={[{ label: "Try again", onPress: retryChannels }]}
        />
      ) : null}
      <TitleRows />
      <MoviesForYou />
      {catalogue.kind === "loading" ? <Message text="Loading channels" /> : null}
      {library && onNow.length === 0 && playback.phase.kind === "idle" && !titlesShown ? (
        <Message text="Pick a channel in Live, or a movie or series." />
      ) : null}
    </ScrollView>
  );
}

const placeOf = (library: Library, channel: Channel) => library.placeOf.get(channel.key) ?? "";

/** Channels as a row of logos to preview on the Stage, with All channels opening Live. */
function OnNow({
  channels,
  library,
  playing,
  onPress,
}: {
  channels: readonly Channel[];
  library: Library;
  playing: string | null;
  onPress: (channel: Channel) => void;
}) {
  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Text style={styles.section} accessibilityRole="header">
          On now
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.navigate("/live")}
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}
          testID="home-all-channels"
        >
          <Text style={styles.linkText}>All channels</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tiles}
      >
        {channels.map((channel) => {
          const line = channel.key === playing ? "Playing" : shelfOf(placeOf(library, channel));
          return (
            <Pressable
              key={channel.key}
              accessibilityRole="button"
              accessibilityLabel={[channel.title, line].filter(Boolean).join(", ")}
              onPress={() => onPress(channel)}
              style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              testID={`home-channel-${channel.key}`}
            >
              <ChannelLogo channel={channel} style={styles.tileLogo} large />
              <Text style={styles.tileName} numberOfLines={1}>
                {channel.title}
              </Text>
              {line ? (
                <Text style={styles.tileLine} numberOfLines={1}>
                  {line}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** "News" from "Netherlands · News": the country is Live's menu, the tile says the category. */
const shelfOf = (place: string) => place.split(" · ").at(-1) ?? place;

/**
 * Movies for you: the Movies tab's first For you row. Without TMDB's metadata that is what the
 * provider added lately, and failing that the provider's own list.
 */
function MoviesForYou() {
  const lists = useTitleLists();
  const metadata = useMetadataVersion();
  const shelf = useMemo(() => {
    if (lists.kind !== "ready") return null;
    const [row] = rowsOf(lists.index, "movie", "for-you", null);
    if (row) return { name: "Movies for you", titles: row.titles };
    const all = collectionOf(lists.index, "movie", "all").titles.slice(0, MOVIES);
    return all.length > 0 ? { name: "Movies", titles: all } : null;
    // A new metadata version changes what For you holds.
  }, [lists, metadata]);
  if (!shelf) return null;
  return <Shelf name={shelf.name} titles={shelf.titles} onPress={(title) => openDetails(title)} />;
}

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
 * picture while Watch, Picture in Picture or AirPlay shows it instead. Idle, it shows the channel
 * Play starts: the last watched, or the first of On now. A channel without a picture yet shows
 * its logo.
 */
function Stage({
  playback,
  channel,
  line,
  onPlay,
}: {
  playback: Playback;
  /** The channel playing, or the one Play starts. */
  channel: Channel | null;
  /** Under the name while idle: why this channel. */
  line: string;
  onPlay: () => void;
}) {
  const { phase, watch, pip, external, muted } = playback;
  const shows =
    (phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused") &&
    !watch &&
    !pip;
  const title = phase.kind === "idle" ? (channel?.title ?? "Nothing playing") : phase.item.title;
  const status =
    phase.kind === "idle"
      ? line
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
  // The logo where the picture isn't: idle, connecting, failed, or shown elsewhere.
  const logo = channel && (phase.kind !== "playing" || !shows) ? channel : null;
  return (
    <View style={styles.stage} testID="home-stage">
      {logo ? (
        <View style={styles.stageLogo} pointerEvents="none">
          <ChannelLogo channel={logo} style={styles.stageMark} large />
        </View>
      ) : null}
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
      {phase.kind === "idle" && !channel ? null : (
        <Glass style={styles.capsule}>
          {phase.kind === "idle" ? (
            <IconButton
              symbol="play.fill"
              label={`Play ${title}`}
              onPress={onPlay}
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
  stageLogo: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  stageMark: { width: "34%", aspectRatio: 16 / 10, backgroundColor: "transparent" },
  block: { marginTop: 18 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginBottom: 8,
    minHeight: 32,
  },
  section: { color: colors.text, fontSize: 20, fontWeight: "700", flexShrink: 1 },
  link: { minHeight: 44, justifyContent: "center" },
  linkText: { color: colors.text, fontSize: 15 },
  pressed: { opacity: 0.6 },
  tiles: { paddingHorizontal: 16, gap: 10 },
  tile: { width: 112 },
  tileLogo: { width: 112, height: 63 },
  tileName: { color: colors.text, fontSize: 13, marginTop: 6 },
  tileLine: { color: colors.dim, fontSize: 12, marginTop: 1 },
});
