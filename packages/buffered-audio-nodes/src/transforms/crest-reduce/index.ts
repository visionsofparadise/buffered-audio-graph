import { z } from "zod";
import { BufferedTransformStream, type ChunkBuffer, TransformNode, WHOLE_FILE, type AudioChunk, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { initFftBackend, linearToDb, type FftBackend } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { LATTICE_ORDER } from "./utils/lattice";
import { groupDelayLambda } from "./utils/search";
import { exactHoldHalfWidthFrames, smoothControlTrajectory, trajectoryFrameRate, type ControlTrajectory } from "./utils/trajectory";
import { LatticeApplyState, streamLatticeTrajectory, TruePeakArgmaxAccumulator } from "./utils/windowed";

function isPowerOfTwo(value: number): boolean {
	return value > 0 && (value & (value - 1)) === 0;
}

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

export class CrestReduceStream extends BufferedTransformStream<CrestReduceProperties> {
	private fftBackend?: FftBackend;
	private fftAddonOptions?: { vkfftPath?: string; fftwPath?: string };
	private truePeakAccumulator?: TruePeakArgmaxAccumulator;
	private smoothedTrajectory?: ControlTrajectory;
	private applyOrder = LATTICE_ORDER;
	private applyHopSize = 0;
	private applyState?: LatticeApplyState;

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
		const fft = initFftBackend(context.executionProviders, this.properties);

		this.fftBackend = fft.backend;
		this.fftAddonOptions = fft.addonOptions;

		return super._setup(input, context);
	}

	private get hopSize(): number {
		return this.properties.frameSize / 4;
	}

	override async _buffer(chunk: AudioChunk, buffer: ChunkBuffer): Promise<void> {
		await super._buffer(chunk, buffer);

		const frames = chunk.samples[0]?.length ?? 0;

		if (frames === 0 || chunk.samples.length === 0) return;

		this.truePeakAccumulator ??= new TruePeakArgmaxAccumulator(chunk.samples.length, chunk.sampleRate);
		this.truePeakAccumulator.push(chunk.samples, frames);
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const { frameSize, smoothing } = this.properties;
		const channelCount = buffer.channels;
		const totalFrames = buffer.frames;

		if (channelCount === 0 || totalFrames === 0) return;

		const sampleRate = buffer.sampleRate ?? this.sampleRate ?? 48000;
		const order = LATTICE_ORDER;
		const hopSize = this.hopSize;

		const { db: inputTpDb, peakInputSample } = this.truePeakAccumulator?.finalize() ?? { db: linearToDb(0), peakInputSample: 0 };

		const lambda = groupDelayLambda(sampleRate, order);
		const { trajectory, frameCount } = await streamLatticeTrajectory(buffer, frameSize, hopSize, this.fftBackend, this.fftAddonOptions, {
			globalTruePeakDb: inputTpDb,
			peakInputSample,
			sampleRate,
			lambda,
		});

		if (frameCount === 0) return;

		this.smoothedTrajectory = smoothControlTrajectory(trajectory, smoothing, trajectoryFrameRate(sampleRate, hopSize), exactHoldHalfWidthFrames(sampleRate, hopSize), hopSize);
		this.applyOrder = order;
		this.applyHopSize = hopSize;
	}

	override _unbuffer(chunk: AudioChunk): AudioChunk | undefined {
		const trajectory = this.smoothedTrajectory;
		const frames = chunk.samples[0]?.length ?? 0;
		const channelCount = chunk.samples.length;

		if (trajectory === undefined || frames === 0 || channelCount === 0) return chunk;

		this.applyState ??= new LatticeApplyState(trajectory, this.applyOrder, this.applyHopSize, channelCount);

		const transformed = this.applyState.apply(chunk.samples, frames);
		const samples = chunk.samples.map((inputChannel, ch) => transformed[ch] ?? inputChannel);

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class CrestReduceNode extends TransformNode<CrestReduceProperties> {
	static override readonly moduleName = "Crest Reduce";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Content-adaptive, magnitude-preserving, phase-only crest-factor reducer — a pre-limiter headroom stage that rearranges signal phase to flatten true-peak excursions without changing the magnitude spectrum, never increasing crest factor";
	static override readonly schema = schema;
	static override is(value: unknown): value is CrestReduceNode {
		return TransformNode.is(value) && value.type[2] === "crest-reduce";
	}

	override readonly type = ["buffered-audio-node", "transform", "crest-reduce"] as const;

	constructor(properties: CrestReduceProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): CrestReduceStream {
		return new CrestReduceStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<CrestReduceProperties>): CrestReduceNode {
		return new CrestReduceNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function crestReduce(options?: { smoothing?: number; frameSize?: number; vkfftAddonPath?: string; fftwAddonPath?: string; id?: string }): CrestReduceNode {
	const parsed = schema.parse(options ?? {});

	return new CrestReduceNode({ ...parsed, id: options?.id });
}
