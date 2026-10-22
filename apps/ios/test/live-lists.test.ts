import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUALITY_STREAM_IDS, startFakeProvider } from "../../desktop/test/fake-provider.ts";
import { liveLists } from "../scripts/live-lists.ts";

// The simulator fixture's channel list controls (scripts/live-lists.ts, on the control port of
// scripts/fixture-server.ts) as the app reads them: the panel's channel list over HTTP, through
// core's Xtream adapter and its quality grouping, as each control changes what it answers.

const [FHD, HD, SD] = [0, 1, 2].map((at) => String(QUALITY_STREAM_IDS + at)) as [
  string,
  string,
  string,
];
const login = { username: "fixture", password: "fixture-pass" };

describe("the channel list controls", () => {
  let provider: Awaited<ReturnType<typeof startFakeProvider>>;
  let lists: ReturnType<typeof liveLists>;
  beforeAll(async () => {
    provider = await startFakeProvider({ ...login, channels: 40, titles: 4 });
    lists = liveLists(provider);
  });
  afterAll(() => provider.close());

  const control = (method: string, route: string) => {
    const answered = lists.control(method, new URL(route, "http://control.test"));
    if (!answered) throw new Error(`no route ${route}`);
    return answered;
  };
  /** The streams of the channel in three qualities, as the app groups the list it reads now. */
  async function qualities() {
    const catalogue = await xtreamProvider(
      { server: provider.url, ...login },
      { userAgent: "fixture" },
    ).liveCatalogue();
    const { channels } = liveChannels(normalizeCatalogue(catalogue).streams);
    return channels
      .filter((channel) => channel.variants.some((variant) => [FHD, HD, SD].includes(variant.id)))
      .map((channel) => ({ id: channel.id, streams: channel.variants.map(({ id }) => id) }));
  }

  it("leaves out a quality, then the whole channel, then lists them all again", async () => {
    expect(await qualities()).toEqual([{ id: FHD, streams: [FHD, HD, SD] }]);

    expect(control("POST", `/live-lists?unlist=${FHD}`)).toMatchObject({
      status: 200,
      body: { unlisted: [FHD] },
    });
    expect(lists.unlisted(FHD)).toBe(true);
    const [channel] = await qualities();
    expect(channel?.id).toBe(HD);
    expect(channel?.streams.toSorted()).toEqual([HD, SD]);

    control("POST", `/live-lists?unlist=${FHD},${HD},${SD}`);
    expect(await qualities()).toEqual([]);

    expect(control("POST", "/live-lists?unlist=")).toMatchObject({ body: { unlisted: [] } });
    expect(lists.unlisted(FHD)).toBe(false);
    expect(await qualities()).toEqual([{ id: FHD, streams: [FHD, HD, SD] }]);
  });

  it("refuses a stream the panel didn't list when it started, changing nothing", async () => {
    control("POST", `/live-lists?unlist=${SD}`);
    expect(control("POST", "/live-lists?unlist=999999")).toEqual({ status: 400, body: null });
    expect(control("GET", "/live-lists")).toMatchObject({ body: { unlisted: [SD] } });
    control("POST", "/live-lists?unlist=");
  });
});
