import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import type { IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Keyboard,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  playChannel,
  retry,
  useCatalogue,
  useRoster,
  type Catalogue,
  type Member,
} from "../account.ts";
import { useReduceMotion } from "../glass.tsx";
import { openOnTabs, useTabs } from "../header.tsx";
import { searchChannels, type Channel, type Library } from "../library.ts";
import { StatusLine, useStatusAnnouncement, useStatusFits, type Status } from "../loading.tsx";
import { channelStatus, usePlayback } from "../playback.ts";
import { openDetails } from "../resume.ts";
import { onSearchText } from "../telemetry/index.ts";
import {
  searchTitles,
  titleCount,
  useMetadataVersion,
  useTitleLists,
  type TitleLists,
} from "../titles.ts";
import { Artwork } from "../titles-ui.tsx";
import { ChannelRow, colors, TextButton, useRowHeight } from "../ui.tsx";

/** Movies and series each show this many at first, and this many more at each Show more. */
const PAGE = 20;

type Row =
  | { readonly kind: "title"; readonly title: Title }
  | { readonly kind: "channel"; readonly channel: Channel };

/** Movies, series or channels found, and how many of them there are in all. */
interface Found {
  readonly title: string;
  readonly total: number;
  readonly data: readonly Row[];
  /** Movies or series with matches still to show: how many Show more adds. */
  readonly more: { readonly kind: TitleKind; readonly count: number } | null;
}

/** How many movies and series the viewer asked to see of the text they asked it of. */
interface Asked {
  readonly query: string;
  readonly limits: Readonly<Record<TitleKind, number>>;
}

const firstPage = (query: string): Asked => ({ query, limits: { movie: PAGE, series: PAGE } });

/** The best `limit` titles of `kind` for `query`, of the lists as they stand; null for none. */
function foundTitles(
  index: IndexedCatalogue,
  kind: TitleKind,
  query: string,
  limit: number,
): Found | null {
  const page = searchTitles(index, kind, query, limit);
  if (page.total === 0) return null;
  const left = page.total - page.titles.length;
  return {
    title: kind === "movie" ? "Movies" : "Series",
    total: page.total,
    data: page.titles.map((title) => ({ kind: "title", title })),
    more: left > 0 ? { kind, count: Math.min(PAGE, left) } : null,
  };
}

/** "Show 20 more movies", "Show 1 more movie", "Show 5 more series". */
const moreLabel = ({ kind, count }: NonNullable<Found["more"]>) =>
  `Show ${count} more ${kind === "series" ? "series" : count === 1 ? "movie" : "movies"}`;

/** What's still to come, or couldn't come, of what Search looks through, in sentences. */
interface SearchStatus {
  readonly text: string;
  /** Providers whose lists are in, of all of them, while some still load. */
  readonly loading: { readonly settled: number; readonly of: number } | null;
  /** Providers whose lists failed, to try again. */
  readonly retry: readonly string[];
  /** A provider failed or asks for its password: Settings is where that's fixed. */
  readonly settings: boolean;
}

const unsettled = (member: Member, list: Pick<Member["live"] | Member["titles"], "kind">) =>
  !member.needsSecret && (list.kind === "loading" || list.kind === "idle");

/** "Channels", "Movies and series", or both, to start a sentence. */
const kinds = (channels: boolean, titles: boolean) =>
  channels && titles ? "Movies, series and channels" : titles ? "Movies and series" : "Channels";

/**
 * How Search's sources stand, or null when every provider's channels, movies and series are in.
 * A provider that failed keeps what it had before in the results, and says so.
 */
function searchStatus(
  members: readonly Member[],
  catalogue: Catalogue,
  lists: TitleLists,
): SearchStatus | null {
  const sentences: string[] = [];
  for (const member of members) {
    const { label, live, titles, needsSecret } = member;
    if (needsSecret) sentences.push(`Enter the password for ${label} in Settings.`);
    else if (live.kind === "failed" && titles.kind === "failed") {
      sentences.push(`Couldn't load channels, movies or series from ${label}.`);
    } else if (live.kind === "failed") sentences.push(`Couldn't load channels from ${label}.`);
    else if (titles.kind === "failed") {
      sentences.push(`Couldn't load movies and series from ${label}.`);
    }
  }
  const failed = sentences.length > 0;
  const channelsLoading =
    catalogue.kind === "loading" || members.some((member) => unsettled(member, member.live));
  const titlesLoading =
    lists.kind === "loading" || members.some((member) => unsettled(member, member.titles));
  const settled = members.filter(
    (member) => !unsettled(member, member.live) && !unsettled(member, member.titles),
  ).length;
  if (channelsLoading || titlesLoading) {
    const count =
      members.length > 1 && settled < members.length
        ? `, ${settled} of ${members.length} providers`
        : "";
    sentences.push(`${kinds(channelsLoading, titlesLoading)} still loading${count}.`);
  }
  if (sentences.length === 0) return null;
  const channels = catalogue.kind === "ready";
  const titles = lists.kind === "ready";
  if (channels || titles) sentences.push(`${kinds(channels, titles)} searched.`);
  return {
    text: sentences.join(" "),
    loading: channelsLoading || titlesLoading ? { settled, of: Math.max(1, members.length) } : null,
    retry: members
      .filter(
        (member) =>
          !member.needsSecret && (member.live.kind === "failed" || member.titles.kind === "failed"),
      )
      .map((member) => member.entry.id),
    settings: failed,
  };
}

