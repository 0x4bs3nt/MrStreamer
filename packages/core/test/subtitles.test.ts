import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captionsInPicture } from "../src/subtitles/captions.ts";
import { subtitleDecoder, type SubtitleCodec } from "../src/subtitles/decoder.ts";
import type { SubtitleChange } from "../src/subtitles/screen.ts";
import { pesReader } from "../src/subtitles/transport.ts";

/**
 * The test channel: DVB subtitles from 0.5 to 3 s, teletext page 888 from 1 to 3 s and captions
 * from 1 to 3 s, counted from its first picture at 1.4 s. See apps/desktop/test/fixtures.
 */
const channel = readFileSync(
  join(import.meta.dirname, "../../../apps/desktop/test/fixtures/h264-subtitles.mpegts"),
);

/** What a decoder shows for one stream of the channel, read in small pieces. */
function decode(
  pid: number,
  codec: SubtitleCodec,
  page: number | null,
  chunkSize = 1000,
): SubtitleChange[] {
  const reader = pesReader();
  const decoder = subtitleDecoder(codec, page);
  const changes: SubtitleChange[] = [];
  const packets = [];
  for (let offset = 0; offset < channel.length; offset += chunkSize) {
    packets.push(...reader.push(channel.subarray(offset, offset + chunkSize)));
  }
  packets.push(...reader.end());
  for (const packet of packets) {
    if (packet.pid !== pid || packet.pts === null) continue;
    const data = codec === "captions" ? captionsInPicture(packet.payload, "h264") : packet.payload;
    const change = decoder.push(data, packet.pts / 90_000);
    if (change) changes.push(change);
  }
  return changes;
}

function text(change: SubtitleChange): readonly string[] | null {
  return change.screen.kind === "text" ? change.screen.lines : null;
}

describe("subtitles the player draws", () => {
  it("reads teletext page 888 and its clear page", () => {
    const changes = decode(0x300, "teletext", 888);

    expect(changes.map((change) => [change.at, text(change)])).toEqual([
      [2.4, ["TELETEKST 888"]],
      [4.4, []],
    ]);
    // Another page shows nothing.
    expect(decode(0x300, "teletext", 801).every((change) => text(change)?.length === 0)).toBe(true);
  });

  it("finds the first subtitle page when none is named", () => {
    expect(text(decode(0x300, "teletext", null)[0]!)).toEqual(["TELETEKST 888"]);
  });

  it("draws DVB subtitles as a white picture with a black edge, until cleared", () => {
    const [shown, cleared] = decode(0x103, "dvb", 1);

    expect(shown?.at).toBeCloseTo(1.9, 2);
    expect(shown?.screen).toMatchObject({ kind: "picture", width: 720, height: 576 });
    const pictures = shown?.screen.kind === "picture" ? shown.screen.pictures : [];
    expect(pictures).toHaveLength(1);
    const picture = pictures[0]!;
    // Low on the screen, as the subtitles were placed.
    expect(picture.y).toBeGreaterThan(400);
    const colours = new Set<string>();
    for (let index = 0; index < picture.rgba.length; index += 4) {
      if (picture.rgba[index + 3] === 0) continue;
      colours.add(
        [...picture.rgba.subarray(index, index + 3)]
          .map((v) => (v > 200 ? "1" : v < 50 ? "0" : "?"))
          .join(""),
      );
    }
    expect([...colours].sort()).toEqual(["000", "111"]);
    // Every line of the letters is there, not only the first of each field.
    let rows = 0;
    for (let row = 0; row < picture.height; row++) {
      const line = picture.rgba.subarray(row * picture.width * 4, (row + 1) * picture.width * 4);
      if (line.some((value, index) => index % 4 === 3 && value > 0)) rows++;
    }
    expect(rows).toBeGreaterThanOrEqual(picture.height - 2);
    expect(cleared?.screen).toMatchObject({ kind: "picture", pictures: [] });
  });

  it.each([1, 7, 1000, 65_536])(
    "reads closed captions from the picture, pop-on, until erased, in %i-byte chunks",
    (chunkSize) => {
      const changes = decode(0x100, "captions", 1, chunkSize);

      expect(changes.map((change) => text(change))).toEqual([["HELLO CAPTIONS"], []]);
      // Shown with the first of the two frames that end the caption, as ffmpeg's decoder shows
      // it; erased three seconds in.
      expect(changes[0]!.at).toBeCloseTo(1.4 + 0.92, 2);
      expect(changes[1]!.at).toBeCloseTo(1.4 + 3, 2);
      // Channel 3 carries nothing.
      expect(decode(0x100, "captions", 3, chunkSize)).toEqual([]);
    },
  );
});

