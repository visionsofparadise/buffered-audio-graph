import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
