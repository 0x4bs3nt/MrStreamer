import { describe, expect, it } from "vitest";
import { Failed } from "@mrstreamer/core/failure";
import type { AppError } from "@mrstreamer/contracts/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { observeOpen } from "../src/main/analytics/playback.ts";
import type { OperationObserver } from "../src/main/analytics/operations.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import { holdableFetch, runtimeFor, tempDir, testSecrets } from "./support.ts";

function observations() {
  const notes: ("started" | Parameters<ReturnType<OperationObserver>>)[] = [];
  const observe: OperationObserver = () => {
    notes.push("started");
    return (...outcome) => notes.push(outcome);
  };
  return { observe, notes };
}

describe("observed playback requests", () => {
  it("preserves overlapping public channel results and counts the superseded open as interrupted", async () => {
    const host = await startFakePlaylist();
    try {
      const holdable = holdableFetch();
      const dataDir = await tempDir();
      const layer = Playback.layer({ userAgent: "analytics-contract", ffmpeg: null }).pipe(
        Layer.provideMerge(PlaybackCoordination.layer),
        Layer.provideMerge(
          Subscriptions.layer({
            dataDir,
            secrets: testSecrets,
            providerOptions: { userAgent: "analytics-contract", fetch: holdable.fetch },
          }),
        ),
      );
      const initial = runtimeFor(layer);
      const subscriptions = await initial.runPromise(Subscriptions);
      const { id: subscriptionId } = await initial.runPromise(
        subscriptions.add({ server: host.link, username: "", password: "" }),
      );
      await initial.dispose();
      // The restarted subscription resolves its playlist during the first public open.
      const runtime = runtimeFor(layer);
      const coordination = await runtime.runPromise(PlaybackCoordination);
      const playback = await runtime.runPromise(Playback);
      const channel = { subscriptionId, id: PLAYLIST_CHANNELS.plain.id };
      const { observe, notes } = observations();
      const open = () =>
        observeOpen(coordination, observe, (turn) =>
          playback.open(channel, ["h264", "aac", "mp3", "opus"], { turn }),
        );
      const held = holdable.holdNext();
      const first = runtime.runPromiseExit(open());
      await held.arrived;
      const second = runtime.runPromise(open());
      held.release();
      const previous = await first;
      expect(Exit.isFailure(previous)).toBe(true);
      if (Exit.isFailure(previous))
        expect(Cause.findErrorOption(previous.cause)).toMatchObject({
          value: {
            error: { kind: "unexpected", detail: "Something else played in the meantime." },
          },
        });
      expect((await second).channel).toEqual(channel);
      expect(notes).toEqual(["started", "started", ["interrupted"], ["success"]]);
    } finally {
      await host.close();
    }
  });

  it("excludes a refused preview before beginning a turn, leaving an in-flight receiver request valid", async () => {
    const runtime = runtimeFor(PlaybackCoordination.layer);
    const coordination = await runtime.runPromise(PlaybackCoordination);
    const { observe, notes } = observations();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const receiver = runtime.runPromiseExit(
      observeOpen(coordination, observe, (turn) =>
        Effect.gen(function* () {
          entered.resolve();
          yield* Effect.promise(() => held.promise);
          return yield* coordination.inTurn(turn, Effect.succeed("receiver prepared"));
        }),
      ),
    );
    await entered.promise;
    const refusal = new Failed({
      error: { kind: "unexpected", detail: "A receiver has playback." },
    });
    const preview = await runtime.runPromiseExit(
      observeOpen(
        coordination,
        observe,
        () => Effect.die("Refused preview reached its body"),
        Effect.fail(refusal),
      ),
    );
    if (!Exit.isFailure(preview)) throw new Error("Preview was not refused.");
    const refused = Cause.findErrorOption(preview.cause);
    if (refused._tag !== "Some") throw new Error("No public preview error.");
    expect(refused.value).toBe(refusal);
    expect(notes).toEqual(["started"]);
    held.resolve();
    const prepared = await receiver;
    if (!Exit.isSuccess(prepared)) throw new Error("Preview superseded the receiver request.");
    expect(prepared.value).toBe("receiver prepared");
    expect(notes).toEqual(["started", ["success"]]);
  });

  it("keeps stop and cancellation separate from fixed failure categories and preserves public returns", async () => {
    const runtime = runtimeFor(PlaybackCoordination.layer);
    const coordination = await runtime.runPromise(PlaybackCoordination);
    const { observe, notes } = observations();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const opening = runtime.runPromiseExit(
      observeOpen(coordination, observe, (turn) =>
        Effect.gen(function* () {
          entered.resolve();
          yield* Effect.promise(() => held.promise);
          return yield* coordination.inTurn(turn, Effect.succeed("obsolete"));
        }),
      ),
    );
    await entered.promise;
    await runtime.runPromise(coordination.begin);
    held.resolve();
    expect(Exit.isFailure(await opening)).toBe(true);
    const waiting = Promise.withResolvers<void>();
    const cancelled = runtime.runFork(
      observeOpen(coordination, observe, () =>
        Effect.andThen(
          Effect.sync(() => waiting.resolve()),
          Effect.never,
        ),
      ),
    );
    await waiting.promise;
    await runtime.runPromise(Fiber.interrupt(cancelled));
    const failures: readonly [AppError, string][] = [
      [{ kind: "stream", failure: { kind: "unavailable", status: 404 } }, "unavailable"],
      [{ kind: "stream", failure: { kind: "refused", status: 401 } }, "credentials"],
      [{ kind: "provider-error", status: 503 }, "unavailable"],
      [{ kind: "unreachable", server: "PRIVATE", detail: "PRIVATE" }, "network"],
      [{ kind: "unexpected", detail: "PRIVATE" }, "app"],
    ];
    for (const [error, code] of failures) {
      const failed = new Failed({ error });
      const result = await runtime.runPromiseExit(
        observeOpen(coordination, observe, () => Effect.fail(failed)),
      );
      if (!Exit.isFailure(result)) throw new Error("Open did not fail.");
      const publicError = Cause.findErrorOption(result.cause);
      if (publicError._tag !== "Some") throw new Error("No public open error.");
      expect(publicError.value).toBe(failed);
      expect(notes.at(-1)).toEqual(["failed", code]);
    }
    expect(notes.filter((note) => Array.isArray(note) && note[0] === "interrupted")).toHaveLength(
      2,
    );
    expect(JSON.stringify(notes)).not.toContain("PRIVATE");
    const value = { sessionId: "kept" };
    expect(
      await runtime.runPromise(observeOpen(coordination, observe, () => Effect.succeed(value))),
    ).toBe(value);
  });
});
