import { parentPort } from "node:worker_threads";
import { applyNlmSmoothingRange, type NlmParams } from "@buffered-audio/utils";

interface NlmWorkerMessage {
	readonly maskSab: SharedArrayBuffer;
	readonly outputSab: SharedArrayBuffer;
	readonly numFrames: number;
	readonly numBins: number;
	readonly options: NlmParams;
	readonly blockFrameStart: number;
	readonly blockFrameEnd: number;
}

// Only wire up when running as a worker. Importing this module in a normal context
// (e.g. the docs generator globbing src, or a bundler) must be a harmless no-op, not a throw.
const port = parentPort;

if (port) {
	port.on("message", (message: NlmWorkerMessage) => {
		const { maskSab, outputSab, numFrames, numBins, options, blockFrameStart, blockFrameEnd } = message;
		const mask = new Float32Array(maskSab, 0, numFrames * numBins);
		const output = new Float32Array(outputSab, 0, numFrames * numBins);

		applyNlmSmoothingRange(mask, numFrames, numBins, options, output, blockFrameStart, blockFrameEnd);

		port.postMessage(null);
	});
}