/** The query, kept while the app runs: Search opens on it again. */
let kept = "";

/**
 * Search, over the tab it opened from, which stays as it was under it: movies, series
 * and live channels by name, matched as the desktop's search matches words, titles by any of
 * their names, TMDB's translations included, the best first. Movies and series show 20 each, and
 * each has its own Show more for the next 20, or the few left, until every match shows; new text
 * starts both at 20 again. It comes down a little as it fades in, or only fades under Reduce
 * Motion, with the keyboard up. Cancel or a swipe back closes it onto that screen. A title closes
 * it and opens its details in Movies or Series; a channel closes it and plays in Watch, which
 * closes onto that screen too. Searching, and what hasn't loaded or failed, is the status line at
 * the bottom, above the keyboard, or at the top of the results where the bottom has too little
 * room for a line of it.
 */
export default function Search() {
  const tabs = useTabs();
  const insets = useSafeAreaInsets();
  const roster = useRoster();
  const catalogue = useCatalogue();
  const lists = useTitleLists();
  const metadata = useMetadataVersion();
  const { phase } = usePlayback();
  const height = useRowHeight();
  const [query, setQuery] = useState(kept);
  // Results follow the latest text; typing goes on while an earlier search is drawn.
  const typed = useDeferredValue(query);
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const members = roster.kind === "ready" ? roster.members : [];
  const status = searchStatus(members, catalogue, lists);

  const reduceMotion = useReduceMotion();
  const drop = useRef(new Animated.Value(reduceMotion ? 0 : -10)).current;
  useEffect(() => {
    if (!reduceMotion) {
      Animated.timing(drop, { toValue: 0, duration: 180, useNativeDriver: true }).start();
    }
  }, [drop, reduceMotion]);

  // How many movies and series show, for the text searched. New text starts both at the first
  // page again. New lists or metadata keep what was asked, found again in what they hold now, so
  // no row of lists or names since replaced stays and none shows twice.
  const searched = typed.trim();
  const [asked, setAsked] = useState(() => firstPage(searched));
  if (asked.query !== searched) setAsked(firstPage(searched));
  const { limits } = asked.query === searched ? asked : firstPage(searched);
  const index = lists.kind === "ready" ? lists.index : null;
  // Each kind is searched apart, so Show more searches its own kind again and nothing else.
  // A new metadata version adds TMDB's names to search.
  const movies = useMemo(
    () => (index && searched ? foundTitles(index, "movie", typed, limits.movie) : null),
    [index, typed, searched, limits.movie, metadata],
  );
  const series = useMemo(
    () => (index && searched ? foundTitles(index, "series", typed, limits.series) : null),
    [index, typed, searched, limits.series, metadata],
  );
  const channels = useMemo((): Found | null => {
    const found = library ? searchChannels(library, typed) : [];
    return found.length > 0
      ? {
          title: "Channels",
          total: found.length,
          data: found.map((channel) => ({ kind: "channel", channel })),
          more: null,
        }
      : null;
  }, [library, typed]);
  const sections = useMemo(
    () => [movies, series, channels].filter((found) => found !== null),
    [movies, series, channels],
  );
  const showMore = useCallback(
    (section: Found) => {
      if (!section.more) return;
      const { kind } = section.more;
      setAsked({
        query: searched,
        limits: { ...limits, [kind]: section.data.length + PAGE },
      });
    },
    [searched, limits],
  );

  const change = useCallback((text: string) => {
    kept = text;
    setQuery(text);
    onSearchText(text);
  }, []);
  const watch = useCallback(
    (channel: Channel) => {
      if (!library) return;
      close();
      playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true });
    },
    [library],
  );
  const open = useCallback((title: Title) => {
    close();
    openDetails(title);
  }, []);
  // Closes Search and opens Settings on the tab under it.
  const settings = () => (tabs ? openOnTabs(tabs, "settings") : close());

  const playing = channelStatus(phase);
  const searching = typed.trim() !== "";
  // The latest text isn't searched yet: the last results stay meanwhile.
  const pending = query.trim() !== "" && typed !== query;
  const keyboard = useKeyboardHeight();
  // The height under the search field, for results and the status line together; measured as
  // laid out, so a turn of the phone updates it, as the keyboard updates its reserve.
  const [area, setArea] = useState(0);
  const reserve = (keyboard > 0 ? keyboard : insets.bottom) + 8;
  // What the keyboard leaves for results and the line, less the gap above the line.
  const room = area - reserve - 8;
  const line = searchLine(
    query.trim() !== "" ? status : null,
    pending,
    () => status?.retry.forEach((id) => retry(id)),
    settings,
  );
  // The line sits at the bottom, above the keyboard, where its share of the room shows at least
  // a whole line of it. Where it doesn't, as with the largest text in landscape with the keyboard
  // up, it leads the results instead, whole, in their one scroll; dismissing the keyboard (a drag
  // or the Search key) frees room and brings it back down. Nothing shows until the area is laid out.
  const docked = useStatusFits(room);
  const place = !line || area === 0 ? null : docked ? "bottom" : "results";
  // Read out from here, once per change, wherever the line sits.
  useStatusAnnouncement(line?.text ?? null, line?.announce ?? false);
  const shown = line ? { ...line, announce: false } : null;
  return (
    <Animated.View style={[styles.screen, { transform: [{ translateY: drop }] }]}>
      <View
        style={[
          styles.bar,
          {
            paddingTop: insets.top + 8,
            paddingLeft: insets.left + 16,
            paddingRight: insets.right + 16,
          },
        ]}
      >
        <View style={styles.field}>
          <SymbolView name="magnifyingglass" size={17} tintColor={colors.dim} />
          <TextInput
            value={query}
            onChangeText={change}
            autoFocus
            placeholder="Movies, series and channels"
            placeholderTextColor={colors.dim}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            keyboardAppearance="dark"
            selectionColor="#FFFFFF"
            accessibilityLabel="Search"
            style={styles.input}
            testID="search-field"
          />
        </View>
        <TextButton label="Cancel" onPress={close} />
      </View>
      <View style={styles.screen} onLayout={(event) => setArea(event.nativeEvent.layout.height)}>
        <SectionList
          style={styles.screen}
          sections={sections}
          keyExtractor={(row) => (row.kind === "title" ? row.title.key : row.channel.key)}
          extraData={playing && `${playing.id} ${playing.word}`}
          renderSectionHeader={({ section }) => (
            <Text style={styles.section} accessibilityRole="header">
              {section.total > section.data.length
                ? `${section.title} · ${section.data.length} of ${section.total}`
                : `${section.title} · ${section.total}`}
            </Text>
          )}
          renderSectionFooter={({ section }) =>
            section.more ? (
              <View style={styles.more}>
                <TextButton label={moreLabel(section.more)} onPress={() => showMore(section)} />
              </View>
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === "title" ? (
              <TitleRow title={item.title} height={height} onPress={open} />
            ) : (
              <ChannelRow
                channel={item.channel}
                detail={library?.placeOf.get(item.channel.key) ?? ""}
                status={item.channel.key === playing?.id ? playing.word : null}
                height={height}
                onPress={watch}
              />
            )
          }
          stickySectionHeadersEnabled={false}
          keyboardDismissMode="on-drag"
          // A tap on a result opens it, with the keyboard up or not.
          keyboardShouldPersistTaps="handled"
          initialNumToRender={16}
          // With the status line under it, the list ends above it; else it runs under the keyboard.
          contentContainerStyle={{ paddingBottom: place === "bottom" ? 16 : insets.bottom + 16 }}
          ListHeaderComponent={
            shown && place === "results" ? (
              <View
                style={[
                  styles.lead,
                  { marginLeft: insets.left + 12, marginRight: insets.right + 12 },
                ]}
              >
                <StatusLine status={shown} />
              </View>
            ) : undefined
          }
          ListEmptyComponent={
            // Nothing has the name only once the latest text was searched in every list. While one
            // loads or failed, the status line says what was searched instead.
            searching && typed === query && !status ? (
              <Nothing query={typed.trim()} library={library} lists={lists} />
            ) : undefined
          }
          testID="search-list"
        />
        {shown && place === "bottom" ? (
          <View
            style={[
              styles.dock,
              {
                marginLeft: insets.left + 12,
                marginRight: insets.right + 12,
                marginBottom: reserve,
              },
            ]}
          >
            <StatusLine status={shown} space={room} />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

/**
 * Search's status line: Searching while the latest text waits to be searched, then what hasn't
 * loaded or failed, with Retry and Settings. The provider count shows as a bar with two or more
 * providers. Null with nothing to say.
 */
function searchLine(
  status: SearchStatus | null,
  pending: boolean,
  onRetry: () => void,
  onSettings: () => void,
): Status | null {
  if (!status && !pending) return null;
  const actions = status
    ? [
        ...(status.retry.length > 0 ? [{ label: "Retry", onPress: onRetry }] : []),
        ...(status.settings ? [{ label: "Settings", onPress: onSettings }] : []),
      ]
    : [];
  return {
    text: pending ? ["Searching.", status?.text].filter(Boolean).join(" ") : status!.text,
    actions,
    ...(status?.loading && status.loading.of > 1
      ? { progress: status.loading.settled / status.loading.of }
      : {}),
    // Searching passes with each keystroke; only what the lists say is read out.
    announce: !pending,
  };
}

/**
 * How far the keyboard covers the bottom of the window, 0 while it is down. Updated as it moves,
 * with the layout animated along with it.
 */
function useKeyboardHeight(): number {
  const { height: window } = useWindowDimensions();
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const change = Keyboard.addListener("keyboardWillChangeFrame", (event) => {
      Keyboard.scheduleLayoutAnimation(event);
      setTop(event.endCoordinates.screenY);
    });
    const hide = Keyboard.addListener("keyboardWillHide", (event) => {
      Keyboard.scheduleLayoutAnimation(event);
      setTop(null);
    });
    return () => {
      change.remove();
      hide.remove();
    };
  }, []);
  return top === null ? 0 : Math.max(0, window - top);
}

/** Back to the screen Search opened over, or Home when it opened with none under it. */
function close() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/** Nothing has that name: with every list in, how much was looked through. */
function Nothing({
  query,
  library,
  lists,
}: {
  query: string;
  library: Library | null;
  lists: TitleLists;
}) {
  const searched = useMemo(() => {
    if (!library || lists.kind !== "ready") return null;
    const channels = library.channels.length;
    const number = new Intl.NumberFormat();
    const counted = (count: number, one: string, many: string) =>
      `${number.format(count)} ${count === 1 ? one : many}`;
    return `Searched ${counted(channels, "channel", "channels")}, ${counted(
      titleCount(lists.index, "movie"),
      "movie",
      "movies",
    )} and ${counted(titleCount(lists.index, "series"), "series", "series")}.`;
  }, [library, lists]);
  return (
    <View style={styles.nothing} accessible accessibilityLiveRegion="polite">
      <Text style={styles.nothingText}>{`Nothing named "${query}".`}</Text>
      {searched ? <Text style={styles.statusText}>{searched}</Text> : null}
    </View>
  );
}

function TitleRow({
  title,
  height,
  onPress,
}: {
  title: Title;
  height: number;
  onPress: (title: Title) => void;
}) {
  const line = [title.kind === "movie" ? "Movie" : "Series", title.year]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title.title}, ${line}`}
      onPress={() => onPress(title)}
      style={({ pressed }) => [styles.row, { minHeight: height }, pressed && styles.pressed]}
      testID={`search-title-${title.id}`}
    >
      <Artwork url={title.posterUrl} name={title.title} width={154} plain style={styles.poster} />
      <View style={styles.names}>
        <Text style={styles.title} numberOfLines={2}>
          {title.title}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {line}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  bar: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 8 },
  field: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 40,
    borderRadius: 10,
    paddingHorizontal: 10,
    backgroundColor: colors.fill,
  },
  input: { flex: 1, color: colors.text, fontSize: 17, paddingVertical: 8 },
  statusText: { color: colors.dim, fontSize: 15 },
  dock: { marginTop: 8 },
  lead: { marginTop: 8 },
  nothing: { padding: 16, gap: 4 },
  nothingText: { color: colors.text, fontSize: 17, fontWeight: "600" },
  more: { paddingHorizontal: 16 },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 4,
  },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 },
  pressed: { opacity: 0.5 },
  poster: { width: 32, height: 48, borderRadius: 4 },
  names: { flex: 1, minWidth: 0, paddingVertical: 6 },
  title: { color: colors.text, fontSize: 17 },
  detail: { color: colors.dim, fontSize: 13, marginTop: 2 },
});
