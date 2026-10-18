import { collectionRows, collections } from "@mrstreamer/core/ondemand/collections";
import { indexCatalogue, kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  measurementTitles,
  pngLogo,
  startFakeProvider,
  TITLES_ADDED,
  type FakeProvider,
  type Measurement,
} from "./fake-provider.ts";

// The iOS simulator fixture's measurement profile (apps/ios/scripts/fixture-server.ts,
// FIXTURE_PROFILE=measure) as the apps read it: the fake panel's lists over HTTP, through the shared catalogue and the
// collections Movies and Series show. New and 4K hold exactly the titles it declares while the
// clock reads within its window, in any viewer language, with TMDB's metadata or without.

describe("the measurement profile", () => {
  let provider: FakeProvider;
  let measured: Measurement;
  beforeAll(async () => {
    provider = await startFakeProvider({ titles: 2000, username: "fixture", password: "pass" });
    measured = measurementTitles(provider.titles, TITLES_ADDED);
    provider.serveTitles(() => measured.titles);
  });
  afterAll(() => provider.close());

  it("fills New and 4K for movies and series with the titles it declares", async () => {
    const catalogue = await xtreamProvider(
      { server: provider.url, username: "fixture", password: "pass" },
      { userAgent: "fixture" },
    ).onDemandCatalogue();
    expect(catalogue.movies).toHaveLength(provider.titles.movies.length);
    expect(catalogue.series).toHaveLength(provider.titles.series.length);
    for (const language of ["en", "nl"]) {
      const index = indexCatalogue([{ subscriptionId: "fixture", catalogue }], language);
      // TMDB's metadata, when it has arrived, saying every title was made in another language.
      for (const madeIn of [null, "ja"]) {
        for (const now of [measured.now.from, measured.now.to]) {
          for (const kind of ["movie", "series"] as const) {
            const declared = kind === "movie" ? measured.movies : measured.series;
            const made = collections({
              kind,
              titles: kindOf(index, kind).titles,
              language,
              metadata: () =>
                madeIn === null
                  ? null
                  : {
                      genres: [],
                      language: madeIn,
                      popularity: 1,
                      rating: 7,
                      votes: 200,
                      collection: null,
                      backdrop: null,
                    },
              names: () => null,
              services: [],
              now: now * 1000,
            });
            const fresh = collectionRows(made, "new", null);
            expect(fresh.map((row) => [row.id, row.total])).toEqual([
              ["new-week", declared.week],
              ["new-month", declared.week + declared.month],
            ]);
            expect(made.list("4k")).toHaveLength(declared.fourK);
            expect(declared.fourK).toBeGreaterThan(20);
            expect(declared.week).toBeGreaterThan(20);
          }
        }
      }
    }
  });
});

describe("PNG logos", () => {
  it("lists each channel's logo as a PNG mark the panel serves", async () => {
    const provider = await startFakeProvider({ channels: 100, logoPng: pngLogo });
    try {
      const listed = new URL(
        "/player_api.php?username=demo&password=demo&action=get_live_streams",
        provider.url,
      );
      const channels = (await (await fetch(listed)).json()) as { stream_icon: string }[];
      const icons = channels.map((channel) => channel.stream_icon).filter(Boolean);
      expect(icons.length).toBeGreaterThan(10);
      const sizes = new Set<string>();
      for (const icon of icons) {
        expect(icon).toMatch(/\/logos\/\d+\.png$/);
        const answer = await fetch(icon);
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-type")).toBe("image/png");
        const bytes = Buffer.from(await answer.arrayBuffer());
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));
        expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
        sizes.add(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
      }
      expect(sizes.size).toBeGreaterThan(3);
    } finally {
      await provider.close();
    }
  });
});
