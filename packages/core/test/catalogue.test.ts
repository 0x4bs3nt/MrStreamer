import type { ChannelVariant, Quality } from "@mrstreamer/contracts/library";
import { describe, expect, it } from "vitest";
import { isAdultCategory } from "../src/adult.ts";
import { normalizeCatalogue } from "../src/catalogue/normalize.ts";
import {
  liveChannels,
  qualityOf,
  streamsToPlay,
  type ListedChannel,
} from "../src/catalogue/variants.ts";
import type { LiveCatalogue } from "../src/provider.ts";

/** A raw catalogue from category names and [channel name, category index] pairs. */
function catalogue(
  categories: readonly string[],
  channels: readonly (readonly [string, number])[] = [],
): LiveCatalogue {
  return {
    categories: categories.map((name, index) => ({ id: String(index), name })),
    channels: channels.map(([name, category], index) => ({
      id: `c${index}`,
      name,
      number: index + 1,
      logoUrl: null,
      categoryIds: [String(category)],
      guideId: null,
      catchupDays: null,
    })),
  };
}

function categoriesOf(raw: LiveCatalogue) {
  return normalizeCatalogue(raw).categories.map((category) => [category.group, category.title]);
}

function channelsOf(raw: LiveCatalogue) {
  return normalizeCatalogue(raw).streams.map((stream) => [stream.title, stream.tags]);
}

// The same rules have to read every provider's style, so the cases below come from several.
describe("categories", () => {
  it("groups by region and lets a region with one category stand alone when it names itself", () => {
    const raw = catalogue([
      "NL | NEDERLAND",
      "NL | SPORT",
      "BE | VLAANDEREN",
      "BE - FR | VOETBAL & EVENTS",
      "LU | LUXEMBOURG",
      "UKR | UKRAIN",
      "KR | KURDISH",
      "DE | ALL",
      "FOR ADULTS",
    ]);

    expect(categoriesOf(raw)).toEqual([
      ["Netherlands", "Nederland"],
      ["Netherlands", "Sport"],
      ["Belgium", "Vlaanderen"],
      ["Belgium", "Voetbal & Events (FR)"],
      [null, "Luxembourg"],
      [null, "Ukrain"],
      [null, "Kurdish"],
      ["Germany", "All"],
      [null, "For Adults"],
    ]);
  });

  it.each([
    ["colon codes", ["UK: Entertainment", "UK: Sports", "US: News", "US: Sports"]],
    ["dashes", ["UK - Entertainment", "UK - Sports", "US - News", "US - Sports"]],
    ["brackets", ["[UK] Entertainment", "[UK] Sports", "[US] News", "[US] Sports"]],
    ["three-letter codes", ["GBR | ENTERTAINMENT", "GBR | SPORTS", "USA | NEWS", "USA | SPORTS"]],
    ["flags", ["🇬🇧 Entertainment", "🇬🇧 Sports", "🇺🇸 News", "🇺🇸 Sports"]],
    [
      "country names",
      [
        "United Kingdom | Entertainment",
        "GREAT BRITAIN: SPORTS",
        "USA | News",
        "United States: Sports",
      ],
    ],
  ])("reads %s", (_style, names) => {
    expect(categoriesOf(catalogue(names))).toEqual([
      ["United Kingdom", "Entertainment"],
      ["United Kingdom", "Sports"],
      ["United States", "News"],
      ["United States", "Sports"],
    ]);
  });

  it("reads the reseller codes and spelled-out names in other languages", () => {
    const raw = catalogue([
      "AR | MBC",
      "AR | NEWS",
      "EXYU | SPORT",
      "EXYU | FILM",
      "België | Sport",
      "BELGIQUE: FILMS",
    ]);

    expect(categoriesOf(raw)).toEqual([
      ["Arabic", "MBC"],
      ["Arabic", "News"],
      ["Ex-Yugoslavia", "Sport"],
      ["Ex-Yugoslavia", "Film"],
      ["Belgium", "Sport"],
      ["Belgium", "Films"],
    ]);
  });

  it("takes flags as countries, even where resellers use the code for something else", () => {
    expect(categoriesOf(catalogue(["🇦🇷 Deportes", "🇦🇷 Noticias"]))).toEqual([
      ["Argentina", "Deportes"],
      ["Argentina", "Noticias"],
    ]);
  });

  it("groups unknown codes several categories share, and keeps one-off codes in the name", () => {
    const raw = catalogue([
      "VIP | SPORTS",
      "VIP | MOVIES",
      "UK | NEWS",
      "UK | KIDS",
      "TEST | Streams and failures",
    ]);

    expect(categoriesOf(raw)).toEqual([
      ["VIP", "Sports"],
      ["VIP", "Movies"],
      ["United Kingdom", "News"],
      ["United Kingdom", "Kids"],
      [null, "TEST | Streams and failures"],
    ]);
  });

  it("leaves catalogues without region prefixes flat", () => {
    const raw = catalogue(["Sports", "NEWS", "Movies", "VIP: Premium", "4K | NATURE"]);

    expect(categoriesOf(raw)).toEqual([
      [null, "Sports"],
      [null, "News"],
      [null, "Movies"],
      [null, "VIP: Premium"],
      [null, "4K | Nature"],
    ]);
  });
});

