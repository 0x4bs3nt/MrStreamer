import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { guideAddress } from "../src/guide/address.ts";
import { xmltvDocument } from "../src/guide/document.ts";
import { GUIDE_LIMITS } from "../src/guide/limits.ts";
import {
  indexProgrammes,
  mappedChannels,
  type CatalogueChannels,
} from "../src/guide/programmes.ts";

/** Noon on a day in October 2026, in UTC. */
const NOON = Date.UTC(2026, 9, 2, 12);
const HOUR = 60 * 60 * 1000;

/** `bytes` as a sender splits them: in pieces of `size`. */
async function* pieces(bytes: Uint8Array | string, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  const all = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  for (let at = 0; at < all.length; at += size) yield all.subarray(at, at + size);
}

async function text(document: AsyncIterable<Uint8Array>): Promise<string> {
  const read: Uint8Array[] = [];
  for await (const piece of document) read.push(piece);
  return Buffer.concat(read).toString("utf8");
}

/** Why a guide was refused. */
async function refusal(work: Promise<unknown>): Promise<unknown> {
  const cause = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  return cause instanceof AppFailure && cause.error.kind === "guide" ? cause.error.failure : cause;
}

const programme = (channel: string, start: string, stop: string | null, title: string) =>
  `<programme start="${start}"${stop ? ` stop="${stop}"` : ""} channel="${channel}"><title>${title}</title></programme>`;

/** A time as XMLTV writes it in UTC: "20261002130000 +0000". */
const stamp = (time: number) =>
  `${new Date(time).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0000`;

/** A programme on `channel` from one o'clock, UTC, for an hour: still to come at NOON. */
const later = (channel: string, title = "Later") =>
  programme(channel, "20261002130000 +0000", "20261002140000 +0000", title);

const tv = (...elements: string[]) => `<?xml version="1.0"?><tv>${elements.join("")}</tv>`;

describe("an XMLTV document as it arrives", () => {
  const document = tv(later("one.test"));

  it("is unpacked when it is gzip by its first bytes, however they are split, and read as it is otherwise", async () => {
    const packed = gzipSync(document);

    expect(await text(xmltvDocument(pieces(packed, 1), GUIDE_LIMITS.bytes))).toBe(document);
    expect(await text(xmltvDocument(pieces(packed), GUIDE_LIMITS.bytes))).toBe(document);
    // A guide named .xml.gz that the connection already unpacked is XML by now.
    expect(await text(xmltvDocument(pieces(document, 1), GUIDE_LIMITS.bytes))).toBe(document);
    // Packed as several members, as some tools write one.
    const members = Buffer.concat([gzipSync(document.slice(0, 20)), gzipSync(document.slice(20))]);
    expect(await text(xmltvDocument(pieces(members, 7), GUIDE_LIMITS.bytes))).toBe(document);
    expect(await text(xmltvDocument(pieces(""), GUIDE_LIMITS.bytes))).toBe("");
  });

  it("fails a gzip that stops early or is damaged, and never as a guide that just ends", async () => {
    const packed = gzipSync(tv(...Array.from({ length: 400 }, (_, at) => later(`c${at}.test`))));
    const cut = packed.subarray(0, packed.length - 12);
    const damaged = Buffer.concat([
      packed.subarray(0, 40),
      Buffer.alloc(24, 7),
      packed.subarray(64),
    ]);

    expect(await refusal(text(xmltvDocument(pieces(cut, 900), GUIDE_LIMITS.bytes)))).toEqual({
      kind: "incomplete",
    });
    expect(await refusal(text(xmltvDocument(pieces(damaged), GUIDE_LIMITS.bytes)))).toEqual({
      kind: "incomplete",
    });
  });

  it("stops at the size it may unpack to, packed small or not, and hands on nothing past it", async () => {
    const limit = 256 * 1024;
    // A megabyte that packs into about a kilobyte.
    const bomb = gzipSync(Buffer.alloc(1024 * 1024, "a"));
    expect(bomb.length).toBeLessThan(4096);
    let handed = 0;
    const counted = async (document: AsyncIterable<Uint8Array>) => {
      for await (const piece of document) handed += piece.byteLength;
    };

    expect(await refusal(counted(xmltvDocument(pieces(bomb), limit)))).toEqual({
      kind: "too-large",
      limit: "bytes",
    });
    expect(handed).toBeLessThanOrEqual(limit);
    expect(await refusal(text(xmltvDocument(pieces("a".repeat(limit + 1)), limit)))).toEqual({
      kind: "too-large",
      limit: "bytes",
    });
    expect(await text(xmltvDocument(pieces("a".repeat(limit)), limit))).toHaveLength(limit);
  });
});

