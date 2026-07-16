import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts", testing: "src/testing/index.ts" },
	platform: "node",
	format: ["esm"],
	bundle: true,
	dts: true,
	treeshake: true,
	clean: true,
	noExternal: [/.*/],
});
