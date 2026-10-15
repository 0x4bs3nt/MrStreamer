import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { useNavigation } from "expo-router";
import { useCallback, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, StyleSheet } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { playChannel, useCatalogue } from "../../../account.ts";
import { searchChannels } from "../../../library.ts";
import { playingChannelId, usePlayback } from "../../../playback.ts";
import { ChannelRow, Message, useRowHeight } from "../../../ui.tsx";

/** Live channels by name, matched as the desktop's search matches words. Films and series later. */
export default function Search() {
  const navigation = useNavigation();
  const catalogue = useCatalogue();
  const { phase } = usePlayback();
  const height = useRowHeight();
  const searchBar = useRef<SearchBarCommands>(null);
  const [query, setQuery] = useState("");
  const typed = useDeferredValue(query);
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const found = useMemo(() => (library ? searchChannels(library, typed) : []), [library, typed]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        ref: searchBar,
        placeholder: "Channels",
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
      },
    });
  }, [navigation]);

  const watch = useCallback(
    (channel: ListedChannel) => {
      if (!library) return;
      // The system search field keeps its keyboard up until it is blurred, over Watch too.
      searchBar.current?.blur();
      playChannel(channel, library.placeOf.get(channel.id) ?? "", { watch: true });
    },
    [library],
  );
  const playingId = playingChannelId(phase);
  return (
    <FlatList
      style={styles.screen}
      data={found}
      keyExtractor={(channel) => channel.id}
      extraData={playingId}
      renderItem={({ item }) => (
        <ChannelRow
          channel={item}
          detail={library?.placeOf.get(item.id) ?? ""}
          playing={item.id === playingId}
          height={height}
          onPress={watch}
        />
      )}
      getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      ListEmptyComponent={typed.trim() ? <Message text="No channel has that name." /> : undefined}
      testID="search-list"
    />
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: "#000000" } });
