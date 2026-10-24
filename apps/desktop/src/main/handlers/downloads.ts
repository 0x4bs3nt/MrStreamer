import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Downloads } from "../services/downloads.ts";

export function downloadHandlers({
  downloads,
}: {
  readonly downloads: Pick<
    Downloads["Service"],
    | "list"
    | "add"
    | "remove"
    | "retry"
    | "pause"
    | "resume"
    | "pauseAll"
    | "resumeAll"
    | "move"
    | "recordProgress"
  >;
}): HandlersFor<"downloads"> {
  return {
    "downloads.list": () => downloads.list,
    "downloads.add": ({ title }) => downloads.add(title),
    "downloads.remove": ({ id }) => Effect.as(downloads.remove(id), null),
    "downloads.retry": ({ id }) => Effect.as(downloads.retry(id), null),
    "downloads.pause": ({ id }) => Effect.as(downloads.pause(id), null),
    "downloads.resume": ({ id }) => Effect.as(downloads.resume(id), null),
    "downloads.pauseAll": () => Effect.as(downloads.pauseAll, null),
    "downloads.resumeAll": () => Effect.as(downloads.resumeAll, null),
    "downloads.move": ({ id, by }) => Effect.as(downloads.move(id, by), null),
    "downloads.recordProgress": ({ id, position, duration }) =>
      Effect.as(downloads.recordProgress(id, position, duration), null),
  };
}
