import type {
  Episode,
  EpisodeDetails,
  SeriesDetails,
  Title,
  TitleDetails,
  TitleKind,
  TitleRef,
} from "@mrstreamer/contracts/ondemand";
import { formatBytes } from "@mrstreamer/core/i18n";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { EpisodeMark, SeriesViewing, TitleProgress } from "@mrstreamer/contracts/viewing";
import { versionOptions } from "@mrstreamer/core/ondemand/version-options";
import {
  automaticVersion,
  resumePoint,
  runtime,
  timeLeftOf,
} from "@mrstreamer/core/viewing/continue";
import { continuation, episodeStates } from "@mrstreamer/core/viewing/episodes";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import {
  actionsOf,
  DownloadButton,
  downloadAction,
  showActions,
  stateWord,
  type DownloadAction,
} from "./download-controls.tsx";
import { useDownloadOf } from "./downloads.ts";
import { Glass } from "./glass.tsx";
import { failureOf, playEpisode, playMovie, useFailure, type Failure } from "./play-title.ts";
import { useRead, type Loaded } from "./read.ts";
import { members, retryTitles, useRoster } from "./account.ts";
import { describeError } from "./errors.ts";
import { Docked, loadingStatus, PlaceholderLines, Placeholders, Shape } from "./loading.tsx";
import { openDetails, versionOf } from "./resume.ts";
import {
  detailsOf,
  episodesOf,
  titleOf,
  useCollections,
  useMetadataVersion,
  useTitleLists,
} from "./titles.ts";
import { Artwork, ProgressLine, Shelf, TextTabs } from "./titles-ui.tsx";
import { colors, Message } from "./ui.tsx";
import { markEpisode, progressOf, relist, seriesViewing, undoMark, useViewing } from "./viewing.ts";
import { removeTitle, saveTitle, savedEntry, useWatchlist } from "./watchlist.ts";

// A movie's or series' details, pushed on the Movies or Series tab: the backdrop with one glass
// capsule over it (Play or Resume, Save, and for a movie Download), the facts, the version menu,
// and for a series its seasons as text tabs over episode rows with stills, how far each got and
// each one's download button. Long-press marks an episode watched or unwatched, with the
// desktop's Undo line, and offers its download's actions. Play and Resume always stream; a
// download plays offline from its own menu, from an episode's check, and from Downloads. Closing
// Watch comes back here, as it lies over the navigation.

const NONE: readonly TitleProgress[] = [];

/** What the version menu says of a version that failed. */
function failureNote(failure: Failure | undefined): string | null {
  return failure === "file"
    ? "Didn't play here"
    : failure === "episode"
      ? "An episode didn't play here"
      : null;
}

/** The details of the title whose version `version` (an `ownedKey`) names. */
export function DetailsScreen({ kind, version }: { kind: TitleKind; version: string }) {
  const lists = useTitleLists();
  const metadata = useMetadataVersion();
  const opened = useMemo(() => versionOf(version), [version]);
  const title = useMemo(
    () => (lists.kind === "ready" && opened ? titleOf(lists.index, kind, opened) : undefined),
    [lists, kind, opened, metadata],
  );
  if (lists.kind === "failed") {
    return (
      <Message
        text={describeError(lists.error)}
        action={{ label: "Try again", onPress: retryTitles }}
      />
    );
  }
  if (lists.kind !== "ready") {
    return (
      <Docked status={loadingStatus("movies and series")}>
        <Placeholders testID="details-placeholder">
          <Shape style={[styles.backdrop, styles.stillBackdrop]} />
          <View style={styles.facts}>
            <Shape style={styles.nameShape} />
            <Shape style={styles.lineShape} />
          </View>
        </Placeholders>
      </Docked>
    );
  }
  if (!title || !opened) return <Message text="The provider no longer lists this title." />;
  return <Details title={title} opened={opened} />;
}

