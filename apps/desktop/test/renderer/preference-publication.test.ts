// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PreferenceSnapshot } from "@mrstreamer/contracts/ipc";
import { defaultPreferences, type Preferences } from "@mrstreamer/contracts/preferences";
import {
  acceptPreferences,
  preferenceQuery,
  readPreferences,
  syncPreferences,
  updatePreferences,
} from "../../src/renderer/src/lib/preferences.ts";
import { player } from "../../src/renderer/src/player/player.ts";

let stop = () => {};
let client: QueryClient;
beforeEach(() => {
  ipc.reset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  stop();
  client.clear();
  vi.useRealTimers();
});
const snapshot = (
  revision: number,
  preferences: Partial<Preferences> = {},
): PreferenceSnapshot => ({
  revision,
  preferences: { ...defaultPreferences, ...preferences },
});
const cached = () => client.getQueryData<PreferenceSnapshot>(["preferences"]);

it("accepts initial reads, save replies and events through one newest-revision path, including React Query's late completion", async () => {
  const applied: Preferences[] = [];
  stop = syncPreferences(client, (preferences) => applied.push(preferences));
  const first = ipc.hold("preferences.get");
  const initial = client.fetchQuery(preferenceQuery());
  ipc.emit("preferences.changed", snapshot(3, { audioLanguage: "nl" }));
  first.resolve(snapshot(1));
  await initial;
  expect(cached()).toEqual(snapshot(3, { audioLanguage: "nl" }));
  const saved = ipc.hold("preferences.update");
  const save = updatePreferences({ subtitleLanguage: "fr" });
  ipc.emit("preferences.changed", snapshot(5, { audioLanguage: "de", subtitleLanguage: "fr" }));
  saved.resolve(snapshot(4, { audioLanguage: "nl", subtitleLanguage: "fr" }));
  expect(await save).toMatchObject({ audioLanguage: "de", subtitleLanguage: "fr" });
  ipc.emit("preferences.changed", snapshot(5, { audioLanguage: "de", subtitleLanguage: "fr" }));
  ipc.emit("preferences.changed", snapshot(2));
  expect(applied).toHaveLength(2);
  expect(cached()?.revision).toBe(5);
  expect(ipc.argsOf("preferences.get")).toHaveLength(1);
});

it("preserves an event that arrives after queryFn returned but before React Query commits it", async () => {
  const applied: Preferences[] = [];
  stop = syncPreferences(client, (preferences) => applied.push(preferences));
  ipc.always("preferences.get", snapshot(1));
  let injected = false;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (!injected && event.type === "updated" && cached()?.revision === 1) {
      injected = true;
      ipc.emit("preferences.changed", snapshot(2, { muted: true }));
    }
  });
  await client.fetchQuery(preferenceQuery());
  unsubscribe();
  expect(cached()).toEqual(snapshot(2, { muted: true }));
  expect(applied.at(-1)?.muted).toBe(true);
});

it("keeps the last known cache stale/error after an unreadable save and recovers through a read", async () => {
  stop = syncPreferences(client, () => {});
  acceptPreferences(client, snapshot(1));
  ipc.refuse("preferences.get", { kind: "unexpected", detail: "read failed" });
  await expect(readPreferences()).rejects.toThrow();
  expect(cached()?.revision).toBe(1);
  expect(client.getQueryState(["preferences"])?.isInvalidated).toBe(true);
  ipc.emit("preferences.stale", null);
  expect(cached()?.revision).toBe(1);
  expect(client.getQueryState(["preferences"])?.isInvalidated).toBe(true);
  await expect(client.fetchQuery(preferenceQuery())).rejects.toThrow();
  expect(cached()?.revision).toBe(1);
  expect(client.getQueryState(["preferences"])?.status).toBe("error");
  ipc.always("preferences.get", snapshot(2, { analyticsEnabled: false }));
  await client.fetchQuery(preferenceQuery());
  expect(cached()).toEqual(snapshot(2, { analyticsEnabled: false }));
});

