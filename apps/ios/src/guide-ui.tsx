import type { Listing, Programme } from "@mrstreamer/contracts/guide";
import { router, useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { guide, type Day, type DayPage, type GuideStatus } from "./guide.ts";
import { usePlayback } from "./playback.ts";
import type { Library } from "./library.ts";
import { currentSource, onSignedIn } from "./sources.ts";
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
const authorityOf = (ids: readonly string[], snapshot: ReturnType<typeof guide.getSnapshot>) =>
  ids
    .map((id) => {
      const status = snapshot.get(id);
      return status?.availability === "none"
        ? "none"
        : status?.fetchedAt == null
          ? "cold"
          : "cache";
    })
    .join(":");
const revisionOf = (ids: readonly string[]) =>
  JSON.stringify(ids.map((id) => guide.getSnapshot().get(id)?.fetchedAt ?? null));

/** Focus owns subscriptions, not settled presentation. Source revisions contain no private inputs. */
export function useGuideOwner(subscriptionIds: readonly string[] = []) {
  const inStack = useIsFocused();
  const { watch } = usePlayback();
  const focused = inStack && !watch;
  const signature = JSON.stringify([...new Set(subscriptionIds)]);
  const ids = useMemo(() => JSON.parse(signature) as string[], [signature]);
  const getSources = useCallback(
    () => JSON.stringify(ids.map((id) => currentSource(id)?.revision ?? null)),
    [ids],
  );
  const subscribe = useCallback(
    (listener: () => void) => (focused ? guide.subscribe(listener) : nothing()),
    [focused],
  );
  const subscribeSources = useCallback(
    (listener: () => void) => (focused ? onSignedIn(listener) : nothing()),
    [focused],
  );
  const snapshot = useSyncExternalStore(subscribe, guide.getSnapshot);
  const sources = useSyncExternalStore(subscribeSources, getSources);
  const authority = authorityOf(ids, snapshot);
  const identity = useMemo(() => ({ sources, authority }), [sources, authority]);
  const valid = useCallback(
    () => getSources() === sources && authorityOf(ids, guide.getSnapshot()) === authority,
    [getSources, sources, ids, authority],
  );
  return { snapshot, focused, now: Date.now(), identity, valid, revision: revisionOf(ids) };
}

/** Keep the same authorized presentation mounted while its next read is pending or fails. */
export function useGuideRead<T>(
  load: (signal: AbortSignal) => Promise<T>,
  subscriptionIds: readonly string[],
) {
  const { snapshot, focused, now, identity, valid } = useGuideOwner(subscriptionIds);
  const request = useMemo(() => ({ load, identity }), [load, identity]);
  const [result, setResult] = useState<{
    request: typeof request;
    snapshot: typeof snapshot;
    value: T | undefined;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!focused) return;
    const controller = new AbortController();
    void load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted && valid())
          setResult({ request, snapshot, value, failed: false });
      },
      () => {
        if (!controller.signal.aborted && valid())
          setResult((before) => ({
            request,
            snapshot,
            value: before?.request === request ? before.value : undefined,
            failed: true,
          }));
      },
    );
    return () => controller.abort();
  }, [request, load, snapshot, focused, valid]);
  const current = result?.request === request ? result : null;
  return {
    value: current?.value,
    failed: current?.failed ?? false,
    pending: focused && (!current || current.snapshot !== snapshot),
    snapshot,
    now,
  };
}

export function useGuideListings(keys: readonly string[], catalogue: Library | null) {
  const signature = JSON.stringify(keys.slice(0, 40));
  const requested = useMemo(() => JSON.parse(signature) as string[], [signature]);
  const load = useCallback(
    (signal: AbortSignal) =>
      guide.listings(
        requested.filter((key) => catalogue?.byKey.has(key)),
        { signal },
      ),
    [requested, catalogue],
  );
  return useGuideRead(
    load,
    requested.map((key) => key.slice(0, key.indexOf(":"))),
  );
}

