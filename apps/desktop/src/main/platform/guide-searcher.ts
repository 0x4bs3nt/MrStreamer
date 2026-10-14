// Runs guide searches in a worker thread (../guide/search-worker.ts): a search reads as many
// programmes as its words find, which on a large guide holds whatever thread runs it for hundreds
// of milliseconds. One worker, started with the first search, takes them one at a time.
//
// A search settles only once the worker no longer reads its file, so whoever holds the file can
// let go: with the worker's answer; or, when it is stopped, takes longer than `SEARCH_TIMEOUT_MS`
// or the app quits, once the worker has been ended. Stops that come together wait for the same
// end, and settle the search they stopped and no other. A worker ended or stopped on its own fails
// what it had been asked; the next search starts another. A search waiting its turn is only
// taken off the queue when stopped, and its time starts once it is the worker's.
import type { Worker, WorkerOptions } from "node:worker_threads";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type {
  EachFound,
  EachSearch,
  FirstFound,
  FirstSearch,
} from "@mrstreamer/core/guide/index-file";
import { GuideSearcher } from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** What the main process asks the search worker. */
export type GuideSearchRequest =
  | { readonly id: number; readonly kind: "first"; readonly search: FirstSearch }
  | { readonly id: number; readonly kind: "each"; readonly search: EachSearch };

/** What the search worker answers, by the request's id. */
export type GuideSearchReply =
  | { readonly id: number; readonly kind: "first"; readonly found: FirstFound }
  | { readonly id: number; readonly kind: "each"; readonly found: EachFound }
  | { readonly id: number; readonly kind: "failed"; readonly error: AppError };

/** The memory the search worker may take: a search keeps a page of what it reads at a time. */
const WORKER_LIMITS: WorkerOptions["resourceLimits"] = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
};

/** How long the worker may take over one search before it is ended. */
const SEARCH_TIMEOUT_MS = 30_000;

/** A search asked for, until it settles. */
interface Asked {
  readonly request: GuideSearchRequest;
  readonly signal: AbortSignal;
  settle(reply: GuideSearchReply | Error): void;
}

/**
 * The searcher that runs searches in the worker `start` starts: the bundled one, or its source.
 * `timeout` is how long one search may take, shorter in tests.
 */
export function guideSearcherLayer(
  start: (options: WorkerOptions) => Worker,
  timeout = SEARCH_TIMEOUT_MS,
): Layer.Layer<GuideSearcher> {
  return Layer.effect(
    GuideSearcher,
    Effect.acquireRelease(
      Effect.sync(() => {
        /** The worker that takes searches. Null once it is being ended: nothing of it counts then. */
        let worker: Worker | null = null;
        /** The end of the worker being ended, until it has: every stop meanwhile waits for it. */
        let ending: Promise<void> | null = null;
        /** The search the worker has, and when it is overdue. */
        let current: { readonly asked: Asked; readonly overdue: NodeJS.Timeout } | null = null;
        const queue: Asked[] = [];
        let next = 0;
        let quitting = false;

        /** Ends the worker, once, however many ask. */
        const endWorker = () => {
          if (ending) return ending;
          const was = worker;
          if (!was) return Promise.resolve();
          worker = null;
          ending = was
            .terminate()
            .then(
              () => {},
              () => {},
            )
            .finally(() => {
              ending = null;
            });
          return ending;
        };
        /**
         * Ends the worker, and once it has ended, fails the search it had then: no other, also
         * when several stop it together.
         */
        const stop = async (cause: Error) => {
          const done = current;
          if (done) clearTimeout(done.overdue);
          await endWorker();
          if (done) finish(done, cause);
        };
        /** Settles `done`, while it is the search under way, and gives the worker the next. */
        const finish = (done: NonNullable<typeof current>, reply: GuideSearchReply | Error) => {
          if (current !== done) return;
          current = null;
          clearTimeout(done.overdue);
          done.asked.signal.removeEventListener("abort", stopCurrent);
          done.asked.settle(reply);
          pump();
        };
        const stopCurrent = () => void stop(new Error("The guide's search was stopped."));
        /** The worker, started when none runs. */
        const running = () => {
          if (worker) return worker;
          const started = start({ resourceLimits: WORKER_LIMITS, stdout: true, stderr: true });
          started.on("message", (reply: GuideSearchReply) => {
            // A worker being ended may still answer: it no longer counts.
            if (worker === started && current?.asked.request.id === reply.id)
              finish(current, reply);
          });
          const stopped = (cause: Error) => {
            if (worker !== started) return;
            worker = null;
            if (current) finish(current, cause);
          };
          started.on("error", stopped);
          started.on("exit", (code) =>
            stopped(new Error(`The guide's search stopped with ${code}.`)),
          );
          worker = started;
          return started;
        };
        const pump = () => {
          if (current || quitting) return;
          const asked = queue.shift();
          if (!asked) return;
          if (asked.signal.aborted) {
            asked.settle(new Error("The guide's search was stopped."));
            return pump();
          }
          current = {
            asked,
            overdue: setTimeout(
              () => void stop(new Error("The guide's search took too long.")),
              timeout,
            ),
          };
          asked.signal.addEventListener("abort", stopCurrent, { once: true });
          running().postMessage(asked.request);
        };
        /** Asks the worker, answering with what `pick` takes of its reply. */
        const ask = <A>(
          request: GuideSearchRequest,
          signal: AbortSignal,
          pick: (reply: GuideSearchReply) => A | undefined,
        ): Promise<A> =>
          new Promise<A>((resolve, reject) => {
            const asked: Asked = {
              request,
              signal,
              settle: (reply) => {
                if (reply instanceof Error) return reject(reply);
                if (reply.kind === "failed") return reject(new AppFailure(reply.error));
                const found = pick(reply);
                if (found === undefined) reject(new Error("The guide's search answered another."));
                else resolve(found);
              },
            };
            if (quitting) return asked.settle(new Error("The app is quitting."));
            queue.push(asked);
            // Stopped while it waits its turn: it leaves the queue at once.
            signal.addEventListener(
              "abort",
              () => {
                const at = queue.indexOf(asked);
                if (at < 0) return;
                queue.splice(at, 1);
                asked.settle(new Error("The guide's search was stopped."));
              },
              { once: true },
            );
            pump();
          });
        return {
          first: (search: FirstSearch, signal: AbortSignal) =>
            ask({ id: next++, kind: "first", search }, signal, (reply) =>
              reply.kind === "first" ? reply.found : undefined,
            ),
          each: (search: EachSearch, signal: AbortSignal) =>
            ask({ id: next++, kind: "each", search }, signal, (reply) =>
              reply.kind === "each" ? reply.found : undefined,
            ),
          quit: async () => {
            quitting = true;
            for (const asked of queue.splice(0)) asked.settle(new Error("The app is quitting."));
            await stop(new Error("The app is quitting."));
          },
        };
      }),
      (searcher) => Effect.promise(() => searcher.quit()),
    ),
  );
}