/** One registered ATSC caption message, including the SEI NAL header and trailing bits. */
function sei(header: readonly number[], pairs: readonly number[]): number[] {
  const payload = [
    0xb5,
    0,
    0x31,
    0x47,
    0x41,
    0x39,
    0x34,
    3,
    0x40 | (pairs.length / 3),
    0xff,
    ...pairs,
  ];
  return [...header, 4, payload.length, ...payload, 0x80];
}

describe("captions in Annex B pictures", () => {
  it("keeps H.264 captions after slices and across access units in their original order", () => {
    // prettier-ignore
    const picture = Uint8Array.from([
      0, 0, 1, 9, 0xf0,
      0, 0, 0, 1, ...sei([6], [0xfc, 0x94, 0x20]),
      0, 0, 1, 0x65, 0x88,
      0, 0, 1, ...sei([6], [0xfd, 0x9c, 0x20]),
      0, 0, 0, 1, 9, 0xf0,
      0, 0, 1, 0x41, 0x88,
      0, 0, 0, 1, ...sei([6], [0xfc, 0xc8, 0x49]),
      0, 0,
    ]);
    expect(captionsInPicture(picture, "h264")).toEqual(
      Uint8Array.from([0, 0x94, 0x20, 1, 0x9c, 0x20, 0, 0xc8, 0x49]),
    );
  });

  it("keeps HEVC prefix and suffix captions on both sides of slices and access units", () => {
    // prettier-ignore
    const picture = Uint8Array.from([
      0, 0, 1, ...sei([78, 1], [0xfc, 0x94, 0x20]),
      0, 0, 0, 1, 2, 1, 0x88,
      0, 0, 1, ...sei([80, 1], [0xfd, 0x9c, 0x20]),
      0, 0, 1, 70, 1, 0x10,
      0, 0, 0, 1, 2, 1, 0x88,
      0, 0, 0, 1, ...sei([80, 1], [0xfc, 0xc8, 0x49]),
    ]);
    expect(captionsInPicture(picture, "hevc")).toEqual(
      Uint8Array.from([0, 0x94, 0x20, 1, 0x9c, 0x20, 0, 0xc8, 0x49]),
    );
  });

  it.each(["h264", "hevc"] as const)(
    "reads %s captions with emulation bytes, zero padding and truncated boundaries without writing input",
    (codec) => {
      const header = codec === "h264" ? [6] : [78, 1];
      const message = sei(header, [0xfc, 0x94, 0x20]);
      for (let padding = 0; padding < 6; padding++) {
        for (const tail of [[], [0], [0, 0], [0, 0, 1], [0, 0, 0, 1]]) {
          // prettier-ignore
          const input = Uint8Array.from([
            ...Array<number>(padding).fill(0x55),
            0, 0, 1, ...header,
            // An unrelated SEI message contains an escaped start-code pattern.
            5, 3, 0, 0, 3, 1,
            ...message.slice(header.length),
            0, 0, 0, 0, ...tail,
          ]);
          const original = input.slice();
          const pairs = captionsInPicture(input, codec);
          expect(pairs).toEqual(Uint8Array.from([0, 0x94, 0x20]));
          pairs.fill(0);
          expect(input).toEqual(original);
        }
      }
      for (const input of [[], [0], [0, 0], [0, 0, 1], [0, 0, 1, ...header, 4, 15, 0xb5]]) {
        expect(captionsInPicture(Uint8Array.from(input), codec)).toEqual(new Uint8Array());
      }
    },
  );
});
