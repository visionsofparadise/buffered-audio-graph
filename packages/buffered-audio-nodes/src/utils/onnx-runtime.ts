import { createRequire } from "node:module";
import path from "node:path";

export interface OnnxSession {
	run(inputs: Record<string, OnnxTensor>): Record<string, OnnxTensor>;
	dispose(): void;
}

export interface OnnxTensor {
	readonly data: Float32Array;
	readonly dims: ReadonlyArray<number>;
}

export interface OnnxSessionOptions {
	readonly executionProviders?: ReadonlyArray<string>;
}

interface OnnxAddon {
	createSession(modelPath: string, options?: { executionProviders?: Array<string> }): OnnxAddonSession;
}

interface OnnxAddonSession {
	run(inputs: Record<string, OnnxTensor>): Record<string, OnnxTensor>;
	dispose(): void;
	inputNames(): Array<string>;
	outputNames(): Array<string>;
	// Added in onnx-runtime-addon v1.1.0. Returns the EP name actually
	// resolved by ORT for this session (e.g. "DmlExecutionProvider",
	// "CUDAExecutionProvider", "CPUExecutionProvider"). Older addon builds
	// don't have this method — callers must handle a missing implementation.
	getProvider?(): string;
}

const require = createRequire(import.meta.url);

export function createOnnxSession(
	addonPath: string,
	modelPath: string,
	options?: OnnxSessionOptions,
	log?: (message: string, data?: Record<string, unknown>) => void,
): OnnxSession {
	let addon: OnnxAddon;

	try {
		addon = require(addonPath) as OnnxAddon;
	} catch (error) {
		throw new Error(`Failed to load ONNX Runtime addon from "${addonPath}": ${error instanceof Error ? error.message : String(error)}`);
	}

	let session: OnnxAddonSession;

	try {
		session = addon.createSession(modelPath, {
			executionProviders: options?.executionProviders ? [...options.executionProviders] : ["cpu"],
		});
	} catch (error) {
		throw new Error(`Failed to create ONNX session for model "${modelPath}": ${error instanceof Error ? error.message : String(error)}`);
	}

	const modelName = path.basename(modelPath);
	let provider: string;

	try {
		provider = typeof session.getProvider === "function" ? session.getProvider() : "<unknown> (addon predates getProvider())";
	} catch (error) {
		provider = `<unknown> (getProvider() threw: ${error instanceof Error ? error.message : String(error)})`;
	}

	log?.("onnx session created", { modelName, provider });

	return {
		run(inputs) {
			return session.run(inputs);
		},
		dispose() {
			session.dispose();
		},
	};
}
