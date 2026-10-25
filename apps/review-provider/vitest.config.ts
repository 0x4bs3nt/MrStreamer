import { fileURLToPath, URL as NodeURL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new NodeURL(".", import.meta.url)),
  cacheDir: process.env["MR_REVIEW_CACHE"] ?? ".local/vitest-cache",
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