describe("indexing a guide", () => {
  const index = (
    document: string,
    options?: Parameters<typeof indexProgrammes>[2],
    size = 64 * 1024,
  ) => indexProgrammes(pieces(document, size), NOON, options);

  it.each([
    ["  News\t from\n abroad  ", "News from abroad"],
    ["  News <b>from</b> &amp; <![CDATA[<abroad>]]>  ", "News from & <abroad>"],
  ])("keeps text and the last used attribute when elements are split: %s", async (raw, shown) => {
    const guide = await index(
      tv(
        '<channel ignored="unused" id="wrong" id="one&amp;only"><display-name>One</display-name></channel>',
        `<programme stop='20261002140000 +0000' ignored='unused' channel='wrong' start='20261002130000 +0000' channel='one&amp;only'><title>${raw}</title><desc>${raw}</desc></programme>`,
      ),
      undefined,
      7,
    );
    expect(guide.channels.get("one&only")?.name).toBe("One");
    expect(guide.byChannel.get("one&only")).toEqual([
      { start: NOON + HOUR, stop: NOON + 2 * HOUR, title: shown, description: shown },
    ]);
    expect(guide.byChannel.has("wrong")).toBe(false);
  });

  it("lists every channel the guide names with its name, and by its id where it names none", async () => {
    const guide = await index(
      tv(
        '<channel id="one.test"><display-name lang="en">One &amp; Only</display-name><display-name>1</display-name><icon src="http://x/1.png"/></channel>',
        "<channel id='quiet.test'><display-name><![CDATA[Quiet <TV>]]></display-name></channel>",
        '<channel id="bare.test"/>',
        later("one.test"),
        later("unnamed.test"),
        // Ended: nothing of it is kept, and its channel isn't one the guide has anything for.
        programme("past.test", "20261002090000 +0000", "20261002100000 +0000", "Earlier"),
      ),
      {},
      // In pieces that split every tag.
      5,
    );

    expect([...guide.channels].map(([id, { name }]) => [id, name])).toEqual([
      ["one.test", "One & Only"],
      ["quiet.test", "Quiet <TV>"],
      ["bare.test", "bare.test"],
      ["unnamed.test", "unnamed.test"],
    ]);
    // A channel without programmes to come is still one the guide lists.
    expect([...guide.byChannel.keys()]).toEqual(["one.test", "unnamed.test"]);
    expect(guide.until).toBe(NOON + 2 * HOUR);
  });

  it("takes a name the guide gives after the programmes, as some write their channels last", async () => {
    const guide = await index(
      tv(later("late.test"), '<channel id="late.test"><display-name>Late</display-name></channel>'),
    );

    expect(guide.channels.get("late.test")?.name).toBe("Late");
  });

  it("reads each time by its own offset, UTC without one, across midnight and a change of clocks", async () => {
    const guide = await index(
      tv(
        // The same instant written four ways.
        programme("offset.test", "20261002230000 +0200", "20261003000000 +0200", "Plus two"),
        programme("colon.test", "20261002210000 +00:00", "20261002220000 +00:00", "Colon"),
        programme("none.test", "20261002210000", "20261002220000", "No offset"),
        programme("minus.test", "20261002163000 -0430", "20261002173000 -0430", "Minus"),
        // Past midnight where it is broadcast, still the day before in UTC.
        programme(
          "midnight.test",
          "20261003003000 +0200",
          "20261003013000 +0200",
          "After midnight",
        ),
        // The hour Europe has twice as summer time ends: 02:30 at +0200, then 02:30 at +0100.
        programme("clocks.test", "20261025023000 +0200", "20261025030000 +0200", "Before"),
        programme("clocks.test", "20261025023000 +0100", "20261025030000 +0100", "After"),
        // The last minute without a stop: it runs until the next programme starts.
        programme("open.test", "20261002235900 +0000", null, "Late news"),
        programme("open.test", "20261003000000 +0000", "20261003003000 +0000", "Night"),
      ),
    );
    const of = (channel: string) =>
      guide.byChannel.get(channel)?.map(({ start, stop, title }) => [title, start, stop]);
    const nine = Date.UTC(2026, 9, 2, 21);

    expect(of("offset.test")).toEqual([["Plus two", nine, nine + HOUR]]);
    expect(of("colon.test")).toEqual([["Colon", nine, nine + HOUR]]);
    expect(of("none.test")).toEqual([["No offset", nine, nine + HOUR]]);
    expect(of("minus.test")).toEqual([["Minus", nine, nine + HOUR]]);
    expect(of("midnight.test")).toEqual([
      ["After midnight", Date.UTC(2026, 9, 2, 22, 30), Date.UTC(2026, 9, 2, 23, 30)],
    ]);
    expect(of("clocks.test")).toEqual([
      ["Before", Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1)],
      ["After", Date.UTC(2026, 9, 25, 1, 30), Date.UTC(2026, 9, 25, 2)],
    ]);
    expect(of("open.test")).toEqual([
      ["Late news", Date.UTC(2026, 9, 2, 23, 59), Date.UTC(2026, 9, 3)],
      ["Night", Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 3, 0, 30)],
    ]);
  });

  it("refuses an address's answer that isn't a whole XMLTV guide with something still to come", async () => {
    const strict = (document: string, size?: number) =>
      refusal(index(document, { strict: true }, size));
    const whole = tv(later("one.test"));

    expect(await strict("<!doctype html><html><body>Sign in</body></html>")).toEqual({
      kind: "not-xmltv",
    });
    expect(await strict('{"error":"no such guide"}')).toEqual({ kind: "not-xmltv" });
    // Cut off anywhere: inside a programme, between two, or just before the end.
    expect(await strict(whole.slice(0, -30))).toEqual({ kind: "incomplete" });
    expect(await strict(whole.slice(0, -"</tv>".length))).toEqual({ kind: "incomplete" });
    expect(await strict(whole.slice(0, -2), 3)).toEqual({ kind: "incomplete" });
    expect(await strict(tv())).toEqual({ kind: "empty" });
    expect(await strict(tv('<channel id="one.test"/>'))).toEqual({ kind: "empty" });
    expect(
      await strict(
        tv(programme("one.test", "20261002090000 +0000", "20261002100000 +0000", "Past")),
      ),
    ).toEqual({ kind: "ended" });
    expect(
      (await index(`${whole}\n<!-- generated -->\n`, { strict: true }, 4)).byChannel.size,
    ).toBe(1);
  });

  describe("from an address, as one whole <tv> and nothing that only reads like one", () => {
    const one = later("one.test");
    /** A programme whose description is `text`, as a CDATA section holds it. */
    const described = (text: string) =>
      later("two.test").replace("</programme>", `<desc><![CDATA[${text}]]></desc></programme>`);
    /** How many programmes the document's guide has, or why it is refused. */
    const read = async (document: string, size: number) => {
      const guide = index(document, { strict: true }, size);
      return (await refusal(guide)) ?? (await guide).titles.length;
    };

    it.each<[what: string, document: string, answer: number | { kind: string }]>([
      ["no opening tag", `${one}</tv>`, { kind: "not-xmltv" }],
      ["an opening tag only in a comment", `<!-- <tv> -->${one}</tv>`, { kind: "not-xmltv" }],
      ["another element that starts alike", `<tvirus>${one}</tv>`, { kind: "not-xmltv" }],
      ["a guide inside a page", `<html><tv>${one}</tv></html>`, { kind: "not-xmltv" }],
      ["a programme before it", `${one}<tv>${one}</tv>`, { kind: "not-xmltv" }],
      ["a programme after it", `<tv>${one}</tv>${one}`, { kind: "not-xmltv" }],
      ["a second document after it", `<tv>${one}</tv><tv>${one}</tv>`, { kind: "not-xmltv" }],
      ["a closing tag cut short", `<tv>${one}</tv`, { kind: "incomplete" }],
      ["another element's closing tag", `<tv>${one}</tvirus>`, { kind: "incomplete" }],
      ["a closing tag with more in it", `<tv>${one}</tv x="1">`, { kind: "incomplete" }],
      ["a closing tag only in a comment", `<tv>${one}<!-- </tv> -->`, { kind: "incomplete" }],
      ["a closing tag only in CDATA", `<tv>${one}<![CDATA[</tv>]]>`, { kind: "incomplete" }],
      [
        "cut in a description that reads like the end",
        `<tv>${one}${described("</programme></tv>").slice(0, -"]]></desc></programme>".length)}`,
        { kind: "incomplete" },
      ],
      ["a second <tv> that never closes", `<tv><tv>${one}</tv>`, { kind: "incomplete" }],
      ["an empty element for a document", '<?xml version="1.0"?><tv/>', { kind: "empty" }],
      [
        "comments and descriptions that read like the end, before the end",
        `<tv>${one}<!-- </tv> -->${described("</programme></tv>")}</tv>`,
        2,
      ],
      ["space in the closing tag and a comment after it", `<tv>${one}</tv\n>\n<!-- </tv> -->`, 1],
      [
        "a declaration and a DOCTYPE before it",
        `<?xml version="1.0"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv date="2026">${one}</tv>`,
        1,
      ],
    ])("%s", async (_what, document, answer) => {
      // However the sender splits it: a byte at a time, mid-tag, or all at once.
      for (const size of [1, 7, 64 * 1024]) expect(await read(document, size)).toEqual(answer);
    });
  });

  it("takes an own guide as its provider sends it, cut short or ended, and refuses only one without programmes", async () => {
    const whole = tv(later("one.test"));

    expect((await index(whole.slice(0, -"</tv>".length))).byChannel.size).toBe(1);
    // Without a `<tv>` around its programmes, too.
    expect((await index(`${later("one.test")}</tvirus>`)).byChannel.size).toBe(1);
    const ended = await index(
      tv(programme("one.test", "20261002090000 +0000", "20261002100000 +0000", "Past")),
    );
    expect(ended.byChannel.size).toBe(0);
    expect(ended.until).toBeNull();
    expect(await refusal(index(tv()))).toEqual({ kind: "empty" });
  });

  it("refuses a guide past a limit whole, and reads one that is exactly at it", async () => {
    const limits = { ...GUIDE_LIMITS, elementBytes: 2048, channels: 3, programmes: 4 };
    const under = (document: string, size?: number) => index(document, { limits }, size);
    const over = (document: string, size?: number) => refusal(under(document, size));
    const channels = (count: number) =>
      Array.from({ length: count }, (_, at) => `<channel id="c${at}.test"/>`);
    /** Half-hour programmes from one o'clock on, an hour apart: all still to come. */
    const programmes = (count: number, channel = () => "c0.test") =>
      Array.from({ length: count }, (_, at) => {
        const start = NOON + (at + 1) * HOUR;
        return programme(channel(), stamp(start), stamp(start + HOUR / 2), `Programme ${at}`);
      });

    expect((await under(tv(...channels(3), ...programmes(4)))).channels.size).toBe(3);
    expect(await over(tv(...channels(4), ...programmes(1)))).toEqual({
      kind: "too-large",
      limit: "channels",
    });
    // Channels the guide never names count too: programmes alone list them.
    let named = 0;
    expect(await over(tv(...programmes(4, () => `p${named++}.test`)))).toEqual({
      kind: "too-large",
      limit: "channels",
    });
    expect(await over(tv(...channels(1), ...programmes(5)))).toEqual({
      kind: "too-large",
      limit: "programmes",
    });
    // Programmes that ended aren't kept, so they don't count.
    const past = Array.from({ length: 9 }, (_, at) => {
      const start = NOON - (at + 2) * HOUR;
      return programme("c0.test", stamp(start), stamp(start + HOUR / 2), `Past ${at}`);
    });
    expect((await under(tv(...past, ...programmes(4)))).byChannel.get("c0.test")).toHaveLength(4);

    const long = (bytes: number) => {
      const element = programme("c0.test", "20261002130000 +0000", "20261002140000 +0000", "");
      return element.replace("<title>", `<title>${"t".repeat(bytes - Buffer.byteLength(element))}`);
    };
    expect((await under(tv(long(2048)), 300)).byChannel.size).toBe(1);
    expect(await over(tv(long(2049)), 300)).toEqual({ kind: "too-large", limit: "element" });
    // One that never closes stops where the limit is, long before the document ends.
    expect(await over(`<tv><programme channel="c0.test">${"x".repeat(100_000)}`, 300)).toEqual({
      kind: "too-large",
      limit: "element",
    });
  });
});

