import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { assert, describe, expect, it, vi } from "vitest";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

// Hold a completed disk read at the storage boundary, so removal and caller cancellation can
// happen before that old answer is published. No catalogue internals are exposed to the tests.
const heldReads = vi.hoisted(
  () => new Map<string, { began(): void; readonly release: Promise<void> }>(),
);
vi.mock("../src/main/platform/json-file.ts", async (original) => {
  const actual = await original<typeof import("../src/main/platform/json-file.ts")>();
  const read: typeof actual.readJsonFile = async (path, schema) => {
    const value = await actual.readJsonFile(path, schema);
    const held = heldReads.get(path);
    if (held) {
      heldReads.delete(path);
      held.began();
      await held.release;
    }
    return value;
  };
  return { ...actual, readJsonFile: read };
});

async function setup() {
  const dir = await tempDir();
  const provider = await fakeProvider();
  const start = async () => {
    const runtime = runtimeFor(
      Library.layer().pipe(
        Layer.provideMerge(Settings.layer(dir)),
        Layer.provideMerge(
          Subscriptions.layer({
            dataDir: dir,
            secrets: testSecrets,
            providerOptions: { userAgent },
          }),
        ),
      ),
    );
    return {
      runtime,
      library: await promised(runtime, Library),
      subscriptions: await promised(runtime, Subscriptions),
    };
  };
  const first = await start();
  const { id } = await first.subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await first.library.refresh(id);
  const channel = (await first.library.channels({}))[0]!;
  await first.runtime.dispose();
  const app = await start();
  const source = (await app.subscriptions.saved())[0]!;
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const read = Promise.withResolvers<void>();
  heldReads.set(join(source.dir, "catalogue.json"), { began, release: read.promise });
  return { ...app, source, channel, started, release: read.resolve, failRead: read.reject };
}

describe("pending catalogue reads", () => {
  it("cannot revive a removed channel through the lookup waiting for the old disk answer", async () => {
    const app = await setup();
    const library = await app.runtime.runPromise(Library);
    const lookup = app.runtime.runPromiseExit(library.lookup(app.source.id));
    await app.started;
    try {
      await app.library.forget(app.source);
      await app.subscriptions.remove(app.source.id);
    } finally {
      app.release();
    }
    const result = await lookup;
    assert(Exit.isSuccess(result));
    expect(result.value(app.channel.id)).toBeUndefined();
    expect((await app.library.lookup(app.source.id))(app.channel.id)).toBeUndefined();
  });

  it("finishes a stale check after removal without interrupting concurrent work", async () => {
    const app = await setup();
    const library = await app.runtime.runPromise(Library);
    const sibling = Promise.withResolvers<string>();
    const refresh = app.runtime.runPromiseExit(
      Effect.all(
        {
          stale: library.isStale(app.source.id, "1 day"),
          sibling: Effect.promise(() => sibling.promise),
        },
        { concurrency: "unbounded" },
      ),
    );
    await app.started;
    try {
      await app.subscriptions.remove(app.source.id);
      await app.library.forget(app.source);
    } finally {
      app.release();
      sibling.resolve("completed");
    }
    const result = await refresh;
    assert(Exit.isSuccess(result));
    expect(result.value).toEqual({ stale: true, sibling: "completed" });
  });

  it("lets one caller cancel while another still receives the shared offline catalogue", async () => {
    const app = await setup();
    const library = await app.runtime.runPromise(Library);
    const stop = new AbortController();
    const first = app.runtime.runPromiseExit(library.lookup(app.source.id), {
      signal: stop.signal,
    });
    await app.started;
    const second = app.library.channels({});
    stop.abort();
    try {
      const cancelled = await first;
      expect(Exit.isFailure(cancelled)).toBe(true);
      if (Exit.isFailure(cancelled)) expect(Cause.hasInterruptsOnly(cancelled.cause)).toBe(true);
    } finally {
      app.release();
    }
    expect((await second).some((channel) => channel.id === app.channel.id)).toBe(true);
  });

  it("settles the old lookup successfully when an edited source starts a new disk read", async () => {
    const app = await setup();
    const library = await app.runtime.runPromise(Library);
    const old = app.runtime.runPromiseExit(library.lookup(app.source.id));
    await app.started;
    try {
      await app.subscriptions.update(app.source.id, { secret: "demo" });
      const current = await app.library.lookup(app.source.id);
      assert(Exit.isSuccess(await old));
      expect(current(app.channel.id)?.id).toBe(app.channel.id);
    } finally {
      app.release();
    }
    expect((await app.library.lookup(app.source.id))(app.channel.id)?.id).toBe(app.channel.id);
  });

  it("preserves a disk read defect instead of reporting a cache miss", async () => {
    const app = await setup();
    const library = await app.runtime.runPromise(Library);
    const lookup = app.runtime.runPromiseExit(library.lookup(app.source.id));
    await app.started;
    const defect = new Error("storage boundary failed");
    app.failRead(defect);
    const result = await lookup;
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(defect);
  });
});
