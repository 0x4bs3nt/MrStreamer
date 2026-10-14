// @vitest-environment happy-dom
// When Automatic plays another of a channel's streams because the first didn't start, Watch says
// so until the channel changes.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LivePlaying } from "@mrstreamer/contracts/playback";
import { player } from "../../src/renderer/src/player/player.ts";

const channel = (id: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: `NL | ${id} FHD`,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [
    { id, name: `NL | ${id} FHD`, tags: ["FHD"], quality: "fhd" },
    { id: `${id}-hd`, name: `NL | ${id} HD`, tags: ["HD"], quality: "hd" },
  ],
});

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
});

afterEach(() => {
  player.reset();
  vi.useRealTimers();
});

/** Plays `id` until its picture moves and the main process says which stream plays. */
async function playing(id: string, stream: LivePlaying): Promise<void> {
  const opened = ipc.hold("playback.open");
  const asked = ipc.hold("playback.playing");
  player.play(channel(id));
  await vi.waitFor(() =>
    expect(ipc.argsOf("playback.open").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id },
    }),
  );
  opened.resolve({
    sessionId: id,
    channel: { subscriptionId: SUBSCRIPTION, id: id },
    url: `http://127.0.0.1/stream/${id}`,
    format: "hls",
  });
  await vi.waitFor(() => expect(player.element.src).toBe(`http://127.0.0.1/stream/${id}`));
  player.element.currentTime += 1;
  await vi.advanceTimersByTimeAsync(1000);
  expect(ipc.argsOf("playback.playing").at(-1)).toEqual({ sessionId: id });
  asked.resolve(stream);
  await vi.waitFor(() => expect(player.state().stream).toEqual(stream));
}

describe("live quality", () => {
  it("keeps the note of Automatic's fallback until the channel changes", async () => {
    await playing("a", {
      variantId: "a-hd",
      failed: [{ variantId: "a", failure: { kind: "unavailable", status: 404 } }],
    });
    expect(player.state().fellBack).toEqual({ from: "a", to: "a-hd" });

    // Reconnecting tries the stream that failed last, so nothing fails the second time.
    await playing("a", { variantId: "a-hd", failed: [] });
    expect(player.state().fellBack).toEqual({ from: "a", to: "a-hd" });

    await playing("b", { variantId: "b", failed: [] });
    expect(player.state()).toMatchObject({ fellBack: null, stream: { variantId: "b" } });
  });
});