describe("channels", () => {
  it("drops what the category already says and splits off quality tags", () => {
    const raw = catalogue(
      ["BE | VLAANDEREN", "BE | KIDS", "DE | SPORT", "UK | NEWS"],
      [
        ["BE | VRT 1 FHD (VLAANDEREN)", 0],
        ["BE | NICKELODEON (VLAANDEREN)", 1],
        ["BE - FR | RTBF LA UNE HD", 1],
        ["BE | E! HD", 1],
        ["EUROSPORT 1 FHD²", 2],
        ["SKY SPORT BUNDESLIGA ᴴᴰ", 2],
        ["DAZN F1 ʰᵉᵛᶜ", 2],
        ["13TH STREET HD", 2],
        ["DE | SKY SPORT 1 FHD + HEVC", 2],
        ["IT | Sky Calcio 251 HD", 2],
        ["UK: BBC ONE HD", 3],
        ["UK: HD", 3],
      ],
    );

    expect(channelsOf(raw)).toEqual([
      ["VRT 1", ["FHD"]],
      // In another category the region tells two versions of a channel apart, so it stays.
      ["Nickelodeon (Vlaanderen)", []],
      ["RTBF La Une", ["HD"]],
      ["E!", ["HD"]],
      ["Eurosport 1", ["FHD"]],
      ["Sky Sport Bundesliga", ["HD"]],
      ["DAZN F1", ["HEVC"]],
      ["13th Street", ["HD"]],
      ["Sky Sport 1", ["FHD", "HEVC"]],
      ["Sky Calcio 251", ["HD"]],
      ["BBC One", ["HD"]],
      // Cleaning would leave nothing, so the provider's name stays.
      ["UK: HD", []],
    ]);
  });

  it("keeps prefixes that are not regions, and drops flags and resolution markers", () => {
    const raw = catalogue(
      ["Sports", "News"],
      [
        ["ESPN: SPORTSCENTER", 0],
        ["NBC: CHICAGO", 1],
        ["🇬🇧 BBC NEWS", 1],
        ["CNN International (1080p)", 1],
        ["BBC One [Geo-blocked]", 1],
      ],
    );

    expect(channelsOf(raw)).toEqual([
      ["ESPN: Sportscenter", []],
      ["NBC: Chicago", []],
      ["BBC News", []],
      ["CNN International", ["1080p"]],
      ["BBC One [Geo-blocked]", []],
    ]);
  });

  it("leaves out separator entries", () => {
    const raw = catalogue(
      ["Sports"],
      [
        ["##### UK SPORTS #####", 0],
        ["━━━ NL ━━━", 0],
        ["== NL ==", 0],
        ["****************ARGENTINA****************", 0],
        ["#1 HITS", 0],
        ["A-Z CHANNEL", 0],
      ],
    );

    expect(channelsOf(raw)).toEqual([
      ["#1 Hits", []],
      ["A-Z Channel", []],
    ]);
  });
});

