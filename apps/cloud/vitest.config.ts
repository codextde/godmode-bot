import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.join(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "server/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Tests share one PostgreSQL database (godmode_cloud_test); files run one after another.
    fileParallelism: false,
  },
});
