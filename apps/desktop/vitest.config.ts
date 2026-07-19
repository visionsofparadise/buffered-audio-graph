import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          globals: true,
          environment: "node",
          include: ["src/**/*unit.test.ts", "src/**/*unit.test.tsx"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