function Details({ title, opened }: { title: Title; opened: OwnedId }) {
  const viewing = useViewing();
  const watchlist = useWatchlist();
  const [picked, setPicked] = useState<OwnedId | null>(null);
  const sequence = viewing?.sequence ?? 0;
  const versions = useMemo(() => title.versions.map(ownedId), [title]);

  // How far every version got: a movie's own, a series' episodes in the version shown.
  const progress = useRead(
    `${title.kind}|${versions.map(ownedKey).join(",")}`,
    useCallback(
      () => progressOf(title.kind === "movie" ? { movies: versions } : { series: versions }),
      [title.kind, versions],
    ),
    sequence,
  );
  const played = progress.kind === "ready" ? progress.value : NONE;
  // A version picked from a subscription removed since, or from a menu shown before then, is
  // forgotten: the title's own choice shows, and stays when that subscription is added again.
  const listed = picked && title.versions.some((each) => sameOwned(each, picked)) ? picked : null;
  if (picked !== listed) setPicked(null);
  // Kept by its ids, so a render that works out the same version reads nothing again.
  const chosen = listed ?? automaticVersion(title, played, opened);
  const version = useMemo(
    () => ({ subscriptionId: chosen.subscriptionId, id: chosen.id }),
    [chosen.subscriptionId, chosen.id],
  );
  const shownTitle = useMemo(() => ({ ...title, ...version }), [title, version]);
  // Details answer only the version they were read for: another version shows loading at once.
  // Try again reads the same version anew; until that answers, its facts show as loading.
  const [again, setAgain] = useState(0);
  const [retried, setRetried] = useState<Loaded<TitleDetails> | null>(null);
  const details = useRead(
    `${title.kind}|${ownedKey(version)}`,
    useCallback(() => detailsOf(shownTitle), [shownTitle]),
    again,
  );
  const failedHere = useFailure(title.kind, version);
  const roster = useRoster();
  // Versions from several subscriptions say which each is from, in the order they were added.
  const providers = useMemo(() => {
    const listed = roster.kind === "ready" ? roster.members : members();
    const labels = new Map(listed.map((member) => [member.entry.id, member.label]));
    const several = new Set(title.versions.map((each) => each.subscriptionId)).size > 1;
    return {
      order: listed.map((member) => member.entry.id),
      label: (subscriptionId: string) => (several ? labels.get(subscriptionId) : undefined),
    };
  }, [roster, title]);
  const saved = savedEntry(watchlist, title) !== undefined;

  const chooseVersion = () => {
    const groups = versionOptions(title.versions, title.originalLanguage, providers.order);
    const choices = groups.flatMap((group) =>
      group.versions.map((each, at) => ({
        version: ownedId(each),
        label: [
          providers.label(group.subscriptionId),
          group.quality,
          group.label + (group.versions.length > 1 ? ` (${at + 1})` : ""),
          failureNote(failureOf(title.kind, each)),
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    );
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Version",
        options: [...choices.map((choice) => choice.label), "Cancel"],
        cancelButtonIndex: choices.length,
      },
      (index) => {
        const choice = choices[index];
        if (choice) setPicked(choice.version);
      },
    );
  };
  const versionLabel = useMemo(() => {
    const groups = versionOptions(title.versions, title.originalLanguage, providers.order);
    const group = groups.find((each) => each.versions.some((v) => sameOwned(v, version)));
    return group
      ? [providers.label(group.subscriptionId), group.quality, group.label]
          .filter(Boolean)
          .join(" · ")
      : "";
  }, [title, version, providers]);

  const facts = details.kind === "ready" ? details.value : null;
  const movieProgress =
    title.kind === "movie" ? played.find(({ title: ref }) => sameOwned(ref, version)) : undefined;

  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={styles.content}
      testID="details"
    >
      <View style={styles.backdrop}>
        <Artwork
          url={facts?.backdropUrl ?? title.backdropUrl ?? title.posterUrl}
          name={title.title}
          width={780}
          style={StyleSheet.absoluteFill}
        />
        <Glass style={styles.capsule}>
          {title.kind === "movie" ? (
            <CapsuleButton
              symbol="play.fill"
              label={movieProgress && !movieProgress.finished ? "Resume" : "Play"}
              onPress={() =>
                // After a failure, Watch closes onto this page and its version menu opens.
                playMovie(shownTitle, version, resumePoint(movieProgress), chooseVersion)
              }
              testID="details-play"
            />
          ) : (
            <SeriesPlay
              details={facts?.kind === "series" ? facts : null}
              version={version}
              onVersions={chooseVersion}
            />
          )}
          <CapsuleButton
            symbol={saved ? "bookmark.fill" : "bookmark"}
            label={saved ? "Saved" : "Save"}
            compact
            onPress={() => (saved ? removeTitle(title) : saveTitle(title))}
            testID="details-save"
          />
          {title.kind === "movie" ? (
            <DownloadButton
              of={{ kind: "movie", ...version }}
              name={title.title}
              style={styles.capsuleButton}
              testID="details-download"
            />
          ) : null}
        </Glass>
      </View>
      <View style={styles.facts}>
        <Text style={styles.name} accessibilityRole="header">
          {title.title}
        </Text>
        <Text style={styles.line}>
          {[
            title.year,
            facts?.duration ? runtime(facts.duration) : null,
            title.kind === "series" && facts?.kind === "series"
              ? `${facts.seasons.length} ${facts.seasons.length === 1 ? "season" : "seasons"}`
              : null,
            (facts?.genres ?? title.genres).slice(0, 2).join(", ") || null,
            title.rating?.toFixed(1),
          ]
            .filter(Boolean)
            .join(" · ")}
          {title.kind === "movie" ? <DownloadFact of={{ kind: "movie", ...version }} /> : null}
        </Text>
        {versionLabel || title.versions.length > 1 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Version, ${versionLabel || "as listed"}`}
            accessibilityHint={title.versions.length > 1 ? "Chooses another version" : undefined}
            disabled={title.versions.length < 2}
            onPress={chooseVersion}
            style={styles.version}
            testID="details-version"
          >
            <Text style={styles.versionText}>
              {versionLabel || "As listed"}
              {title.versions.length > 1 ? "  ⌄" : ""}
            </Text>
          </Pressable>
        ) : null}
        {failedHere ? (
          <Text style={styles.failure} testID="details-failed">
            {`${failedHere === "episode" ? `An episode of ${versionLabel || "this version"}` : versionLabel || "This version"} didn't play on this iPhone.${title.versions.length > 1 ? " Try another version." : ""}`}
          </Text>
        ) : null}
        {movieProgress ? <Text style={styles.left}>{timeLeftOf(movieProgress) ?? ""}</Text> : null}
        {details.kind === "failed" && details !== retried ? (
          <Message
            text={details.error}
            action={{
              label: "Try again",
              onPress: () => {
                setRetried(details);
                setAgain((count) => count + 1);
              },
            }}
          />
        ) : facts ? (
          <About facts={facts} provider={!title.tmdbId} />
        ) : (
          <PlaceholderLines widths={["100%", "92%", "56%"]} />
        )}
      </View>
      {facts?.kind === "series" ? (
        <Seasons
          details={facts}
          title={shownTitle}
          version={version}
          sequence={sequence}
          onVersions={chooseVersion}
        />
      ) : null}
      <Related title={title} />
    </ScrollView>
  );
}

