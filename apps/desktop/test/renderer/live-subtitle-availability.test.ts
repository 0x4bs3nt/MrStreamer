// @vitest-environment happy-dom
/// <reference types="node" />
import { ipc, SUBSCRIPTION } from "./support.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ChannelTracks, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { pesReader } from "@mrstreamer/core/subtitles/transport";
import { player, usePlayer } from "../../src/renderer/src/player/player.ts";
import { TrackMenus, type TrackMenu } from "../../src/renderer/src/features/watch/TrackMenus.tsx";
import { subtitleLayer } from "../../src/renderer/src/player/subtitles.ts";
import { Flash, LiveSubtitleHint } from "../../src/renderer/src/features/watch/Flash.tsx";
import type { Engine } from "../../src/renderer/src/player/engine.ts";

const engines = vi.hoisted(() => ({
  opened: [] as {
    packet: (pid: number, data: Uint8Array, at: number) => void;
    elapsed: number;
    destroyed: boolean;
  }[],
}));
vi.mock("../../src/renderer/src/player/engine.ts", async (original) => {
  const real = await original<typeof import("../../src/renderer/src/player/engine.ts")>();
  return {
    ...real,
    createEngine: (): Engine => {
      const stream = {
        packet: (_pid: number, _data: Uint8Array, _at: number) => {},
        elapsed: 0,
        destroyed: false,
      };
      engines.opened.push(stream);
      return {
        name: "mpegts.js",
        started: Promise.resolve(),
        onFailure() {},
        onEnded() {},
        onWaiting() {},
        played: () => stream.elapsed,
        onPrivateData(listener) {
          stream.packet = listener;
        },
        tracks: null,
        info: () => ({
          width: null,
          height: null,
          fps: null,
          videoCodec: null,
          audioCodec: null,
          audioChannels: null,
        }),
        destroy() {
          stream.destroyed = true;
        },
      };
    },
  };
});
const channel = (id: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: id,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id, name: id, tags: [], quality: null }],
});
const tracks: ChannelTracks = {
  audio: [{ id: 201, language: "en", label: "English", default: true }],
  playing: 201,
  subtitles: [
    {
      id: 0x300,
      page: 888,
      format: "teletext",
      language: "nl",
      label: "Nederlands",
      default: false,
      forced: false,
    },
  ],
};
/** A caption channel, as the main process lists one it found in the pictures. */
const captions: SubtitleTrack = {
  id: 0x1ff0,
  page: 1,
  format: "captions",
  language: null,
  label: "Captions",
  default: false,
  forced: false,
};
const fixture = readFileSync(join(import.meta.dirname, "../fixtures/h264-subtitles.mpegts"));
const reader = pesReader();
const packets = [...reader.push(fixture), ...reader.end()].filter((packet) => packet.pid === 0x300);
const working = packets[0]!.payload;
// The fixture's declared page 888 header becomes the broadcaster's time-filling page 8FF.
const filler = working.slice();
filler[7] = 0x57;
filler[8] = 0x57;
/** Lets the player's answers and the next timer through, on the fake clock when a test has one. */
const settle = async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setTimeout(resolve));
};
let unmount = () => {};
async function open(id = "one", listed = tracks) {
  ipc.always("playback.tracks", listed);
  ipc.always("playback.open", {
    sessionId: id,
    channel: { subscriptionId: SUBSCRIPTION, id },
    format: "mpegts",
    url: "http://127.0.0.1/fixture",
  });
  player.play(channel(id));
  await settle();
  return engines.opened.at(-1)!;
}
function Controls() {
  const listed = usePlayer((state) => state.tracks);
  const subtitle = usePlayer((state) => state.subtitle);
  const [menu, setMenu] = useState<TrackMenu>(null);
  return createElement(
    "div",
    null,
    createElement(TrackMenus, {
      audio: listed?.audio ?? [],
      audioId: null,
      subtitles: listed?.subtitles ?? [],
      subtitle,
      open: menu,
      onOpenChange: setMenu,
      onAudio: player.setAudio,
      onSubtitle: player.setSubtitle,
    }),
    createElement(LiveSubtitleHint),
    createElement(Flash),
  );
}
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () => {
    root.render(createElement(Controls));
    await settle();
  });
  return container;
}
beforeEach(() => {
  player.reset();
  ipc.reset();
});
afterEach(() => {
  unmount();
  unmount = () => {};
  player.reset();
  vi.useRealTimers();
});
it("hides declared page 888 and makes C inert through repeated 8FF filler", async () => {
  const stream = await open();
  const controls = await mount();
  await act(async () => {
    for (let i = 0; i < 100; i++) stream.packet(0x300, filler, i);
    await settle();
  });
  expect(controls.querySelector('[aria-label="Subtitles"]')).toBeNull();
  player.toggleSubtitles();
  expect(player.state().subtitle).toBeNull();
  expect(ipc.argsOf("preferences.update")).toEqual([]);
});
it("shows later page data once, keeps every proven track through silence, and resets on a channel change", async () => {
  const stream = await open();
  const controls = await mount();
  stream.elapsed = 11_000;
  await act(async () => {
    stream.packet(0x300, working, 11);
    await settle();
  });
  expect(controls.querySelector('[aria-label="Subtitles"]')).not.toBeNull();
  expect(controls.textContent).toContain("Subtitles available · C");
  player.toggleSubtitles();
  expect(player.state().subtitle?.page).toBe(888);
  player.toggleSubtitles();
  expect(player.state().subtitle).toBeNull();
  await act(async () => {
    for (let i = 0; i < 100; i++) stream.packet(0x300, filler, 30 + i);
    await settle();
  });
  expect(player.state().tracks?.subtitles).toHaveLength(1);
  const next = await open("two");
  await act(async () => {
    stream.packet(0x300, working, 1);
    next.packet(0x300, filler, 1);
    await settle();
  });
  expect(player.state().tracks?.subtitles).toEqual([]);
  player.toggleSubtitles();
  expect(player.state().subtitle).toBeNull();
  expect(ipc.argsOf("playback.open")).toHaveLength(2);
});
it.each(["nl", "off"])(
  "applies remembered %s on first proof without flashing during normal tuning",
  async (subtitleLanguage) => {
    ipc.prefer({ subtitleLanguage });
    const stream = await open();
    const controls = await mount();
    expect(player.state().subtitle).toBeNull();
    await act(async () => {
      stream.packet(0x300, working, 1);
      await settle();
    });
    expect(player.state().subtitle?.language ?? null).toBe(subtitleLanguage === "nl" ? "nl" : null);
    expect(controls.textContent).not.toContain("Subtitles available");
    expect(ipc.argsOf("preferences.update")).toEqual([]);
  },
);
it("auto-enables the wanted language even on late proof, without suggesting C", async () => {
  ipc.prefer({ subtitleLanguage: "nl" });
  const stream = await open();
  const controls = await mount();
  stream.elapsed = 15_000;
  await act(async () => {
    stream.packet(0x300, working, 15);
    await settle();
  });
  expect(player.state().subtitle?.language).toBe("nl");
  expect(controls.textContent).not.toContain("Subtitles available");
});
it("waits for meaningful DVB page data and keeps independent proven pages selectable", async () => {
  const reader = pesReader();
  const dvb = [...reader.push(fixture), ...reader.end()].find(
    (packet) => packet.pid === 0x103,
  )!.payload;
  const listed = {
    ...tracks,
    subtitles: [
      ...tracks.subtitles,
      { ...tracks.subtitles[0]!, id: 0x103, page: 1, format: "picture" as const, label: "DVB" },
    ],
  };
  const stream = await open("dvb", listed);
  stream.packet(0x103, new Uint8Array([0x20, 0, 0x0f, 0x80, 0, 1, 0, 0]), 1);
  await settle();
  expect(player.state().tracks?.subtitles).toEqual([]);
  stream.packet(0x103, dvb, 2);
  await settle();
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual(["DVB"]);
  stream.packet(0x300, working, 3);
  await settle();
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual([
    "Nederlands",
    "DVB",
  ]);
  player.setSubtitle(listed.subtitles[1]!);
  expect(player.state().subtitle?.label).toBe("DVB");
  player.setSubtitle(listed.subtitles[0]!);
  expect(player.state().subtitle?.label).toBe("Nederlands");
});
it("accepts already-observed captions and ignores private data after Stop", async () => {
  const stream = await open("captions", {
    ...tracks,
    subtitles: [{ ...tracks.subtitles[0]!, format: "captions", page: 1 }],
  });
  expect(player.state().tracks?.subtitles).toHaveLength(1);
  player.stop();
  stream.packet(0x300, working, 1);
  await settle();
  expect(player.state().phase.kind).toBe("idle");
});
it("lists captions that begin long after the stream started, on the same stream and off until chosen", async () => {
  const stream = await open("late", { ...tracks, subtitles: [] });
  const controls = await mount();
  stream.elapsed = 20_000;
  expect(controls.querySelector('[aria-label="Subtitles"]')).toBeNull();
  ipc.always("playback.tracks", { ...tracks, subtitles: [captions] });
  await act(async () => {
    ipc.emit("playback.tracksChanged", { sessionId: "late" });
    await settle();
  });
  expect(controls.querySelector('[aria-label="Subtitles"]')).not.toBeNull();
  expect(player.state().subtitle).toBeNull();
  player.setSubtitle(captions);
  // A second caption channel joins the list without taking the choice.
  ipc.always("playback.tracks", { ...tracks, subtitles: [captions, { ...captions, page: 3 }] });
  await act(async () => {
    ipc.emit("playback.tracksChanged", { sessionId: "late" });
    await settle();
  });
  expect(player.state().tracks?.subtitles.map((track) => track.page)).toEqual([1, 3]);
  expect(player.state().subtitle).toEqual(captions);
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(stream.destroyed).toBe(false);
});
it("keeps subtitles off through later captions for a viewer who turned them off", async () => {
  ipc.prefer({ subtitleLanguage: "nl" });
  const stream = await open();
  stream.packet(0x300, working, 1);
  await settle();
  expect(player.state().subtitle?.language).toBe("nl");
  player.setSubtitle(null);
  ipc.always("playback.tracks", { ...tracks, subtitles: [...tracks.subtitles, captions] });
  ipc.emit("playback.tracksChanged", { sessionId: "one" });
  await settle();
  expect(player.state().tracks?.subtitles.map((track) => track.label)).toEqual([
    "Nederlands",
    "Captions",
  ]);
  expect(player.state().subtitle).toBeNull();
});
it("ignores a track change of a stream that closed, and after Stop", async () => {
  await open("first", { ...tracks, subtitles: [] });
  await open("second", { ...tracks, subtitles: [] });
  const reads = ipc.argsOf("playback.tracks").length;
  ipc.always("playback.tracks", { ...tracks, subtitles: [captions] });
  ipc.emit("playback.tracksChanged", { sessionId: "first" });
  await settle();
  expect(ipc.argsOf("playback.tracks")).toHaveLength(reads);
  expect(player.state().tracks?.subtitles).toEqual([]);
  player.stop();
  ipc.emit("playback.tracksChanged", { sessionId: "second" });
  await settle();
  expect(ipc.argsOf("playback.tracks")).toHaveLength(reads);
});
it("keeps captions found while the first track list was still on its way", async () => {
  const atStart = ipc.hold("playback.tracks");
  await open("race");
  const controls = await mount();
  const afterChange = ipc.hold("playback.tracks");
  ipc.emit("playback.tracksChanged", { sessionId: "race" });
  // The newer list arrives first; the one read at the start has no captions yet.
  await act(async () => {
    afterChange.resolve({ ...tracks, subtitles: [captions] });
    await settle();
    atStart.resolve({ ...tracks, subtitles: [] });
    await settle();
  });
  expect(ipc.argsOf("playback.tracks")).toHaveLength(2);
  expect(controls.querySelector('[aria-label="Subtitles"]')).not.toBeNull();
});
it("rejects a late preference answer and packet from a cancelled channel", async () => {
  const first = await open("first");
  const preference = ipc.hold("preferences.get");
  first.packet(0x300, working, 1);
  await open("second");
  preference.resolve({ volume: 1, muted: false, subtitleLanguage: "nl" });
  first.packet(0x300, working, 2);
  await settle();
  expect(player.state().channel?.id).toBe("second");
  expect(player.state().tracks?.subtitles).toEqual([]);
  expect(player.state().subtitle).toBeNull();
});

