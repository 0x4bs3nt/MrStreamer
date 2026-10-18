import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import type { LiveSearchGroups } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import {
  automaticSearchCopy,
  indexLiveSearch,
  searchResultGroups,
} from "@mrstreamer/core/catalogue/search";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

const stampsOf = (groups: LiveSearchGroups) =>
  Object.fromEntries(
    groups.flatMap(({ key, copies }) => copies.map((id, order) => [id, { key, order }] as const)),
  );

async function started(dataDir: string) {
  const runtime = runtimeFor(
    Library.layer({ confirmDelay: 0 }).pipe(
      Layer.provideMerge(Settings.layer(dataDir)),
      Layer.provideMerge(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
    ),
  );
  return {
    library: await promised(runtime, Library),
    subscriptions: await promised(runtime, Subscriptions),
  };
}

it("search keeps every provider/category/quality copy and reconstructs safe metadata from unchanged raw caches", async () => {
  const providers = [await fakeProvider(), await fakeProvider()];
  for (const provider of providers) {
    const categories = provider.catalogue.categories.filter((category) =>
      category.name.startsWith("BE |"),
    );
    provider.serveChannels((channels) =>
      channels.slice(0, 5).map((channel, index) => ({
        ...channel,
        name: [
          "BE | VRT 1 FHD",
          "BE | VRT 1 HD",
          "BE | VRT 1 SD",
          "BE | VRT CANVAS FHD",
          "BE | VRT CANVAS HD",
        ][index]!,
        categoryId: categories[index === 2 || index === 4 ? 1 : 0]!.id,
        guideId: index < 3 ? "VRT1.be" : "VRTCanvas.be",
        adult: false,
      })),
    );
  }
  const dataDir = await tempDir();
  const { library, subscriptions } = await started(dataDir);
  const ids = [];
  for (const provider of providers) {
    const subscription = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    ids.push(subscription.id);
    await library.refresh(subscription.id);
  }
  const ordinary = await library.channels({});
  expect(ordinary).toHaveLength(8);
  const decisions = await library.searchGroups();
  const stamps = stampsOf(decisions);
  expect(Object.keys(stamps).toSorted()).toEqual(ordinary.map(ownedKey).toSorted());
  expect(
    Object.values(stamps).every((stamp) => Object.keys(stamp).toSorted().join() === "key,order"),
  ).toBe(true);
  const stamped = ordinary.map((channel) => ({
    ...channel,
    searchGroup: stamps[ownedKey(channel)]!,
  }));
  expect(searchResultGroups(stamped).map((group) => [group.copies.length, group.streams])).toEqual([
    [4, 6],
    [4, 4],
  ]);
  const results = await library.channels({ query: "VRT" });
  expect(results).toHaveLength(8);
  expect(searchResultGroups(results).map((group) => [group.copies.length, group.streams])).toEqual([
    [4, 6],
    [4, 4],
  ]);
  const qualityMatches = await library.channels({ query: "FHD" });
  expect(qualityMatches).toHaveLength(8);
  const savedOrder = ids.map((id) => ({ id }));
  const sdMatches = await library.channels({ query: "VRT 1 SD" });
  expect(searchResultGroups(sdMatches)).toHaveLength(1);
  const qualityGroup = searchResultGroups(sdMatches).find(
    (group) => group.copies[0]?.title === "VRT 1",
  )!;
  const grouped = stamped;
  const ordinaryGroup = indexLiveSearch(grouped).groups.find(
    (group) => group.copies[0]?.title === "VRT 1",
  )!;
  expect(automaticSearchCopy(qualityGroup, new Set(), savedOrder)).toEqual(
    automaticSearchCopy(ordinaryGroup, new Set(), savedOrder),
  );
  const programmeMatches = await library.channels({
    query: "evening news",
    channels: [{ subscriptionId: ids[1]!, id: "1002" }],
  });
  expect(
    searchResultGroups(programmeMatches).map((group) => [group.copies.length, group.streams]),
  ).toEqual([[4, 6]]);
  for (const copy of ordinary) {
    expect(copy).not.toHaveProperty("searchGroup");
    expect(copy).not.toHaveProperty("searchIdentity");
  }
  expect(grouped.map(({ searchGroup: _group, ...copy }) => copy)).toEqual(ordinary);
  expect(grouped.map((channel) => channel.searchGroup)).toEqual(
    ordinary.map((channel) => stamps[ownedKey(channel)]),
  );
  for (const response of [grouped, results, qualityMatches, sdMatches, programmeMatches]) {
    for (const copy of response) {
      expect(copy.searchGroup).toEqual({ key: expect.any(String), order: expect.any(Number) });
      expect(copy).not.toHaveProperty("searchIdentity");
    }
  }
  for (const { searchGroup: _group, ...channel } of results) {
    const { searchIdentity, ...canonical } = await library.channel(channel);
    expect(searchIdentity).toBeDefined();
    expect(canonical).toEqual(channel);
  }
  const cached = type({
    version: "4",
    channels: type({ "searchIdentity?": "undefined", "searchGroup?": "undefined" }).array(),
  })(JSON.parse(await readFile(join(dataDir, "catalogue.json"), "utf8")));
  expect(cached).not.toBeInstanceOf(type.errors);
  await Promise.all(providers.map((provider) => provider.close()));
  const restart = await started(dataDir);
  expect(await restart.library.channels({ query: "VRT" })).toEqual(results);
  expect(await restart.library.channels({})).toEqual(ordinary);
  expect(await restart.library.searchGroups()).toEqual(decisions);
  expect((await restart.library.status()).map((status) => status.subscriptionId)).toEqual(ids);
});

it("catalogue stamps change after a hidden guide conflict without fetching on reads", async () => {
  const providers = [await fakeProvider(), await fakeProvider(), await fakeProvider()];
  let conflict = false;
  const fetched = [0, 0, 0];
  for (const [index, provider] of providers.entries()) {
    const category = provider.catalogue.categories.find((each) => each.name.startsWith("BE |"))!;
    provider.serveChannels((channels) => {
      fetched[index]!++;
      return [
        {
          ...channels[0]!,
          name: "BE | VRT 1 FHD",
          categoryId: category.id,
          guideId: index === 1 ? "" : index === 2 && conflict ? "een.be" : "VRT1.be",
          adult: false,
        },
      ];
    });
  }
  const { library, subscriptions } = await started(await tempDir());
  const ids: string[] = [];
  for (const provider of providers) {
    const saved = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    ids.push(saved.id);
    await library.refresh(saved.id);
  }
  const subset = await library.channels({
    channels: ids.slice(0, 2).map((subscriptionId) => ({ subscriptionId, id: "1000" })),
  });
  expect(subset).toHaveLength(2);
  const before = stampsOf(await library.searchGroups());
  expect(new Set(subset.map((copy) => before[ownedKey(copy)]?.key)).size).toBe(1);
  conflict = true;
  await library.refresh(ids[2]!);
  const decisions = await library.searchGroups();
  expect(decisions).toEqual([]);
  const after = stampsOf(decisions);
  expect(new Set(subset.map((copy) => after[ownedKey(copy)]?.key ?? ownedKey(copy))).size).toBe(2);
  expect(await library.channels({ channels: subset })).toEqual(subset);
  expect(await library.searchGroups()).toEqual(decisions);
  expect(fetched).toEqual([1, 1, 2]);
});

it("palette responses retain full-catalogue ambiguity when the query excludes a conflicting copy", async () => {
  const providers = [await fakeProvider(), await fakeProvider(), await fakeProvider()];
  for (const [index, provider] of providers.entries()) {
    const category = provider.catalogue.categories.find((each) => each.name.startsWith("BE |"))!;
    provider.serveChannels((channels) => [
      {
        ...channels[0]!,
        name: index === 2 ? "BE | VRT 1 HD" : "BE | VRT 1 FHD",
        categoryId: category.id,
        guideId: ["VRT1.be", "", "een.be"][index]!,
        adult: false,
      },
    ]);
  }
  const { library, subscriptions } = await started(await tempDir());
  for (const provider of providers) {
    const saved = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    await library.refresh(saved.id);
  }
  const whole = await library.channels({ query: "vrt 1" });
  expect(searchResultGroups(whole)).toHaveLength(3);
  const partial = await library.channels({ query: "vrt 1 fhd" });
  expect(partial).toHaveLength(2);
  expect(searchResultGroups(partial)).toHaveLength(2);
  expect(new Set(partial.map((copy) => copy.searchGroup?.key)).size).toBe(2);
  const list = await library.channels({
    channels: partial.map(({ subscriptionId, id }) => ({ subscriptionId, id })),
  });
  const stamps = stampsOf(await library.searchGroups());
  const grouped = list.map((copy) => ({
    ...copy,
    searchGroup: stamps[ownedKey(copy)] ?? { key: ownedKey(copy), order: 0 },
  }));
  // A list can hide the conflicting guide, but it cannot turn that absence into identity.
  expect(indexLiveSearch(grouped).groups).toHaveLength(2);
  expect(grouped.map((copy) => copy.searchGroup)).toEqual(partial.map((copy) => copy.searchGroup));
  expect(list.every((copy) => !Object.hasOwn(copy, "searchIdentity"))).toBe(true);
});

it("ranks exact displayed channel names before prefixes and finds joined punctuation spellings", async () => {
  const provider = await fakeProvider();
  const names = ["Heating", "The Heat", "Heat", "Spider-Man", "O'Brien"];
  provider.serveChannels((channels) =>
    channels.slice(0, names.length).map((channel, index) => ({
      ...channel,
      name: names[index]!,
      guideId: null,
      adult: false,
    })),
  );
  const { library, subscriptions } = await started(await tempDir());
  const subscription = await subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await library.refresh(subscription.id);
  expect((await library.channels({ query: "heat" })).map((channel) => channel.title)).toEqual([
    "Heat",
    "Heating",
    "The Heat",
  ]);
  expect((await library.channels({ query: "spiderman" })).map((channel) => channel.title)).toEqual([
    "Spider-Man",
  ]);
  expect((await library.channels({ query: "obrien" })).map((channel) => channel.title)).toEqual([
    "O'Brien",
  ]);
});
