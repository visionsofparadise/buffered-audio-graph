import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*benchmark.test.ts"],
    testTimeout: 600_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
  },
});
