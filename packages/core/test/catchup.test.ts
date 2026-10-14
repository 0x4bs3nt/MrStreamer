// Which of a channel's streams play a stretch of its past from the provider's catch-up archive,
// and the errors the UI explains when none can.
import { describe, expect, it } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { ChannelVariant, LiveChannel } from "@mrstreamer/contracts/library";
import { archiveVariants, DAY_MS } from "../src/catchup.ts";

const NOW = Date.UTC(2026, 9, 13, 20, 0);
const HOUR = 60 * 60 * 1000;

const variant = (id: string, catchupDays?: number): ChannelVariant => ({
  id,
  name: id,
  tags: [],
  quality: null,
  ...(catchupDays ? { catchupDays } : {}),
});

const channel = (...variants: ChannelVariant[]): Pick<LiveChannel, "variants" | "catchupDays"> => ({
  variants,
  catchupDays: Math.max(0, ...variants.map((each) => each.catchupDays ?? 0)) || null,
});

/** What `archiveVariants` fails with, or the ids of the streams it gives. */
function outcome(
  of: Pick<LiveChannel, "variants" | "catchupDays">,
  start: number,
  end = start + HOUR,
) {
  try {
    return archiveVariants(of, { start, end }, NOW).map(({ id }) => id);
  } catch (cause) {
    if (cause instanceof AppFailure) return cause.error;
    throw cause;
  }
}

describe("catch-up of a channel's past", () => {
  it("plays from the streams whose archive reaches back to the start, in the channel's order", () => {
    const vrt = channel(variant("fhd", 7), variant("hd"), variant("sd", 2));
    expect(outcome(vrt, NOW - 2 * HOUR)).toEqual(["fhd", "sd"]);
    // Three days back only the stream that keeps a week has it.
    expect(outcome(vrt, NOW - 3 * DAY_MS)).toEqual(["fhd"]);
    // A programme still on plays from its start too.
    expect(outcome(vrt, NOW - HOUR, NOW + HOUR)).toEqual(["fhd", "sd"]);
  });

  it("says a channel has no catch-up", () => {
    expect(outcome(channel(variant("one"), variant("two")), NOW - HOUR)).toEqual({
      kind: "catch-up",
      reason: "none",
    });
  });

  it("says how far back a channel's catch-up goes for a programme before it or still to come", () => {
    const een = channel(variant("een", 2));
    const outside = { kind: "catch-up", reason: "outside", days: 2 };
    expect(outcome(een, NOW - 2 * DAY_MS - HOUR)).toEqual(outside);
    expect(outcome(een, NOW + HOUR)).toEqual(outside);
    expect(outcome(een, NOW - 2 * DAY_MS)).toEqual(["een"]);
  });

  it("refuses a window that ends before it starts", () => {
    expect(outcome(channel(variant("een", 2)), NOW - HOUR, NOW - 2 * HOUR)).toMatchObject({
      kind: "invalid-input",
    });
  });
});