/** A raw catalogue from category names and [channel name, category index, guide id] triples. */
function guided(
  categories: readonly string[],
  channels: readonly (readonly [string, number, string?])[],
): LiveCatalogue {
  return {
    categories: catalogue(categories).categories,
    channels: channels.map(([name, category, guideId], index) => ({
      id: String(100 + index),
      name,
      number: index + 1,
      logoUrl: null,
      categoryIds: [String(category)],
      guideId: guideId ?? null,
      catchupDays: null,
    })),
  };
}

/** Each channel's title with the provider's names of its streams. */
function joined(raw: LiveCatalogue) {
  return liveChannels(normalizeCatalogue(raw).streams).channels.map(
    (channel): [string, string[]] => [channel.title, channel.variants.map(({ name }) => name)],
  );
}

describe("channels with several streams", () => {
  it.each([
    ["AR", "Arabic", "guide.qa", "guideqa"],
    ["AF", "Africa", "guide.za", "guideza"],
    ["EU", "Europe", "guide.de", "guidede"],
    ["INT", "World", "guide.us", "guideus"],
  ])(
    "keeps %s quality feeds joined and searchable with a country guide",
    (prefix, region, guide, guideId) => {
      const raw = guided(
        [`${prefix} | News`],
        [
          [`${prefix} | Matrix HD`, 0, guide],
          [`${prefix} | Matrix FHD`, 0, guide],
        ],
      );
      const { channels, guideIds } = liveChannels(normalizeCatalogue(raw).streams);
      expect(channels).toHaveLength(1);
      expect(channels[0]).toMatchObject({
        id: "100",
        title: "Matrix",
        categoryIds: ["0"],
        searchIdentity: {
          title: "matrix",
          language: null,
          region,
          topics: [`${region}|news`],
          guideId,
        },
      });
      expect(channels[0]?.variants.map((variant) => variant.id)).toEqual(["100", "101"]);
      expect(guideIds.get("100")).toEqual([guide]);
    },
  );

  it("keeps a Belgian category with a Dutch guide isolated", () => {
    const raw = guided(
      ["BE | News"],
      [
        ["BE | Matrix HD", 0, "guide.nl"],
        ["BE | Matrix FHD", 0, "guide.nl"],
      ],
    );
    const { channels, guideIds } = liveChannels(normalizeCatalogue(raw).streams);
    expect(channels.map((channel) => channel.variants.map((variant) => variant.id))).toEqual([
      ["100"],
      ["101"],
    ]);
    expect(channels.map((channel) => channel.searchIdentity)).toEqual([undefined, undefined]);
    expect([...guideIds]).toEqual([
      ["100", ["guide.nl"]],
      ["101", ["guide.nl"]],
    ]);
  });

  it("reads guide countries as ISO codes rather than reseller language or continent prefixes", () => {
    const raw = guided(
      ["🇦🇷 News", "🇦🇫 News"],
      [
        ["🇦🇷 Matrix HD", 0, "matrix.ar@HD"],
        ["🇦🇷 Matrix FHD", 0, "matrix.ar@FHD"],
        ["🇦🇫 Matrix HD", 1, "matrix.af@HD"],
        ["🇦🇫 Matrix FHD", 1, "matrix.af@FHD"],
      ],
    );
    const channels = liveChannels(normalizeCatalogue(raw).streams).channels;
    expect(channels.map((channel) => channel.variants.length)).toEqual([2, 2]);
    expect(channels.map((channel) => channel.searchIdentity?.region)).toEqual([
      "Argentina",
      "Afghanistan",
    ]);
  });

  it("keeps conflicting and unknown memberships from joining or bridging channels", () => {
    const raw = guided(
      ["BE | News", "NL | News", "BE - FR | News", "BE - NL | News"],
      [
        ["Shared HD", 0, "shared.be"],
        ["Shared FHD", 1, "shared.nl"],
        ["Shared SD", 0],
        ["Language HD", 2],
        ["Language FHD", 3],
        ["Language SD", 2],
        ["BE | Conflict HD", 1],
        ["BE | Conflict FHD", 0],
        ["Guide HD", 0, "guide.nl"],
        ["Guide FHD", 0, "guide.nl"],
        ["Unknown HD", 99],
        ["Unknown FHD", 99],
      ],
    );
    const channels = raw.channels.map((channel, index) => ({
      ...channel,
      categoryIds: index === 2 ? ["0", "1"] : index === 5 ? ["2", "3"] : channel.categoryIds,
    }));
    const result = liveChannels(normalizeCatalogue({ ...raw, channels }).streams).channels;
    expect(result).toHaveLength(channels.length);
    expect(result.every((channel) => channel.variants.length === 1)).toBe(true);
    expect(result.filter((channel) => channel.searchIdentity).map((channel) => channel.id)).toEqual(
      ["100", "101", "103", "104", "107"],
    );
  });

  it("joins one channel's qualities and backups, also from a category for a quality alone", () => {
    const raw = guided(
      ["BE | VLAANDEREN", "BE | VLAANDEREN HD", "BE | 4K", "BE | SPORT"],
      [
        ["BE | VRT 1 FHD", 0, "VRT1.be"],
        ["BE | VTM HD", 0],
        ["BE | VRT 1 SD", 1],
        ["BE | VRT 1 4K", 2],
        ["EUROSPORT 1 FHD", 3],
        ["EUROSPORT 1 FHD²", 3],
      ],
    );

    const { channels, guideIds } = liveChannels(normalizeCatalogue(raw).streams);

    expect(joined(raw)).toEqual([
      ["VRT 1", ["BE | VRT 1 FHD", "BE | VRT 1 SD", "BE | VRT 1 4K"]],
      ["VTM", ["BE | VTM HD"]],
      ["Eurosport 1", ["EUROSPORT 1 FHD", "EUROSPORT 1 FHD²"]],
    ]);
    expect(channels[0]).toMatchObject({
      id: "100",
      tags: [],
      categoryIds: ["0", "1", "2"],
      variants: [{ quality: "fhd" }, { quality: "sd" }, { quality: "uhd" }],
    });
    expect(channels[1]).toMatchObject({ tags: ["HD"] });
    // Streams without a guide id share the channel's.
    expect(guideIds.get("100")).toEqual(["VRT1.be"]);
  });

  it("keeps apart streams that may be another channel", () => {
    const raw = guided(
      [
        "BE | VLAANDEREN",
        "BE | SPORT",
        "BE - FR | WALLONIE",
        "BE | 4K",
        "UK | ENTERTAINMENT",
        "NL | ALGEMEEN",
        "CA | FRENCH",
        "CA | ENGLISH",
      ],
      [
        // Another region, and another language.
        ["UK: BBC ONE HD", 4],
        ["NL: BBC ONE FHD", 5],
        ["BE - FR | RTBF LA UNE HD", 2],
        ["BE | RTBF LA UNE FHD", 0],
        // Other categories, and one for a quality alone beside both.
        ["BE | EÉN HD", 0],
        ["BE | EÉN FHD", 1],
        ["BE | EÉN 4K", 3],
        ["CA | DISCOVERY HD", 6],
        ["CA | DISCOVERY FHD", 7],
        // Names that differ in a symbol or a space.
        ["NL: CANAL+ HD", 5],
        ["NL: CANAL FHD", 5],
        ["NL: BLOOMBERG TV + FHD", 5],
        ["NL: BLOOMBERG TV HD", 5],
        ["NL: NPO1 HD", 5],
        ["NL: NPO 1 FHD", 5],
        // Guide ids that disagree.
        ["NL: RTL 4 HD", 5, "RTL4.nl"],
        ["NL: RTL 4 FHD", 5, "RTL4Gooi.nl"],
        // Also when little but their spelling differs: another country, a symbol.
        ["NL: KADE HD", 5, "kade.nl"],
        ["NL: KADE FHD", 5, "Kade BE"],
        ["NL: BRABO HD", 5, "brabo.nl"],
        ["NL: BRABO FHD", 5, "Brabo+ NL"],
        // One guide id spelt two ways joins nothing by itself.
        ["NL: ZENDER1 HD", 5, "zender1.nl"],
        ["NL: ZENDER 1 FHD", 5, "Zender 1 NL"],
      ],
    );

    expect(joined(raw).every(([, names]) => names.length === 1)).toBe(true);
    expect(joined(raw).map(([title]) => title)).toContain("Bloomberg TV +");
  });

  // Invented names, spelt as one panel does: it lists a channel's Full HD stream first, with the
  // higher id, and writes the channel's guide id another way on each.
  it("joins streams whose guide ids are one id spelt differently, and keeps each spelling", () => {
    const raw = guided(
      ["BE | VLAANDEREN", "IT | BAMBINI", "TR | SINEMA"],
      [
        ["BE | BRABO HD", 0, "brabo BE"],
        ["BE | BRABO FHD", 0, "brabo.be"],
        ["IT | KADE GULP HD", 1, "kadegulp.it"],
        ["IT | KADE GULP FHD", 1, "Kade Gulp IT"],
        ["TR | DAILYMAX HD", 2, "DailyMax.tr"],
        ["TR | DAILYMAX FHD", 2, "dailymax.tr"],
        ["TR | DAILYMAX SD", 2],
      ],
    );
    const [hd, fhd, ...rest] = raw.channels;
    const listed = { ...raw, channels: [fhd!, hd!, ...rest] };

    const { channels, guideIds } = liveChannels(normalizeCatalogue(listed).streams);

    expect(joined(listed)).toEqual([
      ["Brabo", ["BE | BRABO FHD", "BE | BRABO HD"]],
      ["Kade Gulp", ["IT | KADE GULP HD", "IT | KADE GULP FHD"]],
      ["Dailymax", ["TR | DAILYMAX HD", "TR | DAILYMAX FHD", "TR | DAILYMAX SD"]],
    ]);
    // The channel's id stays the lowest of its streams', and the guide may know either spelling.
    expect(channels[0]).toMatchObject({
      id: "100",
      number: 2,
      variants: [{ id: "101" }, { id: "100" }],
    });
    expect(channels.map(({ id }) => guideIds.get(id))).toEqual([
      ["brabo.be", "brabo BE"],
      ["kadegulp.it", "Kade Gulp IT"],
      ["DailyMax.tr", "dailymax.tr"],
    ]);
  });

  // Invented names in the style of a public playlist: the country and the feed in the guide id,
  // the picture's lines in the name.
  it("joins a playlist's SD and HD feeds of a channel, and keeps other feeds and countries apart", () => {
    const raw = guided(
      ["General", "News"],
      [
        ["Brabo (576p)", 0, "Brabo.be@SD"],
        ["Brabo HD (1080p)", 0, "Brabo.be@HD"],
        ["Kade One North (540p) [Geo-blocked]", 0, "KadeOne.uk@North"],
        ["Kade One North HD (720p) [Geo-blocked]", 0, "KadeOne.uk@NorthHD"],
        ["Kade One (720p)", 0, "KadeOne.uk@East"],
        ["Kade One (720p)", 0, "KadeOne.uk@West"],
        ["Daily 24 (576p)", 1, "Daily24.in@SD"],
        ["Daily 24 HD", 1, "Daily24HD.pk@SD"],
      ],
    );

    expect(joined(raw)).toEqual([
      ["Brabo", ["Brabo (576p)", "Brabo HD (1080p)"]],
      [
        "Kade One North [Geo-blocked]",
        ["Kade One North (540p) [Geo-blocked]", "Kade One North HD (720p) [Geo-blocked]"],
      ],
      ["Kade One", ["Kade One (720p)"]],
      ["Kade One", ["Kade One (720p)"]],
      ["Daily 24", ["Daily 24 (576p)"]],
      ["Daily 24", ["Daily 24 HD"]],
    ]);
  });
});