/** " · Downloaded, 2.1 GB" or " · Downloading 42%": the facts line's word for a download. */
function DownloadFact({ of: ref }: { of: TitleRef }) {
  const download = useDownloadOf(ref);
  if (!download) return null;
  const size =
    download.status.kind === "complete" && download.size ? `, ${formatBytes(download.size)}` : "";
  return ` · ${stateWord(download)}${size}`;
}

/** The plot and credits; a note where only the provider's facts are known. */
function About({ facts, provider }: { facts: TitleDetails; provider: boolean }) {
  const credits = [
    facts.directors.length > 0
      ? `${facts.kind === "movie" ? "Directed by" : "Created by"} ${facts.directors.slice(0, 2).join(", ")}`
      : null,
    facts.cast.length > 0
      ? `With ${facts.cast
          .slice(0, 4)
          .map((person) => person.name)
          .join(", ")}`
      : null,
  ].filter(Boolean);
  return (
    <>
      {facts.plot ? <Text style={styles.plot}>{facts.plot}</Text> : null}
      {credits.length > 0 ? <Text style={styles.dim}>{credits.join(" · ")}</Text> : null}
      {provider ? <Text style={styles.dim}>Provider details only.</Text> : null}
    </>
  );
}

/** Play for a series: where its episodes say it goes on. */
function SeriesPlay({
  details,
  version,
  onVersions,
}: {
  details: SeriesDetails | null;
  version: OwnedId;
  onVersions: () => void;
}) {
  const viewing = useViewing();
  const standing = useRead(
    ownedKey(version),
    useCallback(() => seriesViewing(version), [version]),
    viewing?.sequence ?? 0,
  );
  const goesOn =
    details && standing.kind === "ready"
      ? continuation(details, standing.value.progress, standing.value.marks)
      : null;
  const label = !goesOn
    ? "Play"
    : goesOn.resume
      ? `Resume ${episodeLabel(goesOn.episode.season, goesOn.episode.number)}`
      : `Play ${episodeLabel(goesOn.episode.season, goesOn.episode.number)}`;
  return (
    <CapsuleButton
      symbol="play.fill"
      label={label}
      disabled={!details || !goesOn}
      onPress={() =>
        details &&
        goesOn &&
        playEpisode(details, goesOn.episode, resumePoint(goesOn.resume), onVersions)
      }
      testID="details-play"
    />
  );
}

