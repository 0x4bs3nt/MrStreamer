import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/desktop/test/renderer/download-performance.probe.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