it("draws the proving packet when the wanted language comes on", async () => {
  ipc.prefer({ subtitleLanguage: "nl" });
  const stream = await open();
  player.element.currentTime = 11;
  stream.packet(0x300, working, 10);
  await settle();
  expect(player.state().subtitle?.page).toBe(888);
  expect(subtitleLayer.textContent).toContain("TELETEKST 888");
});
it("retains proof through a same-channel reconnect, without accepting another declared page", async () => {
  const stream = await open();
  stream.packet(0x300, working, 1);
  await settle();
  await open("one", {
    ...tracks,
    subtitles: [...tracks.subtitles, { ...tracks.subtitles[0]!, page: 889, label: "Other page" }],
  });
  expect(player.state().tracks?.subtitles.map((track) => track.page)).toEqual([888]);
});
it("observes subtitle data that precedes the program-table answer", async () => {
  const listed = ipc.hold("playback.tracks");
  const stream = await open();
  stream.packet(0x300, working, 1);
  listed.resolve(tracks);
  await settle();
  expect(player.state().tracks?.subtitles.map((track) => track.page)).toEqual([888]);
});

it("does not retain a preview hint for another channel or a later Flash view", async () => {
  const stream = await open("preview");
  stream.elapsed = 15_000;
  stream.packet(0x300, working, 15);
  await settle();
  // Opening Watch on the already proven preview is silent too.
  const controls = await mount();
  expect(controls.textContent).not.toContain("Subtitles available");
  await act(async () => {
    await open("without", { ...tracks, subtitles: [] });
  });
  expect(controls.textContent).not.toContain("Subtitles available");
});
it("removes the current hint on a channel switch", async () => {
  const stream = await open();
  const controls = await mount();
  stream.elapsed = 11_000;
  await act(async () => {
    stream.packet(0x300, working, 11);
    await settle();
  });
  expect(controls.textContent).toContain("Subtitles available · C");
  await act(async () => {
    await open("other", { ...tracks, subtitles: [] });
  });
  expect(controls.textContent).not.toContain("Subtitles available");
});
it("keeps receiver declarations available without observing or requesting subtitle data", async () => {
  const media = {
    generation: 1,
    sessionId: "receiver",
    item: { kind: "channel" as const, channel: { subscriptionId: SUBSCRIPTION, id: "tv" } },
    state: "playing" as const,
    position: 0,
    at: Date.now(),
    duration: null,
    subtitles: false,
  };
  ipc.always("playback.tracks", tracks);
  const tv = { id: "tv", kind: "cast" as const, name: "TV" };
  ipc.emit("output.changed", {
    offers: ["cast"],
    airplayRoutes: null,
    scanning: false,
    receivers: [tv],
    output: {
      kind: "receiver",
      receiver: tv,
      volume: { level: 0.5, muted: false },
      media,
      failure: null,
    },
  });
  player.adopt(channel("tv"), media);
  await settle();
  expect(player.onReceiver()).toBe(true);
  expect(player.state().tracks?.subtitles).toEqual(tracks.subtitles);
  expect(player.state().subtitleAvailability).toBeNull();
  expect(ipc.argsOf("playback.open")).toEqual([]);
  ipc.emit("output.changed", {
    offers: ["cast"],
    airplayRoutes: null,
    scanning: false,
    receivers: [],
    output: { kind: "local" },
  });
});

