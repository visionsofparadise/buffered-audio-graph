import { z } from "zod";
import { BufferedTransformStream, type BlockBuffer, createProgressGate, TransformNode, WHOLE_FILE, type Block, type StreamSetupContext, type TransformNodeProperties } from "@buffered-audio/core";
import { initFftBackend, linearToDb, type FftBackend } from "@buffered-audio/utils";
import { PACKAGE_NAME } from "../../package-metadata";
import { LATTICE_ORDER } from "./utils/lattice";
import { isPowerOfTwo } from "./utils/power-of-two";
import { groupDelayLambda } from "./utils/search";
import { exactHoldHalfWidthFrames, smoothControlTrajectory, trajectoryFrameRate } from "./utils/trajectory";
import { LatticeApplyState, streamLatticeTrajectory, TruePeakArgmaxAccumulator } from "./utils/windowed";

export const schema = z.object({
	smoothing: z
		.number()
		.min(0)
		.default(100)
		.describe(
			"Bidirectional (zero-phase) smoothing time constant in ms applied to the per-frame decorrelation envelope before it drives the lattice (default 100 ms). The envelope is 0 in segments with no active-band peak and the per-binding-peak optimal value at active-band peaks; smoothing eases it toward 0 across gaps so the bidirectional pass is predictable. Applied to the CONTROL trajectory only — never the audio path",
		),
	frameSize: z
		.number()
		.int()
		.refine(isPowerOfTwo, { message: "frameSize must be a power of two" })
		.default(2048)
		.describe("Analysis frame length in samples (default 2048 @ 48 kHz ≈ 43 ms; 75% overlap, Hann analysis window). Whole-file processing — output is produced after the full input is accumulated"),
	vkfftAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "vkfft-addon", download: "https://github.com/visionsofparadise/vkfft-addon" })
		.describe("VkFFT native addon — GPU FFT acceleration"),
	fftwAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "fftw-addon", download: "https://github.com/visionsofparadise/fftw-addon" })
		.describe("FFTW native addon — CPU FFT acceleration"),
});

export interface CrestReduceProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class CrestReduceStream extends BufferedTransformStream<CrestReduceNode> {
	override blockSize = WHOLE_FILE;

	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private truePeakAccumulator?: TruePeakArgmaxAccumulator;

	override _setup(context: StreamSetupContext): void {
		const fft = initFftBackend(context.executionProviders, this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;
	}

	private get hopSize(): number {
		return this.properties.frameSize / 4;
	}

	override _prepare(block: Block): Block {
		const frames = block.samples[0]?.length ?? 0;

		if (frames === 0 || block.samples.length === 0) return block;

		this.truePeakAccumulator ??= new TruePeakArgmaxAccumulator(block.samples.length, block.sampleRate);
		this.truePeakAccumulator.push(block.samples, frames);

		return block;
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const { frameSize, smoothing } = this.properties;
		const channelCount = buffered.channels;
		const totalFrames = buffered.frames;

		if (channelCount === 0 || totalFrames === 0) return;

		const sampleRate = buffered.sampleRate ?? this.sampleRate ?? 48000;
		const order = LATTICE_ORDER;
		const hopSize = this.hopSize;

		const { db: inputTpDb, peakInputSample } = this.truePeakAccumulator?.finalize() ?? { db: linearToDb(0), peakInputSample: 0 };

		const lambda = groupDelayLambda(sampleRate, order);
		const trajectoryGate = createProgressGate();
		const { trajectory, frameCount } = await streamLatticeTrajectory(buffered, frameSize, hopSize, this.fftBackend, this.fftAddonOptions, {
			globalTruePeakDb: inputTpDb,
			peakInputSample,
			sampleRate,
			lambda,
		}, (done, total) => {
			if (trajectoryGate(done, Date.now())) this.emitProgress("process", done, total);
		});

		if (frameCount === 0) {
			yield* buffered.iterate(44100);

			return;
		}

		this.log("trajectory analysed", { frameCount });

		const smoothedTrajectory = smoothControlTrajectory(trajectory, smoothing, trajectoryFrameRate(sampleRate, hopSize), exactHoldHalfWidthFrames(sampleRate, hopSize), hopSize);

		await buffered.reset();

		let applyState: LatticeApplyState | undefined;
		let appliedFrames = 0;
		const applyGate = createProgressGate(totalFrames);

		for await (const block of buffered.iterate(44100)) {
			const frames = block.samples[0]?.length ?? 0;
			const blockChannelCount = block.samples.length;

			if (frames === 0 || blockChannelCount === 0) {
				yield block;

				continue;
			}

			applyState ??= new LatticeApplyState(smoothedTrajectory, order, hopSize, blockChannelCount);

			const transformed = applyState.apply(block.samples, frames);
			const samples = block.samples.map((inputChannel, ch) => transformed[ch] ?? inputChannel);

			yield { samples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth };

			appliedFrames += frames;

			const doneFrames = Math.min(appliedFrames, totalFrames);

			if (applyGate(doneFrames, Date.now())) this.emitProgress("process", doneFrames, totalFrames);
		}
	}
}

export class CrestReduceNode extends TransformNode<CrestReduceProperties> {
	static override readonly nodeName = "Crest Reduce";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Content-adaptive, magnitude-preserving, phase-only crest-factor reducer — a pre-limiter headroom stage that rearranges signal phase to flatten true-peak excursions without changing the magnitude spectrum, never increasing crest factor";
	static override readonly schema = schema;
	static override readonly Stream = CrestReduceStream;
}

export function crestReduce(options?: { smoothing?: number; frameSize?: number; vkfftAddonPath?: string; fftwAddonPath?: string; id?: string }): CrestReduceNode {
	return new CrestReduceNode(options ?? {});
}
