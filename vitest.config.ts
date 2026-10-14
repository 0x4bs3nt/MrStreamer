import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { exclude, include } from "./test/suites.ts";

// Node keeps the code it compiles, with TypeScript's types stripped, on disk and loads it from
// there next time. The catalogue worker every app start runs, and the scripts tests run as
// commands, skip most of their start that way. The test processes inherit the setting.
process.env["NODE_COMPILE_CACHE"] ??= join(
  import.meta.dirname,
  "node_modules/.cache/node-compile-cache",
);

export default defineConfig({
  test: {
    include,
    exclude,
    environment: "node",
    globalSetup: ["apps/desktop/test/catalogue-worker-bundle.ts"],
  },
});
