// Indexes one guide document into its SQLite file, in a worker thread of its own, and says how
// far it got as it goes (see ../platform/guide-indexer.ts). It ends once the index is written,
// or with why it can't be.
import { parentPort, workerData } from "node:worker_threads";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { buildGuideIndex, type GuideBuild } from "@mrstreamer/core/guide/index-file";
import type { GuideIndexMessage } from "../platform/guide-indexer.ts";

const build: GuideBuild = workerData;
const tell = (message: GuideIndexMessage) => parentPort?.postMessage(message);

try {
  const summary = await buildGuideIndex(build, (programmes) =>
    tell({ kind: "progress", programmes }),
  );
  tell({ kind: "done", summary });
} catch (cause) {
  tell({
    kind: "failed",
    error:
      cause instanceof AppFailure
        ? cause.error
        : { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) },
  });
}