describe("mappings over a catalogue's guide ids", () => {
  const channel = (id: string, title: string): LiveChannel => ({
    subscriptionId: "s",
    id,
    name: title,
    title,
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    variants: [{ id, name: title, tags: [], quality: null }],
    catchupDays: null,
  });
  const [one, two, three] = [channel("1", "One"), channel("2", "Two"), channel("3", "Three")];
  // One and Two name the guide channel "a" themselves; Three names none, and is also found by
  // its second stream's id, "30". "8" is a channel the lists hide for now.
  const byId = new Map([
    ["1", one],
    ["2", two],
    ["3", three],
    ["30", three],
  ]);
  const catalogue: CatalogueChannels = {
    all: [one, two, three],
    searchNames: ["one", "two", "three"],
    channel: (id) => byId.get(id),
    listed: (id) => byId.has(id) || id === "8",
    guideIdsOf: (id) => (byId.get(id) === three ? [] : byId.has(id) ? ["a"] : []),
    channelsOf: (guideId) => (guideId === "a" ? [one, two] : []),
  };

  it("gives a mapped channel its guide channel alone, and each guide channel the channels that show it, in the lists' order", () => {
    const mapped = mappedChannels(catalogue, {
      "2": { guideId: "b", name: "Two" },
      // Made under another of its streams' ids: still this channel's.
      "30": { guideId: "a", name: "Three" },
      "9": { guideId: "b", name: "Gone" },
      "8": { guideId: "b", name: "Hidden" },
    });

    expect(["1", "2", "3", "30"].map((id) => mapped.guideIdsOf(id))).toEqual([
      ["a"],
      ["b"],
      ["a"],
      ["a"],
    ]);
    // Two left "a" for "b"; Three joined it, after One as the lists have them.
    expect(mapped.channelsOf("a")).toEqual([one, three]);
    expect(mapped.channelsOf("b")).toEqual([two]);
    expect([...mapped.mapped]).toEqual([
      ["2", "b"],
      ["3", "a"],
    ]);
    // Only the one the provider no longer lists is left over; a hidden one is neither.
    expect([...mapped.unlisted]).toEqual([["9", { guideId: "b", name: "Gone" }]]);
  });

  it("changes nothing without mappings", () => {
    const plain = mappedChannels(catalogue, {});

    expect(plain.channelsOf("a")).toEqual([one, two]);
    expect(plain.guideIdsOf("2")).toEqual(["a"]);
    expect(plain.mapped.size + plain.unlisted.size).toBe(0);
  });
});

describe("a guide's address", () => {
  it("is an http or https address, made whole, that names its origin and tells itself apart", () => {
    const address = guideAddress("  HTTPS://Guide.Example.org/xmltv.gz?key=s3cret#top ");

    expect(address).toEqual({
      href: "https://guide.example.org/xmltv.gz?key=s3cret",
      origin: "https://guide.example.org",
      identity: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    // The same address typed another way is the same guide; another key is another.
    expect(guideAddress("guide.example.org/xmltv.gz?key=s3cret")?.identity).toBe(address?.identity);
    expect(guideAddress("https://guide.example.org/xmltv.gz?key=other")?.identity).not.toBe(
      address?.identity,
    );
    expect(guideAddress("http://guide.example.org:8080/x")?.origin).toBe(
      "http://guide.example.org:8080",
    );
    expect(address?.identity).not.toContain("s3cret");
  });

  it("is nothing else", () => {
    for (const typed of [
      "",
      "   ",
      "ftp://guide.example.org/xmltv.xml",
      "file:///etc/passwd",
      "https://user:pass@guide.example.org/xmltv.xml",
      "https://",
      "not an address",
    ]) {
      expect(guideAddress(typed), typed).toBeNull();
    }
  });
});
