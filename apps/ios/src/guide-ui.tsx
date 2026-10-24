import type { Listing, Programme } from "@mrstreamer/contracts/guide";
import { router, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { guide, type Day, type DayPage, type GuideStatus } from "./guide.ts";
import { usePlayback } from "./playback.ts";
import type { Library } from "./library.ts";
import { colors } from "./ui.tsx";

export type GuideOrigin = "home" | "live";

/** Routes carry only owned channel keys and the owner's opaque detail token. */
export function openSchedule(origin: GuideOrigin, channel: string) {
  router.push({
    pathname: origin === "home" ? "/schedule" : "/live/schedule",
    params: { channel },
  });
}
export function openProgramme(origin: GuideOrigin, channel: string, detail: string) {
  router.push({
    pathname: origin === "home" ? "/programme" : "/live/programme",
    params: { channel, detail },
  });
}

/** Calendar arithmetic preserves the local day's 23/25-hour DST boundaries. */
export function localDay(at: number, offset = 0): Day {
  const from = new Date(at);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() + offset);
  const until = new Date(from);
  until.setDate(until.getDate() + 1);
  return { from: from.getTime(), until: until.getTime() };
}

export const programmeTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const programmeRange = (programme: Pick<Programme, "start" | "stop">) =>
  `${programmeTime(programme.start)}–${programmeTime(programme.stop)}`;

const nothing = () => () => {};
/** Only a focused screen subscribes. The existing owner supplies the clock and native lifecycle. */
export function useGuideOwner() {
  const inStack = useIsFocused();
  const { watch } = usePlayback();
  const focused = inStack && !watch;
  const subscribe = useCallback(
    (listener: () => void) => (focused ? guide.subscribe(listener) : nothing()),
    [focused],
  );
  const snapshot = useSyncExternalStore(subscribe, guide.getSnapshot);
  return { snapshot, focused, now: Date.now() };
}

/** Current-request presentation only. Changed keys, catalogue, clock or focus retire old answers. */
export function useGuideRead<T>(load: (signal: AbortSignal) => Promise<T>) {
  const { snapshot, focused, now } = useGuideOwner();
  const [result, setResult] = useState<{
    load: typeof load;
    snapshot: typeof snapshot;
    value?: T;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!focused) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    void load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setResult({ load, snapshot, value, failed: false });
      },
      () => {
        if (!controller.signal.aborted) setResult({ load, snapshot, failed: true });
      },
    );
    return () => controller.abort();
  }, [load, snapshot, focused]);
  const current = focused && result?.load === load && result.snapshot === snapshot ? result : null;
  return {
    value: current?.value,
    failed: current?.failed ?? false,
    pending: focused && current === null,
    snapshot,
    now,
  };
}

export function useGuideListings(keys: readonly string[], catalogue: Library | null) {
  const signature = JSON.stringify(keys.slice(0, 40));
  const requested = useMemo(() => JSON.parse(signature) as string[], [signature]);
  const load = useCallback(
    (signal: AbortSignal) => {
      // The caller supplies its visible slice, never the whole catalogue.
      return guide.listings(
        requested.filter((key) => catalogue?.byKey.has(key)),
        { signal },
      );
    },
    [requested, catalogue],
  );
  return useGuideRead(load);
}

/** One paged schedule for the current channel/day/generation. No cross-request row cache. */
export function useGuideSchedule(key: string, day: Day, catalogue: Library) {
  const { snapshot, focused, now } = useGuideOwner();
  const request = useCallback(
    (cursor: string | undefined, signal: AbortSignal) => {
      if (!catalogue.byKey.has(key)) return Promise.resolve({ programmes: [], cursor: null });
      return guide.schedule(key, day, cursor, { signal });
    },
    [key, day.from, day.until, catalogue, snapshot],
  );
  const [result, setResult] = useState<{
    request: typeof request;
    page: DayPage;
    failed: boolean;
    loading: boolean;
  } | null>(null);
  const active = useRef<{
    request: typeof request;
    controller: AbortController;
    busy: boolean;
  } | null>(null);
  const read = useCallback(
    (cursor?: string) => {
      const work = active.current;
      if (!work || work.request !== request || work.busy || work.controller.signal.aborted) return;
      work.busy = true;
      setResult((before) => (before?.request === request ? { ...before, loading: true } : null));
      void request(cursor, work.controller.signal)
        .then(
          (page) => {
            if (work.controller.signal.aborted || active.current !== work) return;
            setResult((before) => ({
              request,
              page:
                cursor && before?.request === request
                  ? {
                      programmes: [...before.page.programmes, ...page.programmes],
                      cursor: page.cursor,
                    }
                  : page,
              failed: false,
              loading: false,
            }));
          },
          () => {
            if (work.controller.signal.aborted || active.current !== work) return;
            setResult((before) => ({
              request,
              page: before?.request === request ? before.page : { programmes: [], cursor: null },
              failed: true,
              loading: false,
            }));
          },
        )
        .finally(() => {
          work.busy = false;
        });
    },
    [request],
  );
  useEffect(() => {
    if (!focused) {
      setResult(null);
      return;
    }
    const work = { request, controller: new AbortController(), busy: false };
    active.current = work;
    read();
    return () => {
      work.controller.abort();
      if (active.current === work) active.current = null;
    };
  }, [request, read, focused]);
  const current = focused && result?.request === request ? result : null;
  return {
    page: current?.page,
    failed: current?.failed ?? false,
    loading: focused && (!current || current.loading),
    more: () => {
      if (current?.page.cursor) read(current.page.cursor);
    },
    snapshot,
    now,
  };
}

/** Safe, deliberately small status copy. Recovery uses the existing account/settings path. */
export function guideMessage(status: GuideStatus | undefined): string | null {
  if (!status) return null;
  if (status.availability === "available")
    return status.stale || status.error ? "Guide may be out of date" : null;
  if (status.error) return "Guide unavailable";
  if (status.activity === "loading") return "Loading guide…";
  if (status.availability === "none") return "No programme information";
  return null;
}

/** The owner decides now/next; the UI only formats them and clamps an ongoing programme. */
export function programmePresentation(listing: Listing | undefined, at: number) {
  const current = listing?.now;
  const ongoing = current && current.start <= at && current.stop > at ? current : null;
  return {
    line: ongoing ? `${ongoing.title} · ${programmeRange(ongoing)}` : null,
    next: listing?.next
      ? `Next ${programmeTime(listing.next.start)} · ${listing.next.title}`
      : null,
    progress: ongoing
      ? Math.max(0, Math.min(1, (at - ongoing.start) / (ongoing.stop - ongoing.start)))
      : null,
  };
}

export function ProgrammeProgress({ value }: { value: number | null }) {
  return value === null ? null : (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Programme progress"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      style={styles.track}
    >
      <View style={[styles.progress, { width: `${value * 100}%` }]} />
    </View>
  );
}
export function ProgrammeLines({
  listing,
  fallback,
  at,
}: {
  listing: Listing | undefined;
  fallback: string;
  at: number;
}) {
  const shown = programmePresentation(listing, at);
  return (
    <>
      <Text style={styles.line} numberOfLines={2}>
        {shown.line ?? fallback}
      </Text>
      {shown.next ? (
        <Text style={styles.line} numberOfLines={1}>
          {shown.next}
        </Text>
      ) : null}
      <ProgrammeProgress value={shown.progress} />
    </>
  );
}
const styles = StyleSheet.create({
  line: { color: colors.text, fontSize: 13, marginTop: 2 },
  track: { height: 2, backgroundColor: colors.line, marginTop: 5 },
  progress: { height: 2, backgroundColor: colors.text },
});