/** Seasons as text tabs, opening on the one being watched, over their episodes. */
function Seasons({
  details,
  title,
  version,
  sequence,
  onVersions,
}: {
  details: SeriesDetails;
  title: Title;
  version: OwnedId;
  sequence: number;
  onVersions: () => void;
}) {
  const standing = useRead(
    ownedKey(version),
    useCallback(() => seriesViewing(version), [version]),
    sequence,
  );
  const [season, setSeason] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ mark: EpisodeMark; label: string } | null>(null);
  // The record goes by the episodes these details list.
  useEffect(() => {
    void relist(version, title).catch(() => undefined);
  }, [version, title]);

  const value: SeriesViewing | null = standing.kind === "ready" ? standing.value : null;
  const watching = value ? continuation(details, value.progress, value.marks) : null;
  const shown =
    details.seasons.find((each) => each.number === season) ??
    details.seasons.find((each) => each.number === watching?.episode.season) ??
    details.seasons[0];
  // Until the season shown answers, its own provider rows show, never another season's.
  const episodes = useRead(
    shown ? `${ownedKey(title)}|${shown.number}` : null,
    useCallback(() => (shown ? episodesOf(title, shown) : Promise.resolve([])), [title, shown]),
  );
  if (!shown) return <Message text="No episodes listed." />;
  const rows: readonly (Episode | EpisodeDetails)[] =
    episodes.kind === "ready" ? episodes.value : shown.episodes;
  const stateOf = value ? episodeStates(value.progress, value.marks) : null;
  const undoable = undo && value?.undoable === undo.mark.revision ? undo : null;

  const mark = (episode: Episode, watched: boolean) =>
    void markEpisode(
      {
        kind: "episode",
        subscriptionId: episode.subscriptionId,
        id: episode.id,
        seriesId: episode.seriesId,
        season: episode.season,
        episode: episode.number,
      },
      watched,
    ).then(
      (made) =>
        made &&
        setUndo({
          mark: made,
          label: `${episodeLabel(episode.season, episode.number)} marked ${watched ? "watched" : "unwatched"}`,
        }),
      () => undefined,
    );

  return (
    <View style={styles.seasons}>
      {details.seasons.length > 1 ? (
        <TextTabs
          tabs={details.seasons.map((each) => ({ value: String(each.number), label: each.name }))}
          value={String(shown.number)}
          onChange={(next) => setSeason(Number(next))}
        />
      ) : (
        <Text style={styles.seasonName}>{shown.name}</Text>
      )}
      {undoable ? (
        <View style={styles.undo} accessibilityLiveRegion="polite">
          <Text style={styles.undoText}>{undoable.label}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setUndo(null);
              void undoMark(version, undoable.mark.revision).catch(() => undefined);
            }}
            style={styles.undoButton}
            testID="episode-undo"
          >
            <Text style={styles.undoLabel}>Undo</Text>
          </Pressable>
        </View>
      ) : null}
      {rows.map((episode) => {
        const state = stateOf?.(episode) ?? { kind: "unwatched" as const };
        const progress = state.kind === "partial" ? state.progress : undefined;
        return (
          <EpisodeRow
            key={episode.id}
            episode={episode}
            name={title.title}
            watched={state.kind === "watched"}
            progress={progress}
            onPlay={() => playEpisode(details, episode, resumePoint(progress), onVersions)}
            onMark={(watched) => mark(episode, watched)}
          />
        );
      })}
    </View>
  );
}

