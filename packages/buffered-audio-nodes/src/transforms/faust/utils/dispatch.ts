export type FaustDispatch =
	| { readonly mode: "single"; readonly outputChannels: number }
	| { readonly mode: "perChannel"; readonly outputChannels: number };

export function resolveFaustDispatch(numInputs: number, numOutputs: number, channels: number): FaustDispatch {
	if (numInputs === channels) {
		return { mode: "single", outputChannels: numOutputs };
	}

	if (numInputs === 1 && numOutputs === 1) {
		return { mode: "perChannel", outputChannels: channels };
	}

	throw new Error(`Faust program has ${numInputs} inputs and ${numOutputs} outputs; input has ${channels} channels`);
}
