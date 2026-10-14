// Searches guide index files in a worker thread of its own, one search at a time, so however
// many programmes a search reads, the main process goes on (see ../platform/guide-searcher.ts).
// Each search opens its file read-only and closes it before answering: the main process keeps
// the file until then.
import { parentPort } from "node:worker_threads";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { searchEach, searchFirst } from "@mrstreamer/core/guide/index-file";
import type { GuideSearchReply, GuideSearchRequest } from "../platform/guide-searcher.ts";

const answer = (request: GuideSearchRequest): GuideSearchReply => {
  try {
    return request.kind === "first"
      ? { id: request.id, kind: "first", found: searchFirst(request.search) }
      : { id: request.id, kind: "each", found: searchEach(request.search) };
  } catch (cause) {
    return {
      id: request.id,
      kind: "failed",
      error:
        cause instanceof AppFailure
          ? cause.error
          : { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) },
    };
  }
};

parentPort?.on("message", (request: GuideSearchRequest) => {
  parentPort?.postMessage(answer(request));
});
