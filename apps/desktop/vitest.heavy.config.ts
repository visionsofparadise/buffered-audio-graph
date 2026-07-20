import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*integration.heavy.test.ts"],
		testTimeout: 600_000,
		hookTimeout: 600_000,
		fileParallelism: false,
	},
});
