import type { Viewing } from "@mrstreamer/contracts/viewing";
import { Failed } from "@mrstreamer/core/failure";
import { memoryViewingStore, type ViewingSnapshot } from "@mrstreamer/core/viewing/memory-store";
import {
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingRecord,
  ViewingSeries,
  ViewingStore,
  type SeriesSeasons,
} from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

// The record service over the in-memory store, as iOS runs it: one subscription, its snapshot
// kept by whoever saves it. Each `app` is one launch over the snapshot the last one saved.

const SUB = "xtream-a";
const seasons: SeriesSeasons = [
  {
    number: 1,
    episodes: [1, 2, 3].map((number) => ({ id: `e${number}`, season: 1, number })),
  },
];

function app(snapshot: ViewingSnapshot | null, save: (next: ViewingSnapshot) => void) {
  const layer = ViewingRecord.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ViewingStore, memoryViewingStore({ snapshot, save })),
        Layer.succeed(ViewingAccount, {
          owners: Effect.succeed([{ subscriptionId: SUB, key: SUB, original: false }]),
        }),
        Layer.succeed(ViewingChannels, { lookup: () => Effect.succeed(() => undefined) }),
        Layer.succeed(ViewingSeries, {
          identity: (series) =>
            Effect.succeed({
              key: `id:${series.id}`,
              keys: [`id:${series.id}`],
              versions: [series.id],
            }),
          seasons: () => Effect.succeed(seasons),
        }),
        Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
      ),
    ),
  );
  const run = <A>(use: (record: ViewingRecord["Service"]) => Effect.Effect<A, Failed>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* ViewingRecord);
      }).pipe(Effect.provide(layer)),
    );
  return { run };
}

const episode = (number: number) => ({
  kind: "episode" as const,
  subscriptionId: SUB,
  id: `e${number}`,
  seriesId: "s1",
  season: 1,
  episode: number,
});
const series = { subscriptionId: SUB, id: "s1" };

describe("the viewing record over the in-memory store", () => {
  it("keeps progress, marks and Continue watching across launches", async () => {
    let saved: ViewingSnapshot | null = null;
    const first = app(null, (next) => (saved = next));
    await first.run((record) =>
      record.recordProgress("p1", { kind: "movie", subscriptionId: SUB, id: "m1" }, 600, 5400, 1),
    );
    await first.run((record) => record.recordProgress("p2", episode(1), 2500, 2600, 2));
    const mark = await first.run((record) => record.markEpisode("m1", episode(2), true));
    expect(mark).toMatchObject({ season: 1, episode: 2, watched: true });

    const relaunched = app(saved, (next) => (saved = next));
    const viewing: Viewing = await relaunched.run((record) => record.state);
    expect(viewing.continueWatching.map(({ title }) => title.id)).toEqual(["e1", "m1"]);
    expect(viewing.marked[0]?.next).toMatchObject({ season: 1, episode: 3 });
    const standing = await relaunched.run((record) => record.episodes(series));
    expect(standing.marks.map(({ episode }) => episode)).toEqual([2]);
    expect(standing.undoable).toBe(mark?.revision);

    await relaunched.run((record) => record.undoMark("u1", series, mark?.revision ?? 0));
    const undone = await app(saved, () => {}).run((record) => record.episodes(series));
    expect(undone.marks).toEqual([]);
  });

  it("changes nothing for a command sent again, or one whose save fails", async () => {
    let saved: ViewingSnapshot | null = null;
    let failing = false;
    const running = app(null, (next) => {
      if (failing) throw new Error("disk full");
      saved = next;
    });
    const movie = { kind: "movie" as const, subscriptionId: SUB, id: "m1" };
    await running.run((record) => record.recordProgress("p1", movie, 600, 5400, 1));
    await running.run((record) => record.recordProgress("p1", movie, 900, 5400, 1));
    failing = true;
    await expect(
      running.run((record) => record.recordProgress("p2", movie, 1200, 5400, 1)),
    ).rejects.toBeDefined();
    failing = false;
    const viewing = await running.run((record) => record.state);
    expect(viewing.continueWatching.map(({ position }) => position)).toEqual([600]);
    expect(saved).not.toBeNull();
  });

  it("erases an account with everything it recorded", async () => {
    const kept: { snapshot: ViewingSnapshot | null } = { snapshot: null };
    const running = app(null, (next) => (kept.snapshot = next));
    await running.run((record) => record.markEpisode("m1", episode(1), true));
    await running.run((record) => record.erase(SUB));
    expect(kept.snapshot?.accounts).toEqual({});
  });
});