/** Reload the represented page span atomically; never append with a prior generation's cursor. */
export function useGuideSchedule(key: string, day: Day, catalogue: Library) {
  const ids = useMemo(() => [key.slice(0, key.indexOf(":"))], [key]);
  const { snapshot, focused, now, identity, valid, revision } = useGuideOwner(ids);
  const request = useMemo(
    () => ({ key, day: { from: day.from, until: day.until }, catalogue, identity }),
    [key, day.from, day.until, catalogue, identity],
  );
  type Page = {
    request: typeof request;
    page: DayPage;
    pages: number;
    revision: string;
    failed: boolean;
  };
  type Work = { controller: AbortController; busy: boolean };
  const [result, setResult] = useState<Page | null>(null);
  const settled = useRef(result);
  settled.current = result;
  const active = useRef<Work | null>(null);
  const [busy, setBusy] = useState<Work | null>(null);
  const read = useCallback(
    (append = false) => {
      const work = active.current;
      if (!work || work.busy || work.controller.signal.aborted) return;
      const before = settled.current?.request === request ? settled.current : null;
      const version = revisionOf(ids);
      const notification = guide.getSnapshot();
      if (append && (!before?.page.cursor || before.revision !== version)) return;
      work.busy = true;
      setBusy(work);
      const wanted = () =>
        guide.getSnapshot() === notification &&
        active.current === work &&
        !work.controller.signal.aborted &&
        valid() &&
        revisionOf(ids) === version;
      const commit = (page: Page) => {
        settled.current = page;
        setResult(page);
      };
      void (async () => {
        try {
          let cursor = append ? (before?.page.cursor ?? undefined) : undefined;
          let programmes = append && before ? [...before.page.programmes] : [];
          let pages = append && before ? before.pages : 0;
          const count = append ? 1 : (before?.pages ?? 1);
          for (let index = 0; index < count; index++) {
            const page = await guide.schedule(request.key, request.day, cursor, {
              signal: work.controller.signal,
            });
            if (!wanted()) return;
            programmes = [...programmes, ...page.programmes];
            pages++;
            cursor = page.cursor ?? undefined;
            if (!cursor) break;
          }
          // An immutable day cannot become empty during a routine read refusal. Keep known rows.
          if (!append && programmes.length === 0 && before?.page.programmes.length) {
            commit({ ...before, failed: true });
          } else
            commit({
              request,
              page: { programmes, cursor: cursor ?? null },
              pages,
              revision: version,
              failed: false,
            });
        } catch {
          if (wanted())
            commit({
              request,
              page: before?.page ?? { programmes: [], cursor: null },
              pages: before?.pages ?? 1,
              revision: before?.revision ?? version,
              failed: true,
            });
        } finally {
          work.busy = false;
          setBusy((current) => (current === work ? null : current));
        }
      })();
    },
    [request, ids, valid],
  );
  useEffect(() => {
    if (!focused) return;
    const work = { controller: new AbortController(), busy: false };
    active.current = work;
    read();
    return () => {
      work.controller.abort();
      if (active.current === work) active.current = null;
    };
  }, [request, snapshot, focused, read]);
  const current = result?.request === request ? result : null;
  const loading = focused && (!current || (busy !== null && active.current === busy));
  const stale = current !== null && current.revision !== revision;
  return {
    page: current?.page,
    failed: current?.failed ?? false,
    loading,
    stale,
    more: () => read(true),
    canLoadMore: focused && !loading && !stale,
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
    next:
      listing?.next && listing.next.start > at
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
  textStyle,
}: {
  listing: Listing | undefined;
  fallback: string;
  at: number;
  textStyle?: StyleProp<TextStyle>;
}) {
  const shown = programmePresentation(listing, at);
  return (
    <>
      {shown.line || fallback ? (
        <Text style={[styles.line, textStyle]} numberOfLines={2}>
          {shown.line ?? fallback}
        </Text>
      ) : null}
      {shown.next ? (
        <Text style={[styles.line, textStyle]} numberOfLines={1}>
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
