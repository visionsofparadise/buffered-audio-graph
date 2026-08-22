import { createRequire } from "node:module";

export interface FaustAddon {
	readonly faustVersion: string;
	extractStandardLibrary(directory: string): void;

	createFactory(name: string, code: string, includeDirectories: ReadonlyArray<string>): FaustFactory;
}

export interface FaustFactory {
	createInstance(): FaustInstance;

	dispose(): void;
}

export interface FaustInstance {
	init(sampleRate: number): void;

	getNumInputs(): number;

	getNumOutputs(): number;

	compute(frames: number, inputs: ReadonlyArray<Float32Array>, outputs: ReadonlyArray<Float32Array>): void;

	dispose(): void;
}

const require = createRequire(import.meta.url);

export function loadFaustAddon(addonPath: string): FaustAddon {
	try {
		return require(addonPath) as FaustAddon;
	} catch (error) {
		throw new Error(
			`Failed to load Faust addon from "${addonPath}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
