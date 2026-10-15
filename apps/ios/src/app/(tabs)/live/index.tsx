import type { ListedChannel } from "@mrstreamer/core/catalogue/variants";
import { useNavigation } from "expo-router";
import { useCallback, useLayoutEffect, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { loadCatalogue, playChannel, useCatalogue } from "../../../account.ts";
import { describeError } from "../../../errors.ts";
import type { Library, Region } from "../../../library.ts";
import { playingChannelId, usePlayback } from "../../../playback.ts";
import { useSavedState, writeState } from "../../../storage.ts";
import { ChannelRow, Message, useRowHeight } from "../../../ui.tsx";

/**
 * Live: one country's channels, or one of its categories', in a virtualised list. The country
 * and category menu is a system button in the top bar, so the list has no filters of its own.
 * The guide comes here once core reads XMLTV on iOS.
 */
export default function Live() {
  const catalogue = useCatalogue();
  if (catalogue.kind === "loading") return <Message text="Loading channels" />;
  if (catalogue.kind === "failed") {
    return (
      <View style={styles.screen}>
        <Message
          text={describeError(catalogue.error)}
          action={{ label: "Try again", onPress: loadCatalogue }}
        />
      </View>
    );
  }
  return <Channels library={catalogue.library} />;
}

function Channels({ library }: { library: Library }) {
  const navigation = useNavigation();
  const saved = useSavedState();
  const { phase } = usePlayback();
  const height = useRowHeight();
  const [shelfId, setShelfId] = useState<string | null>(null);
  const region = library.regions.find((each) => each.name === saved.region) ?? library.regions[0];
  const shelf = region?.shelves.find((each) => each.id === shelfId) ?? null;
  const channels = shelf?.channels ?? region?.channels ?? [];

  const choose = useCallback((next: Region, nextShelf: string | null) => {
    writeState((state) => ({ ...state, region: next.name }));
    setShelfId(nextShelf);
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "menu",
          label: shelf && region ? `${region.name} · ${shelf.title}` : (region?.name ?? "Live"),
          menu: {
            items: library.regions.map((each) =>
              each.shelves.length > 1
                ? {
                    type: "submenu" as const,
                    label: each.name,
                    items: [
                      {
                        type: "action" as const,
                        label: `All of ${each.name}`,
                        state: each === region && !shelf ? ("on" as const) : ("off" as const),
                        onPress: () => choose(each, null),
                      },
                      ...each.shelves.map((option) => ({
                        type: "action" as const,
                        label: option.title,
                        state: option === shelf ? ("on" as const) : ("off" as const),
                        onPress: () => choose(each, option.id),
                      })),
                    ],
                  }
                : {
                    type: "action" as const,
                    label: each.name,
                    state: each === region ? ("on" as const) : ("off" as const),
                    onPress: () => choose(each, null),
                  },
            ),
          },
        },
      ],
    });
  }, [navigation, library, region, shelf, choose]);

  const playingId = playingChannelId(phase);
  const watch = useCallback(
    (channel: ListedChannel) =>
      playChannel(channel, library.placeOf.get(channel.id) ?? "", { watch: true }),
    [library],
  );
  return (
    <FlatList
      style={styles.screen}
      data={channels}
      keyExtractor={(channel) => channel.id}
      extraData={playingId}
      renderItem={({ item }) => (
        <ChannelRow
          channel={item}
          detail={library.placeOf.get(item.id) ?? ""}
          playing={item.id === playingId}
          height={height}
          onPress={watch}
        />
      )}
      getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
      contentInsetAdjustmentBehavior="automatic"
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={9}
      removeClippedSubviews
      testID="live-list"
    />
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: "#000000" } });