it("detaches composition listeners and supports player reads without React", async () => {
  const applied: Preferences[] = [];
  stop = syncPreferences(client, (preferences) => applied.push(preferences));
  ipc.always("preferences.get", snapshot(1, { audioLanguage: "nl" }));
  expect((await readPreferences()).audioLanguage).toBe("nl");
  stop();
  ipc.emit("preferences.changed", snapshot(2));
  ipc.emit("preferences.stale", null);
  expect(applied).toHaveLength(1);
  expect(cached()?.revision).toBe(1);
  expect(client.getQueryState(["preferences"])?.isInvalidated).toBe(false);
  ipc.always("preferences.get", snapshot(3, { audioLanguage: "de" }));
  expect((await readPreferences()).audioLanguage).toBe("de");
  expect(cached()?.revision).toBe(1);
});

it("applies field effects once per accepted change and prevents an older policy read becoming fresh", async () => {
  stop = syncPreferences(client, () => {});
  acceptPreferences(client, snapshot(1, { adultTitles: true, titleLanguage: "en" }));
  const old = Promise.withResolvers<string>();
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: ["watchlist", "shown"],
    queryFn: () => (++reads === 1 ? old.promise : Promise.resolve("ordinary only")),
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  const changed = snapshot(2, { adultTitles: false, titleLanguage: "nl" });
  ipc.emit("preferences.changed", changed);
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe("ordinary only"));
  old.resolve("old adult titles");
  await Promise.resolve();
  ipc.emit("preferences.changed", changed);
  ipc.emit("preferences.changed", snapshot(1, { adultTitles: true }));
  expect(observer.getCurrentResult().data).toBe("ordinary only");
  expect(reads).toBe(2);
  ipc.emit(
    "preferences.changed",
    snapshot(3, { adultTitles: false, titleLanguage: "nl", muted: true }),
  );
  expect(reads).toBe(2);
  ipc.emit(
    "preferences.changed",
    snapshot(4, { adultTitles: false, titleLanguage: "de", muted: true }),
  );
  await vi.waitFor(() => expect(reads).toBe(3));
  unsubscribe();
});

it("keeps immediate pending volume/mute through unrelated snapshots and older failures", async () => {
  vi.useFakeTimers();
  stop = syncPreferences(client, (preferences) => player.hydrate(preferences));
  acceptPreferences(client, snapshot(1));
  const first = ipc.hold("preferences.update");
  player.setVolume(0.25);
  expect(player.state().volume).toBe(0.25);
  await vi.advanceTimersByTimeAsync(500);
  ipc.emit("preferences.changed", snapshot(2, { audioLanguage: "nl" }));
  expect(player.state().volume).toBe(0.25);
  const second = ipc.hold("preferences.update");
  player.setVolume(0.75);
  player.toggleMute();
  await vi.advanceTimersByTimeAsync(500);
  first.reject({ kind: "unexpected", detail: "first save refused" });
  await vi.advanceTimersByTimeAsync(1);
  expect(player.state()).toMatchObject({ volume: 0.75, muted: true });
  second.resolve(snapshot(3, { volume: 0.75, muted: true, audioLanguage: "nl" }));
  await vi.advanceTimersByTimeAsync(1);
  expect(cached()?.preferences).toMatchObject({ volume: 0.75, muted: true, audioLanguage: "nl" });
  const failed = ipc.hold("preferences.update");
  player.setVolume(0.5);
  await vi.advanceTimersByTimeAsync(500);
  ipc.emit("preferences.changed", snapshot(4, { volume: 0.75, muted: true, audioLanguage: "de" }));
  failed.reject({ kind: "unexpected", detail: "latest save refused" });
  await vi.advanceTimersByTimeAsync(1);
  expect(player.state()).toMatchObject({ volume: 0.75, muted: true });
  expect(cached()?.preferences.audioLanguage).toBe("de");
});