function EpisodeRow({
  episode,
  name,
  watched,
  progress,
  onPlay,
  onMark,
}: {
  episode: Episode | EpisodeDetails;
  /** The series' name, as alerts about its download name the episode. */
  name: string;
  watched: boolean;
  progress: TitleProgress | undefined;
  onPlay: () => void;
  onMark: (watched: boolean) => void;
}) {
  const ref: TitleRef = {
    kind: "episode",
    subscriptionId: episode.subscriptionId,
    id: episode.id,
    seriesId: episode.seriesId,
    season: episode.season,
    episode: episode.number,
  };
  const download = useDownloadOf(ref);
  const named = `${name} · ${episodeLabel(episode.season, episode.number)}`;
  const markLabel = watched ? "Mark unwatched" : "Mark watched";
  // Marking first, then what its download allows, as the sheet and VoiceOver offer them.
  const actions: readonly DownloadAction[] = [
    { label: markLabel, destructive: false, run: () => onMark(!watched) },
    ...(download ? actionsOf(download) : [downloadAction(ref, named)]),
  ];
  const line = [
    episode.duration ? runtime(episode.duration) : null,
    watched ? "Watched" : timeLeftOf(progress),
    download ? stateWord(download) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${episode.number}, ${episode.title}${line ? `, ${line}` : ""}`}
      accessibilityActions={[
        { name: "activate" },
        ...actions.map((action) => ({ name: action.label, label: action.label })),
      ]}
      onAccessibilityAction={(event: AccessibilityActionEvent) => {
        const { actionName } = event.nativeEvent;
        if (actionName === "activate") onPlay();
        else actions.find((action) => action.label === actionName)?.run();
      }}
      onPress={onPlay}
      onLongPress={() => showActions(download, actions)}
      style={({ pressed }) => [styles.episode, pressed && styles.pressed]}
      testID={`episode-${episode.id}`}
    >
      <View>
        <Artwork
          url={episode.stillUrl}
          name={`E${episode.number}`}
          width={342}
          style={styles.still}
        />
        <ProgressLine done={progress ? progress.position / progress.duration : null} />
      </View>
      <View style={styles.episodeText}>
        <Text style={styles.episodeName} numberOfLines={2}>
          {`${episode.number} · ${episode.title}`}
        </Text>
        {line ? <Text style={styles.dim}>{line}</Text> : null}
      </View>
      {watched ? (
        <SymbolView name="checkmark.circle.fill" size={20} tintColor={colors.dim} />
      ) : null}
      <DownloadButton
        of={ref}
        name={named}
        playsCopy
        hidden
        testID={`episode-${episode.id}-download`}
      />
    </Pressable>
  );
}

/** More like this: titles sharing the most genres, from TMDB's metadata. */
function Related({ title }: { title: Title }) {
  const made = useCollections(title.kind, [ownedKey(title)]);
  const like = useMemo(
    () => made?.list(`like:${ownedKey(title)}`).slice(0, 24) ?? [],
    [made, title],
  );
  if (like.length === 0) return null;
  return <Shelf name="More like this" titles={like} onPress={(each) => openDetails(each)} />;
}

/** A button in the details' glass capsule: a symbol, with its label where there's room. */
function CapsuleButton({
  symbol,
  label,
  compact = false,
  disabled = false,
  onPress,
  testID,
}: {
  symbol: SFSymbol;
  label: string;
  compact?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.capsuleButton,
        (pressed || disabled) && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <SymbolView name={symbol} size={18} tintColor="#FFFFFF" weight="semibold" />
      {compact ? null : (
        <Text style={styles.capsuleLabel} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingBottom: 40 },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.35 },
  backdrop: { width: "100%", aspectRatio: 16 / 11, backgroundColor: "#000000" },
  stillBackdrop: { backgroundColor: colors.fill, borderRadius: 0 },
  nameShape: { width: "60%", height: 28 },
  lineShape: { width: "40%", height: 14 },
  capsule: {
    position: "absolute",
    left: 16,
    bottom: 14,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 24,
    paddingHorizontal: 6,
  },
  capsuleButton: {
    minWidth: 44,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 10,
  },
  capsuleLabel: { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
  facts: { paddingHorizontal: 16, paddingTop: 14, gap: 6 },
  name: { color: colors.text, fontSize: 28, fontWeight: "700" },
  line: { color: colors.dim, fontSize: 15 },
  version: { minHeight: 36, justifyContent: "center", alignSelf: "flex-start" },
  versionText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  failure: { color: colors.text, fontSize: 15 },
  left: { color: colors.text, fontSize: 15 },
  plot: { color: colors.text, fontSize: 15, lineHeight: 21, marginTop: 6 },
  dim: { color: colors.dim, fontSize: 13 },
  seasons: { marginTop: 18 },
  seasonName: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
    marginHorizontal: 16,
    minHeight: 44,
    textAlignVertical: "center",
  },
  undo: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginVertical: 4,
  },
  undoText: { color: colors.dim, fontSize: 15, flexShrink: 1 },
  undoButton: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "flex-end" },
  undoLabel: { color: colors.text, fontSize: 15, fontWeight: "700" },
  episode: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 60,
  },
  still: { width: 120, height: 68, borderRadius: 6 },
  episodeText: { flex: 1, minWidth: 0, gap: 2 },
  episodeName: { color: colors.text, fontSize: 15 },
});
