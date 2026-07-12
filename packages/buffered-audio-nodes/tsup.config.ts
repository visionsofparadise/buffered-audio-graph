import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts", "nlm-worker": "src/transforms/de-bleed/nlm-worker.ts" },
	platform: "node",
	format: ["esm"],
	bundle: true,
	dts: true,
	treeshake: true,
	clean: true,
	noExternal: [/.*/],
});
