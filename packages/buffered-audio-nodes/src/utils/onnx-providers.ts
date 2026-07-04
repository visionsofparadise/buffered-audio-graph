import type { ExecutionProvider } from "@buffered-audio/core";

export function filterOnnxProviders(providers: ReadonlyArray<ExecutionProvider>): Array<string> {
	const platform = process.platform;
	const out: Array<string> = [];

	for (const ep of providers) {
		if (ep === "gpu") {
			if (platform === "win32") out.push("dml");
			else if (platform === "linux") out.push("cuda");
			else if (platform === "darwin") out.push("coreml");
		} else if (ep === "cpu") {
			out.push("cpu");
		}
	}

	const seen = new Set<string>();
	const deduped: Array<string> = [];

	for (const name of out) {
		if (!seen.has(name)) {
			seen.add(name);
			deduped.push(name);
		}
	}

	return deduped.length > 0 ? deduped : ["cpu"];
}
