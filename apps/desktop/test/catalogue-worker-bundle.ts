// Vitest's global setup: bundles the catalogue worker once before any test runs, as the app's
// build does, and gives tests its path through `inject("catalogueWorker")`. Started from its
// source files instead, every start of the worker found and read some 150 modules one by one, a
// third or more of the start, and the tests that start the app start it again and again. Watch
// mode makes no bundle and gives null: a bundle made once would go stale as the source changes,
// so the worker starts from its source there.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The bundled catalogue worker's file, or null to start it from its source. */
    catalogueWorker: string | null;
  }
}

export default async function bundleCatalogueWorker(project: TestProject) {
  if (project.vitest.config.watch) {
    project.provide("catalogueWorker", null);
    return;
  }
  const outDir = await mkdtemp(join(tmpdir(), "catalogue-worker-"));
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      ssr: fileURLToPath(new URL("../src/main/ondemand/catalogue-worker.ts", import.meta.url)),
      outDir,
      target: "node24",
      minify: false,
      reportCompressedSize: false,
      rollupOptions: { output: { entryFileNames: "catalogue-worker.js" } },
    },
    ssr: { noExternal: true },
  });
  project.provide("catalogueWorker", join(outDir, "catalogue-worker.js"));
  return () => rm(outDir, { recursive: true, force: true });
}
