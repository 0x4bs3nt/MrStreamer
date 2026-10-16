import { router, useNavigation } from "expo-router";
import { useCallback, useLayoutEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import {
  playChannel,
  reloadAllChannels,
  retry,
  retryChannels,
  useCatalogue,
  useRoster,
  type Member,
} from "../../../account.ts";
import { failureOf } from "../../../errors.ts";
import type { Channel, Library, Region } from "../../../library.ts";
import { playingChannel, usePlayback } from "../../../playback.ts";
import { useSavedState, writeState } from "../../../storage.ts";
import { TextTabs } from "../../../titles-ui.tsx";
import {
  ChannelRow,
  colors,
  Notice,
  PlaceholderRows,
  TextButton,
  useRowHeight,
} from "../../../ui.tsx";

/** The text tab for all of a country's categories. Provider category ids are never "*". */
const ALL = "*";

/**
 * Live: one country's channels, or one of its categories', in a virtualised list of rows of one
 * fixed height. The country is a system menu in the top bar; its categories are text tabs above
 * the list. Rows show the channel's category until iOS reads a guide, which brings now and next.
 */
export default function Live() {
  const catalogue = useCatalogue();
  const roster = useRoster();
  const height = useRowHeight();
  const providers = roster.kind === "ready" ? roster.members : [];
  // One provider is named; several are "your providers".
  const host = providers.length === 1 && providers[0] ? providers[0].label : "";
  if (catalogue.kind === "loading") {
    return (
      <View style={styles.screen}>
        <Text style={styles.note} accessibilityLiveRegion="polite">
          {host ? `Loading channels from ${host}` : "Loading channels"}
        </Text>
        <PlaceholderRows height={height} />
      </View>
    );
  }
  if (catalogue.kind === "failed") {
    const failure = failureOf(catalogue.error, catalogue.member.entry.server);
    return (
      <View style={styles.screen}>
        <Notice
          failure={{
            headline: "Couldn't load channels",
            advice: [failure.headline, failure.advice].filter(Boolean).join(". "),
          }}
          actions={[
            { label: "Try again", onPress: retryChannels },
            { label: "Provider settings", onPress: () => router.navigate("/settings") },
          ]}
        />
      </View>
    );
  }
  if (catalogue.library.regions.length === 0) {
    return (
      <View style={styles.screen}>
        <Notice
          failure={{
            headline: "No live channels",
            advice: `${host || "Your providers"} ${host ? "lists" : "list"} no live channels.`,
          }}
          actions={[{ label: "Reload", onPress: reloadAllChannels }]}
        />
      </View>
    );
  }
  return <Channels library={catalogue.library} failing={catalogue.failing} height={height} />;
}

/**
 * One line for a provider whose channels didn't load, or whose password the iPhone no longer
 * gives back: its channels as they were stay in the list, and the others carry on.
 */
function Failing({ member }: { member: Member }) {
  const { entry, label, needsSecret } = member;
  return (
    <View style={styles.failing} testID={`live-failing-${entry.id}`}>
      <Text style={styles.failingText} numberOfLines={2}>
        {needsSecret
          ? `Enter the password for ${label} in Settings.`
          : `Couldn't load channels from ${label}.`}
      </Text>
      {needsSecret ? (
        <TextButton label="Settings" onPress={() => router.navigate("/settings")} />
      ) : (
        <TextButton label="Retry" onPress={() => retry(entry.id)} />
      )}
    </View>
  );
}

function Channels({
  library,
  failing,
  height,
}: {
  library: Library;
  failing: readonly Member[];
  height: number;
}) {
  const navigation = useNavigation();
  const saved = useSavedState();
  const { phase } = usePlayback();
  const [shelfId, setShelfId] = useState<string>(ALL);
  const found = library.regions.find((each) => each.name === saved.region);
  const region = found ?? library.regions[0]!;
  const shelf = region.shelves.find((each) => each.id === shelfId) ?? null;
  const channels = shelf?.channels ?? region.channels;

  const choose = useCallback((next: Region) => {
    writeState((state) => ({ ...state, region: next.name }));
    setShelfId(ALL);
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "menu",
          label: region.name,
          menu: {
            items: library.regions.map((each) => ({
              type: "action" as const,
              label: each.name,
              state: each === region ? ("on" as const) : ("off" as const),
              onPress: () => choose(each),
            })),
          },
        },
      ],
    });
  }, [navigation, library, region, choose]);
  // While channels reload, fail or are missing, there is no list for the menu to choose in.
  useLayoutEffect(
    () => () => navigation.setOptions({ unstable_headerRightItems: () => [] }),
    [navigation],
  );

  const playing = playingChannel(phase);
  const watch = useCallback(
    (channel: Channel) =>
      playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true }),
    [library],
  );
  const tabs =
    region.shelves.length > 1
      ? [
          { value: ALL, label: "All" },
          ...region.shelves.map((each) => ({ value: each.id, label: each.title })),
        ]
      : [];
  return (
    <View style={styles.screen}>
      {failing.map((member) => (
        <Failing key={member.entry.id} member={member} />
      ))}
      {saved.region && !found ? (
        <Text style={styles.note}>{`${saved.region} isn't listed any more.`}</Text>
      ) : null}
      {tabs.length > 0 ? (
        <View style={styles.tabs}>
          <TextTabs tabs={tabs} value={shelf?.id ?? ALL} onChange={setShelfId} />
        </View>
      ) : null}
      {/* The tabs sit above the list, not in it, so every row's offset stays height × index. */}
      <FlatList
        key={`${region.name}\n${shelf?.id ?? ALL}`}
        style={styles.screen}
        data={channels}
        keyExtractor={(channel) => channel.key}
        extraData={playing}
        renderItem={({ item }) => (
          <ChannelRow
            channel={item}
            detail={library.placeOf.get(item.key) ?? ""}
            playing={item.key === playing}
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
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  note: { color: colors.text, fontSize: 15, marginHorizontal: 16, marginVertical: 12 },
  failing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
  },
  failingText: { color: colors.text, fontSize: 15, flex: 1 },
  tabs: { borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
});
