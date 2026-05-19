import type { ExecutionProvider } from "@buffered-audio/core";

/**
 * Translate the abstract `ExecutionProvider` preference list into a concrete
 * ONNX Runtime EP name list appropriate for the current platform.
 *
 * Platform mapping for `"gpu"`:
 *   - win32  → "dml"    (DirectML covers all DX12 GPUs; no CUDA on Windows)
 *   - linux  → "cuda"   (NVIDIA + cudart/cuDNN required; falls through to cpu otherwise)
 *   - darwin → "coreml" (CoreML EP ships in Apple's standard ORT release)
 *   - other  → dropped  (ORT will use CPU)
 *
 * `"cpu"` always emits `"cpu"`. `"cpu-native"` is dropped — ONNX has no
 * CPU-native EP; the standard CPU EP is the only choice.
 *
 * The output preserves the input order, deduplicates, and falls back to
 * `["cpu"]` if the result would otherwise be empty.
 */
export function filterOnnxProviders(providers: ReadonlyArray<ExecutionProvider>): Array<string> {
	const platform = process.platform;
	const out: Array<string> = [];

	for (const ep of providers) {
		if (ep === "gpu") {
			if (platform === "win32") out.push("dml");
			else if (platform === "linux") out.push("cuda");
			else if (platform === "darwin") out.push("coreml");
			// other platforms: drop — ORT falls through to CPU
		} else if (ep === "cpu") {
			out.push("cpu");
		}
		// "cpu-native": dropped (no ONNX CPU-native EP)
	}

	// Deduplicate while preserving order.
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