it("counts played time across reconnects before announcing first proof", async () => {
  const first = await open();
  const controls = await mount();
  first.elapsed = 9000;
  const second = await open();
  second.elapsed = 2000;
  await act(async () => {
    second.packet(0x300, working, 2);
    await settle();
  });
  expect(controls.textContent).toContain("Subtitles available · C");
});
it("does not count another channel's playing time toward the late hint", async () => {
  const first = await open("first");
  const controls = await mount();
  first.elapsed = 60_000;
  const second = await open("second");
  second.elapsed = 1000;
  await act(async () => {
    second.packet(0x300, working, 1);
    await settle();
  });
  expect(controls.textContent).not.toContain("Subtitles available");
});
it("C chooses a current track when the previous stream's PID is absent", async () => {
  const caption = { ...tracks.subtitles[0]!, format: "captions" as const, page: 1 };
  await open("captions", { ...tracks, subtitles: [caption] });
  player.setSubtitle(caption);
  player.setSubtitle(null);
  const replacement = { ...caption, id: caption.id + 1 };
  await open("captions", { ...tracks, subtitles: [replacement] });
  player.toggleSubtitles();
  expect(player.state().subtitle?.id).toBe(replacement.id);
});

it("announces availability only once even when page data keeps arriving", async () => {
  vi.useFakeTimers();
  const stream = await open();
  const controls = await mount();
  stream.elapsed = 11_000;
  await act(async () => {
    stream.packet(0x300, working, 11);
    await settle();
  });
  expect(controls.textContent).toContain("Subtitles available · C");
  await act(() => vi.advanceTimersByTimeAsync(1600));
  expect(controls.textContent).not.toContain("Subtitles available");
  await act(async () => {
    stream.packet(0x300, working, 13);
    await settle();
  });
  expect(controls.textContent).not.toContain("Subtitles available");
});
