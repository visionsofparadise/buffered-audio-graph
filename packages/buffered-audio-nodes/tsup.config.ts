import { defineConfig } from "tsup";

export default defineConfig([
	{
		entry: { index: "src/index.ts", "nlm-worker": "src/transforms/de-bleed/nlm-worker.ts" },
		platform: "node",
		format: ["esm"],
		bundle: true,
		dts: true,
		treeshake: true,
		clean: true,
		noExternal: [/.*/],
	},
	{
		entry: { cli: "src/cli.ts" },
		platform: "node",
		format: ["esm"],
		bundle: true,
		banner: { js: "#!/usr/bin/env node" },
		treeshake: true,
		// Leave runtime deps external so Node's resolver loads them as real
		// modules at runtime. Inlining CJS deps (commander) into the ESM bundle
		// produces a __require shim that crashes on Node builtins like `events`.
	},
]);
