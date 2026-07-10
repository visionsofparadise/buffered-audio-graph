import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `pool: forks` + `--expose-gc` stays at config root (applies to every project)
    // until plan-test-restructure Phase 3.3 relocates the loudness-target memory
    // regression test to the heavy set. That test hard-fails (`expect.fail`) when
    // `global.gc` is unavailable, and it lives in the unit set until Phase 3.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["src/**/*unit.test.ts", "scripts/**/*unit.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          globals: true,
          environment: "node",
          include: ["src/**/*integration.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