describe("quality", () => {
  it.each([
    [["FHD"], "fhd"],
    [["1080p"], "fhd"],
    [["HD", "1080p"], "fhd"],
    [["4K", "UHD"], "uhd"],
    [["HD+"], "hd"],
    [["HD", "HEVC"], "hd"],
    [["576p"], "sd"],
    [[], null],
    [["HEVC"], null],
    [["RAW", "50FPS"], null],
    [["HD", "576p"], null],
    [["SD", "1080p"], null],
  ] as const)("reads %j as %s", (tags, quality) => {
    expect(qualityOf(tags)).toBe(quality);
  });
});

describe("which stream plays", () => {
  const variant = (id: string, quality: Quality | null): ChannelVariant => ({
    id,
    name: id,
    tags: [],
    quality,
  });
  const channel = (...variants: ChannelVariant[]): ListedChannel => ({
    id: variants[0]?.id ?? "",
    name: "",
    title: "",
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    variants,
    catchupDays: null,
  });
  const ids = (variants: readonly ChannelVariant[]) => variants.map(({ id }) => id);
  const all = channel(
    variant("uhd", "uhd"),
    variant("unknown", null),
    variant("sd", "sd"),
    variant("hd", "hd"),
    variant("fhd", "fhd"),
    variant("fhd-backup", "fhd"),
  );

  it("starts Auto at the preferred quality, then lower ones, higher ones and unknown, three at most", () => {
    expect(ids(streamsToPlay(all, {}))).toEqual(["fhd", "fhd-backup", "hd"]);
    expect(ids(streamsToPlay(all, { liveQuality: "sd" }))).toEqual(["sd", "hd", "fhd"]);
    expect(ids(streamsToPlay(all, { liveQuality: "uhd" }))).toEqual(["uhd", "fhd", "fhd-backup"]);
    const sparse = channel(variant("u", null), variant("4k", "uhd"), variant("s", "sd"));
    expect(ids(streamsToPlay(sparse, {}))).toEqual(["s", "4k", "u"]);
  });

  it("plays a chosen stream alone, kept under any of the channel's streams", () => {
    expect(ids(streamsToPlay(all, { channelVariants: { hd: "sd" } }))).toEqual(["sd"]);
    expect(ids(streamsToPlay(all, {}, "unknown"))).toEqual(["unknown"]);
    // A stream the channel no longer lists: Auto when it was remembered, none when asked for.
    expect(ids(streamsToPlay(all, { channelVariants: { uhd: "gone" } }))).toHaveLength(3);
    expect(streamsToPlay(all, {}, "gone")).toEqual([]);
  });
});

describe("categories for adults", () => {
  it.each([
    "XXX | FOR ADULTS",
    "ADULT 18+",
    "+18",
    "ADULTOS +18",
    "FR| ADULTES",
    "IT| PER ADULTI",
    "PORNO",
    "DE| ERWACHSENE",
    "NL| VOLWASSENEN",
  ])("reads %s as for adults", (name) => {
    expect(isAdultCategory(name)).toBe(true);
  });

  it.each(["US| ADULT SWIM", "ADULTERY DRAMAS", "MATURE", "XXL SPORTS", "UFC 218", "KIDS"])(
    "reads %s as for everyone",
    (name) => {
      expect(isAdultCategory(name)).toBe(false);
    },
  );
});
