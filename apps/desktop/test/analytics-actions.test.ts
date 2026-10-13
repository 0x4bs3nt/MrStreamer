import { describe, expect, it } from "vitest";
import type { AnalyticsAction, AnalyticsSetting } from "@mrstreamer/contracts/analytics";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Updates } from "../src/main/services/updates.ts";
import { parseVersion } from "@mrstreamer/contracts/version";
import { homeRows } from "@mrstreamer/core/home/rows";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

describe("committed fixed usage observations", () => {
  it("counts source commits, a shared refresh and a favourite command once despite variants, duplicate command IDs and no-op preferences", async () => {
    const provider = await fakeProvider({ channels: 6 });
    const actions: AnalyticsAction[] = [];
    const settings: AnalyticsSetting[] = [];
    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(await tempDir()),
        usage: {
          action: (key) => () => {
            actions.push(key);
          },
          setting: (key) => () => {
            settings.push(key);
          },
        },
      }),
    );
    const sources = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const viewing = await promised(runtime, ViewingRecord);
    const preferences = await promised(runtime, Settings);
    const login = { server: provider.url, username: "demo", password: "demo" };
    const source = await sources.add(login);
    await sources.add(login);
    expect(actions).toEqual(["playlist_added"]);
    await Promise.all([
      library.refresh(source.id),
      library.refresh(source.id),
      library.refresh(source.id),
    ]);
    expect(actions).toEqual(["playlist_added", "playlist_refreshed"]);
    const channel = (await library.channels({})).find((channel) => channel.variants.length > 1)!;
    expect(channel.variants.length).toBeGreaterThan(1);
    const own = { subscriptionId: source.id, id: channel.id };
    await viewing.setFavourite("first", own, true);
    await viewing.setFavourite("first", own, true);
    await viewing.setFavourite("same-channel", own, true);
    expect((await viewing.state()).favourites.length).toBeGreaterThan(0);
    expect(actions.filter((key) => key === "favourite_added")).toHaveLength(1);
    const other = (await library.channels({})).find((candidate) => candidate.id !== channel.id)!;
    await viewing.setFavourite("other", { subscriptionId: source.id, id: other.id }, true);
    const original = (await viewing.state()).favourites;
    const order = original.toReversed();
    expect((await viewing.reorderFavourites("reorder", { original, order })).favourites).toEqual(
      order,
    );
    await viewing.reorderFavourites("reorder", { original, order });
    await viewing.reorderFavourites("already-ordered", { original: order, order });
    expect(actions.filter((key) => key === "favourite_added")).toHaveLength(2);
    await viewing.setFavourite("remove", own, false);
    expect(actions.filter((key) => key === "favourite_added")).toHaveLength(2);
    await viewing.setFavourite("re-add", own, true);
    expect(actions.filter((key) => key === "favourite_added")).toHaveLength(3);
    await preferences.update({
      autoplayNext: true,
      titleLanguage: "en",
      homeRows: homeRows(undefined),
      volume: 0.5,
    });
    expect(settings).toEqual([]);
    await Promise.all([
      preferences.update({ autoplayNext: false }),
      preferences.update({ autoplayNext: false }),
    ]);
    await preferences.update({ audioLanguage: "nl", subtitleLanguage: "nl" });
    await preferences.setInterfaceLanguage("en-US");
    await preferences.setInterfaceLanguage("en-US");
    expect(settings).toEqual([
      "autoplay_next",
      "audio_language",
      "subtitle_language",
      "interface_language",
    ]);
    await sources.remove(source.id);
    await sources.remove(source.id);
    expect(actions.filter((key) => key === "playlist_removed")).toHaveLength(1);
    expect(JSON.stringify({ actions, settings })).not.toMatch(/demo|http|subscriptionId|channelId/);
  });

  it("counts only current-target dismissal changes and effective update channel changes", async () => {
    const dismissed: AnalyticsAction[] = [];
    const channels: string[] = [];
    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(await tempDir()),
        usage: {
          action: (key) => () => {
            dismissed.push(key);
          },
          setting: () => () => {},
        },
        updates: {
          installed: "0.0.1",
          discover: async () => [
            {
              version: parseVersion("0.0.2")!,
              feedUrl: "https://example.test/latest",
              notes: "",
              page: "https://example.test/release",
            },
          ],
          installer: { download: async () => {}, install: async () => {} },
          onChannelChanged: (channel) => {
            channels.push(channel);
          },
        },
      }),
    );
    const updates = await promised(runtime, Updates);
    await updates.check();
    await updates.dismiss("0.0.0");
    await updates.dismiss("0.0.2");
    await updates.dismiss("0.0.2");
    expect(dismissed).toEqual(["update_dismissed"]);
    await updates.setChannel("stable");
    await updates.setChannel("nightly");
    await updates.setChannel("nightly");
    expect(channels).toEqual(["nightly"]);
  });
});
