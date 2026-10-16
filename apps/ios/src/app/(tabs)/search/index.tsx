import type { Title } from "@mrstreamer/contracts/ondemand";
import { useNavigation } from "expo-router";
import { useCallback, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { playChannel, useCatalogue } from "../../../account.ts";
import { searchChannels, type Channel } from "../../../library.ts";
import { playingChannel, usePlayback } from "../../../playback.ts";
import { openDetails } from "../../../resume.ts";
import { onSearchText } from "../../../telemetry/index.ts";
import { searchTitles, useMetadataVersion, useTitleLists } from "../../../titles.ts";
import { Artwork } from "../../../titles-ui.tsx";
import { ChannelRow, colors, Message, useRowHeight } from "../../../ui.tsx";

/** Rows of each kind shown before the rest are left out. */
const SHOWN = 20;

type Row =
  | { readonly kind: "title"; readonly title: Title }
  | { readonly kind: "channel"; readonly channel: Channel };

/**
 * Movies, series and live channels by name, matched as the desktop's search matches words: titles
 * by any of their names, TMDB's translations included, the best first. A title opens its details
 * in Movies or Series; a channel plays in Watch.
 */
export default function Search() {
  const navigation = useNavigation();
  const catalogue = useCatalogue();
  const lists = useTitleLists();
  const metadata = useMetadataVersion();
  const { phase } = usePlayback();
  const height = useRowHeight();
  const searchBar = useRef<SearchBarCommands>(null);
  const [query, setQuery] = useState("");
  const typed = useDeferredValue(query);
  const library = catalogue.kind === "ready" ? catalogue.library : null;

  const sections = useMemo(() => {
    const found: { title: string; total: number; data: Row[] }[] = [];
    if (lists.kind === "ready" && typed.trim()) {
      for (const [kind, name] of [
        ["movie", "Movies"],
        ["series", "Series"],
      ] as const) {
        const page = searchTitles(lists.index, kind, typed);
        if (page.total > 0) {
          found.push({
            title: name,
            total: page.total,
            data: page.titles.slice(0, SHOWN).map((title) => ({ kind: "title", title })),
          });
        }
      }
    }
    const channels = library ? searchChannels(library, typed) : [];
    if (channels.length > 0) {
      found.push({
        title: "Channels",
        total: channels.length,
        data: channels.map((channel) => ({ kind: "channel", channel })),
      });
    }
    return found;
    // A new metadata version adds TMDB's names to search.
  }, [lists, library, typed, metadata]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        ref: searchBar,
        placeholder: "Movies, series and channels",
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) => {
          setQuery(event.nativeEvent.text);
          onSearchText(event.nativeEvent.text);
        },
      },
    });
  }, [navigation]);

  const watch = useCallback(
    (channel: Channel) => {
      if (!library) return;
      // The system search field keeps its keyboard up until it is blurred, over Watch too.
      searchBar.current?.blur();
      playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true });
    },
    [library],
  );
  const open = useCallback((title: Title) => {
    searchBar.current?.blur();
    openDetails(title);
  }, []);
  const playing = playingChannel(phase);
  return (
    <SectionList
      style={styles.screen}
      sections={sections}
      keyExtractor={(row) => (row.kind === "title" ? row.title.key : row.channel.key)}
      extraData={playing}
      renderSectionHeader={({ section }) => (
        <Text style={styles.section} accessibilityRole="header">
          {section.total > section.data.length
            ? `${section.title} · ${section.data.length} of ${section.total}`
            : section.title}
        </Text>
      )}
      renderItem={({ item }) =>
        item.kind === "title" ? (
          <TitleRow title={item.title} height={height} onPress={open} />
        ) : (
          <ChannelRow
            channel={item.channel}
            detail={library?.placeOf.get(item.channel.key) ?? ""}
            playing={item.channel.key === playing}
            height={height}
            onPress={watch}
          />
        )
      }
      stickySectionHeadersEnabled={false}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      // A tap on a result opens it, with the keyboard up or not.
      keyboardShouldPersistTaps="handled"
      initialNumToRender={16}
      ListEmptyComponent={typed.trim() ? <Message text="Nothing has that name." /> : undefined}
      testID="search-list"
    />
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
