// Shared test helpers: a fake provider per test and throwaway data folders.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { afterEach, inject } from "vitest";
import type { Secrets } from "../src/main/platform/secrets.ts";
import type { MainConfig } from "../src/main/runtime.ts";
import { startFakeProvider, type FakeProvider, type FakeProviderOptions } from "./fake-provider.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export async function fakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const provider = await startFakeProvider(options);
  cleanups.push(() => provider.close());
  return provider;
}

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mr-streamer-test-"));
  // The diagnostics log may still append a line a step took, as the runtime that took it closes.
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** A runtime for `layer`, closed when the test ends, before its data folder is removed. */
export function runtimeFor<R>(layer: Layer.Layer<R>): ManagedRuntime.ManagedRuntime<R, never> {
  const runtime = ManagedRuntime.make(layer);
  cleanups.push(() => runtime.dispose());
  return runtime;
}

/** A service's calls as promises: an Effect becomes a function, a function returns a promise. */
export type Promised<S> = {
  readonly [K in keyof S]: S[K] extends Effect.Effect<infer A, infer _E>
    ? () => Promise<A>
    : S[K] extends (...args: infer P) => Effect.Effect<infer A, infer _E>
      ? (...args: P) => Promise<A>
      : S[K];
};

/**
 * The service `key` from `runtime`, called with promises as the IPC handlers call it. A failure
 * rejects with the service's `Failed`.
 */
export async function promised<I, S extends object>(
  runtime: ManagedRuntime.ManagedRuntime<I, never>,
  key: Context.Key<I, S>,
): Promise<Promised<S>> {
  const service = await runtime.runPromise(key);
  // A service's effects need nothing more from the context: they run on `runtime` for its clock.
  const run = (effect: Effect.Effect<unknown, unknown, unknown>) =>
    runtime.runPromise(effect as Effect.Effect<unknown, unknown, never>);
  const calls = Object.entries(service).map(([name, member]: [string, unknown]) => {
    if (Effect.isEffect(member)) return [name, () => run(member)];
    if (typeof member !== "function") return [name, member];
    return [
      name,
      (...args: unknown[]) => {
        const result: unknown = member(...args);
        return Effect.isEffect(result) ? run(result) : result;
      },
    ];
  });
  return Object.fromEntries(calls) as Promised<S>;
}

/** Everything `stream` emits from now on, as it arrives. */
export async function collect<A, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  stream: Stream.Stream<A>,
): Promise<A[]> {
  const seen: A[] = [];
  runtime.runFork(Stream.runForEach(stream, (item) => Effect.sync(() => seen.push(item))));
  // Lets the subscription start before the test goes on.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return seen;
}

/** A fetch that can hold the provider's answer to the next request until the test releases it. */
export function holdableFetch() {
  let next: { arrived: () => void; answer: Promise<void> } | null = null;
  const holdable: typeof fetch = async (input, init) => {
    const held = next;
    next = null;
    held?.arrived();
    const response = await fetch(input, init);
    await held?.answer;
    return response;
  };
  return {
    fetch: holdable,
    holdNext() {
      const arrived = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      next = { arrived: arrived.resolve, answer: answer.promise };
      return { arrived: arrived.promise, release: answer.resolve };
    },
  };
}

/** Reversible stand-in for the Keychain. Sealed values never contain the plain text. */
export const testSecrets: Secrets = {
  seal: (plain) => Buffer.from(plain, "utf8").toString("base64").split("").reverse().join(""),
  open: (sealed) => Buffer.from(sealed.split("").reverse().join(""), "base64").toString("utf8"),
};

export const userAgent = "MrStreamer/test";

/**
 * The catalogue worker, bundled once for the run as the app's build bundles it; in watch mode,
 * from its source file, as Node runs TypeScript without a build.
 */
const catalogueWorker: MainConfig["catalogueWorker"] = (setup) =>
  new Worker(
    inject("catalogueWorker") ??
      new URL("../src/main/ondemand/catalogue-worker.ts", import.meta.url),
    { workerData: setup },
  );

/** The guide's indexing worker from its source file, as Node runs TypeScript without a build. */
export const guideIndexWorker: MainConfig["guideIndexWorker"] = (options) =>
  new Worker(new URL("../src/main/guide/index-worker.ts", import.meta.url), options);

/** The guide's search worker from its source file. */
export const guideSearchWorker: MainConfig["guideSearchWorker"] = (options) =>
  new Worker(new URL("../src/main/guide/search-worker.ts", import.meta.url), options);

/** What the app gives `mainLayer`, for tests: the test keychain, no ffmpeg, no releases. */
export function testConfig(dataDir: string): MainConfig {
  return {
    dataDir,
    secrets: testSecrets,
    userAgent,
    ffmpeg: null,
    catalogueWorker,
    guideIndexWorker,
    guideSearchWorker,
    tmdbKey: null,
    region: "NL",
    updates: {
      installed: "0.0.1",
      discover: async () => [],
      installer: { download: async () => {}, install: async () => {} },
    },
  };
}
