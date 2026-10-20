import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Downloads } from "../services/downloads.ts";

export function downloadHandlers({
  downloads,
}: {
  readonly downloads: Pick<
    Downloads["Service"],
    "list" | "add" | "remove" | "retry" | "recordProgress"
  >;
}): HandlersFor<"downloads"> {
  return {
    "downloads.list": () => downloads.list,
    "downloads.add": ({ title }) => downloads.add(title),
    "downloads.remove": ({ id }) => Effect.as(downloads.remove(id), null),
    "downloads.retry": ({ id }) => Effect.as(downloads.retry(id), null),
    "downloads.recordProgress": ({ id, position, duration }) =>
      Effect.as(downloads.recordProgress(id, position, duration), null),
  };
}
