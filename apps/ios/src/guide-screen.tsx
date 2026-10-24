import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, Text, View } from "react-native";
import { playChannel, useCatalogue } from "./account.ts";
import { guide } from "./guide.ts";
import {
  guideMessage,
  localDay,
  openProgramme,
  programmeRange,
  ProgrammeProgress,
  programmePresentation,
  useGuideOwner,
  useGuideRead,
  useGuideSchedule,
  type GuideOrigin,
} from "./guide-ui.tsx";
import { tabHref } from "./header.tsx";
import type { Channel, Library } from "./library.ts";
import { colors, Message, TextButton } from "./ui.tsx";

const parameter = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : "";

/** Same pushed screen on both stacks, so native Back retains the originating browse state. */
export function ScheduleScreen({ origin }: { origin: GuideOrigin }) {
  const params = useLocalSearchParams<{ channel?: string }>();
  const catalogue = useCatalogue();
  const key = parameter(params.channel);
  const channel = catalogue.kind === "ready" ? catalogue.library.byKey.get(key) : undefined;
  if (catalogue.kind === "loading") return <Message text="Loading channels…" />;
  if (!channel || catalogue.kind !== "ready") return <Message text="Channel unavailable" />;
  return (
    <Schedule key={channel.key} channel={channel} library={catalogue.library} origin={origin} />
  );
}

function Schedule({
  channel,
  library,
  origin,
}: {
  channel: Channel;
  library: Library;
  origin: GuideOrigin;
}) {
  const clock = useGuideOwner();
  // null follows Today across midnight; a chosen calendar date stays on that date.
  const [chosen, setChosen] = useState<number | null>(null);
  const day = localDay(chosen ?? clock.now);
  const schedule = useGuideSchedule(channel.key, day, library);
  const today = localDay(clock.now).from;
  const label =
    day.from === today
      ? "Today"
      : new Date(day.from).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
  const message = schedule.stale
    ? "Guide may be out of date"
    : guideMessage(schedule.snapshot.get(channel.subscriptionId));
  return (
    <FlatList
      style={styles.screen}
      data={schedule.page?.programmes ?? []}
      keyExtractor={(item) => `${item.start}`}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={7}
      ListHeaderComponent={
        <>
          <Text accessibilityRole="header" style={styles.title}>
            {channel.title}
          </Text>
          <View style={styles.days}>
            <TextButton
              label="Previous day"
              onPress={() => setChosen(localDay(day.from, -1).from)}
            />
            <Text accessibilityRole="header" style={styles.day}>
              {label}
            </Text>
            <TextButton label="Next day" onPress={() => setChosen(localDay(day.from, 1).from)} />
          </View>
          {chosen !== null && day.from !== today ? (
            <TextButton label="Today" onPress={() => setChosen(null)} />
          ) : null}
          <GuideNotice message={message} origin={origin} />
        </>
      }
      ListEmptyComponent={
        <Message
          text={
            schedule.loading
              ? "Loading schedule…"
              : schedule.failed
                ? "Guide unavailable"
                : "No programme information for this day"
          }
        />
      }
      renderItem={({ item }) => (
        <TextButton
          label={`${programmeRange(item)} · ${item.title}`}
          onPress={() => openProgramme(origin, channel.key, item.detail)}
          testID={`programme-${item.start}`}
        />
      )}
      ListFooterComponent={
        <>
          {schedule.page?.cursor ? (
            <TextButton
              label={schedule.loading ? "Loading…" : "Show more"}
              disabled={!schedule.canLoadMore}
              onPress={schedule.more}
              testID="guide-more"
            />
          ) : null}
          {schedule.failed && (schedule.page?.programmes.length ?? 0) > 0 ? (
            <Message text="Couldn't update schedule" />
          ) : null}
        </>
      }
      testID="guide-schedule"
    />
  );
}

export function ProgrammeScreen({ origin }: { origin: GuideOrigin }) {
  const params = useLocalSearchParams<{ channel?: string; detail?: string }>();
  const catalogue = useCatalogue();
  const key = parameter(params.channel);
  const detail = parameter(params.detail);
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const channel = library?.byKey.get(key);
  const load = useCallback(
    (signal: AbortSignal) =>
      channel && library ? guide.programme(detail, { signal }) : Promise.resolve(null),
    [channel, library, detail],
  );
  const read = useGuideRead(load, channel ? [channel.subscriptionId] : []);
  const listing = useMemo(() => ({ now: read.value ?? null, next: null }), [read.value]);
  const progress = programmePresentation(listing, read.now).progress;
  if (!channel || !library) return <Message text="Channel unavailable" />;
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      testID="guide-programme"
    >
      <Text style={styles.channel}>{channel.title}</Text>
      {read.value ? (
        <>
          <Text accessibilityRole="header" style={styles.title}>
            {read.value.title}
          </Text>
          <Text style={styles.copy}>{programmeRange(read.value)}</Text>
          <ProgrammeProgress value={progress} />
          {read.value.description ? (
            <Text style={styles.copy}>{read.value.description}</Text>
          ) : null}
        </>
      ) : (
        <Message
          text={
            read.pending ? "Loading programme…" : "Programme unavailable. Go Back to the schedule."
          }
        />
      )}
      <GuideNotice
        message={guideMessage(read.snapshot.get(channel.subscriptionId))}
        origin={origin}
      />
      <TextButton
        label="Watch live"
        onPress={() =>
          playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true })
        }
        testID="guide-watch-live"
      />
    </ScrollView>
  );
}

function GuideNotice({ message, origin }: { message: string | null; origin: GuideOrigin }) {
  return message ? (
    <View>
      <Text style={styles.copy}>{message}</Text>
      {message === "Guide unavailable" ? (
        <TextButton
          label="Provider settings"
          onPress={() => router.push(tabHref(origin === "home" ? "(home)" : "live", "settings"))}
        />
      ) : null}
    </View>
  ) : null;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700", marginVertical: 12 },
  channel: { color: colors.text, fontSize: 17, marginTop: 12 },
  copy: { color: colors.text, fontSize: 15, marginVertical: 8 },
  days: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  day: { color: colors.text, fontSize: 17 },
});
