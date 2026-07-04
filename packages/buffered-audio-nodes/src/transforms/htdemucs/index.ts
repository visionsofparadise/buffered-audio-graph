import { z } from "zod";
import { BufferedTransformStream, ChunkBuffer, TransformNode, WHOLE_FILE, type AudioChunk, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { bandpass, ResampleStream } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { createOnnxSession, type OnnxSession } from "../../utils/onnx-runtime";
import { computeStftScaled, reflectPad } from "./utils/dsp";
import { buildModelInput, extractStems, type StftWorkspace } from "./utils/stems";

export interface StemGains {
	readonly vocals: number;
	readonly drums: number;
	readonly bass: number;
	readonly other: number;
}

export const schema = z.object({
	modelPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", accept: ".onnx", binary: "htdemucs", download: "https://github.com/facebookresearch/demucs" })
		.describe("HTDemucs source separation model (.onnx) — requires .onnx.data file alongside"),
	ffmpegPath: z.string().default("").meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" }).describe("FFmpeg — audio/video processing tool"),
	onnxAddonPath: z
		.string()
		.default("")
		.meta({ input: "file", mode: "open", binary: "onnx-addon", download: "https://github.com/visionsofparadise/onnx-runtime-addon" })
		.describe("ONNX Runtime native addon"),
	highPass: z.number().min(0).max(500).multipleOf(10).default(0).describe("High Pass"),
	lowPass: z.number().min(0).max(22050).multipleOf(100).default(0).describe("Low Pass"),
});

export interface HtdemucsProperties extends z.infer<typeof schema>, TransformNodeProperties {
	readonly stems: StemGains;
}

const HTDEMUCS_SAMPLE_RATE = 44100;
const FFT_SIZE = 4096;
const HOP_SIZE = 1024;
const SEGMENT_SAMPLES = 343980; // 7.8s at 44100Hz
const OVERLAP = 0.25;
const TRANSITION_POWER = 1.0;
const CHUNK_FRAMES = 44100;            // input-side streaming chunk for the original-rate pre-pass and main read
const RESAMPLE_DRAIN_CHUNK = 16384;    // ffmpeg stdout drain block (one read per inner-loop pass)
const STEM_OUTPUTS = 4 * 2;

interface StreamPair {
	readonly resampleIn: ResampleStream;
	readonly resampleOut: ResampleStream;
}

export class HtdemucsStream extends BufferedTransformStream<HtdemucsProperties> {
	private session!: OnnxSession;

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<ReadableStream<AudioChunk>> {
		// HTDemucs is forced to CPU regardless of context.executionProviders.
		// The DirectML EP rejects an operator in the HTDemucs graph at session
		// create time (MLOperatorAuthorImpl.cpp:2816 throws E_INVALIDARG /
		// 0x80070057). ORT auto-falls-through at register time but not when
		// CreateSession itself throws, so DML failure means the entire session
		// fails — we have to opt out of GPU here entirely. Documented in
		// design-gpu-acceleration.md (2026-05-03).
		this.session = createOnnxSession(this.properties.onnxAddonPath, this.properties.modelPath, { executionProviders: ["cpu"] }, (message, data) => this.log(message, data));

		return super._setup(input, context);
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const originalFrames = buffer.frames;
		const channels = buffer.channels;

		if (originalFrames === 0 || channels === 0) return;

		const sourceRate = this.sampleRate ?? HTDEMUCS_SAMPLE_RATE;
		const bitDepth = this.bitDepth;
		const needsResample = sourceRate !== HTDEMUCS_SAMPLE_RATE;

		// === Pre-pass: streaming mean + std at the original rate. ===
		// htdemucs's reference normalises both channels jointly by global mean/std
		// before inference and de-normalises after. We compute these scalars in a
		// bounded-memory streaming pass over the buffer; the only alternative would
		// be materialising the full signal. The reference computes the statistics
		// at 44.1 kHz, but mean/std are essentially rate-invariant for
		// resample-then-stat vs. stat-then-resample, well within the model's
		// robustness window.
		const stats = await computeStreamingStats(buffer, channels);

		await buffer.reset();

		// === Set up streaming resampler subprocesses (if needed). ===
		let pair: StreamPair | undefined;

		if (needsResample) {
			pair = {
				resampleIn: new ResampleStream(this.properties.ffmpegPath, {
					sourceSampleRate: sourceRate,
					targetSampleRate: HTDEMUCS_SAMPLE_RATE,
					channels: 2,
				}),
				resampleOut: new ResampleStream(this.properties.ffmpegPath, {
					sourceSampleRate: HTDEMUCS_SAMPLE_RATE,
					targetSampleRate: sourceRate,
					channels: 2,
				}),
			};
		}

		// Accumulate the inferred output into a temp ChunkBuffer (44.1 kHz / source
		// rate as appropriate). The new ChunkBuffer API is append-only on writes,
		// so we cannot overwrite the original buffer in-place mid-segment-loop:
		// any write would land *past* the input region and the framework's emit
		// step (which reads the whole buffer from frame 0) would then emit both
		// the original input AND the new output. Using a temp output buffer +
		// `clear()` + copy-back keeps the algorithm correct.
		//
		// Deviation from plan: the plan describes a "concurrent in-place (no
		// temp buffer)" pattern. Under the sequential-only ChunkBuffer API, that
		// pattern requires a buffer-storage feature (positional overwrite or
		// truncate-front) that the new API intentionally omits. The
		// reader-leads-writer *invariant* still holds — reads on the input and
		// writes on the temp output advance independently — we just store the
		// writes in a separate ChunkBuffer rather than at the input's tail.
		const output = new ChunkBuffer();

		try {
			await this.runMainPass({
				buffer,
				output,
				channels,
				originalFrames,
				sourceRate,
				bitDepth,
				stats,
				pair,
			});

			// Drop original input; stream-copy output → buffer.
			await buffer.clear();
			await output.reset();

			for (;;) {
				const chunk = await output.read(CHUNK_FRAMES);
				const got = chunk.samples[0]?.length ?? 0;

				if (got === 0) break;

				await buffer.write(chunk.samples, sourceRate, bitDepth);

				if (got < CHUNK_FRAMES) break;
			}
		} finally {
			if (pair) {
				await Promise.all([pair.resampleIn.close(), pair.resampleOut.close()]);
			}

			await output.close();
		}
	}

	private async runMainPass(args: {
		readonly buffer: ChunkBuffer;
		readonly output: ChunkBuffer;
		readonly channels: number;
		readonly originalFrames: number;
		readonly sourceRate: number;
		readonly bitDepth: number | undefined;
		readonly stats: { readonly mean: number; readonly std: number };
		readonly pair: StreamPair | undefined;
	}): Promise<void> {
		const { buffer, output, channels, originalFrames, sourceRate, bitDepth, stats, pair } = args;
		const stride = Math.round((1 - OVERLAP) * SEGMENT_SAMPLES);

		// === Source pump and output drainer (parallel tasks) ===
		// When resampling, run the source-rate → 44.1 kHz feeder and the 44.1 kHz
		// → source-rate drainer as background tasks. ffmpeg's resampler needs
		// hundreds of KB of stdin buffered before it produces its first stdout
		// output (internal SoX-rate FIR delay). A sequential "write-then-read"
		// in the main loop deadlocks waiting for output that won't materialise
		// until enough input has accumulated.
		//
		// Concurrency contract:
		// - Source pump drains `buffer` (source rate) into `resampleIn.stdin`;
		//   calls `end()` when done.
		// - Main loop reads 44.1 kHz samples from `resampleIn.stdout` via
		//   `pullNextChunkAt441`, runs segment inference, writes 44.1 kHz stable
		//   samples to `resampleOut.stdin` via `emitStable`.
		// - Output drainer reads source-rate samples from `resampleOut.stdout`
		//   and appends them to the `output` ChunkBuffer.
		// - At end-of-stream, the main loop closes `resampleOut.stdin`, and the
		//   drainer's `read()` returns `length === 0` when ffmpeg finishes
		//   draining its tail.
		const writerState = { written: 0 };
		const pumpDone = pair !== undefined ? pumpSourceToResampleIn({ buffer, resampleIn: pair.resampleIn, channels, chunkFrames: CHUNK_FRAMES }) : Promise.resolve();
		const drainerDone = pair !== undefined ? drainResampleOutToBuffer({ resampleOut: pair.resampleOut, output, channels, sourceRate, bitDepth, originalFrames, writerState }) : Promise.resolve();

		// Precompute the segment OLA weight window (triangular-ish, raised to TRANSITION_POWER).
		const weight = new Float32Array(SEGMENT_SAMPLES);
		const half = SEGMENT_SAMPLES / 2;

		for (let index = 0; index < half; index++) weight[index] = Math.pow((index + 1) / half, TRANSITION_POWER);
		for (let index = 0; index < half; index++) weight[SEGMENT_SAMPLES - 1 - index] = weight[index] ?? 0;

		// STFT workspace dimensions (constant per segment).
		const pad = Math.floor(HOP_SIZE / 2) * 3; // 1536
		const le = Math.ceil(SEGMENT_SAMPLES / HOP_SIZE);
		const padEnd = pad + le * HOP_SIZE - SEGMENT_SAMPLES;
		const paddedLen = SEGMENT_SAMPLES + pad + padEnd;
		const stftPadConst = FFT_SIZE / 2;
		const stftLenConst = paddedLen + FFT_SIZE;
		const nbBinsConst = FFT_SIZE / 2 + 1;
		const nbFramesConst = Math.floor((stftLenConst - FFT_SIZE) / HOP_SIZE) + 1;
		const xBinsConst = nbBinsConst - 1;
		const xFramesConst = nbFramesConst - 4;

		const freqRealBuffers: Array<Float32Array> = [];
		const freqImagBuffers: Array<Float32Array> = [];

		for (let frame = 0; frame < nbFramesConst; frame++) {
			freqRealBuffers.push(new Float32Array(nbBinsConst));
			freqImagBuffers.push(new Float32Array(nbBinsConst));
		}

		const workspace: StftWorkspace = {
			freqRealBuffers,
			freqImagBuffers,
			nbFrames: nbFramesConst,
			stftLen: stftLenConst,
			stftPad: stftPadConst,
			pad,
			xBins: xBinsConst,
			xFrames: xFramesConst,
		};

		// Per-channel segment ring (44.1 kHz inputs): SEGMENT_SAMPLES samples each.
		// Filled forward; slid left by `stride` each iteration.
		const segLeft = new Float32Array(SEGMENT_SAMPLES);
		const segRight = new Float32Array(SEGMENT_SAMPLES);
		let segFilled = 0;
		let inputExhausted = false;

		// OLA accumulators for the 4 stems × 2 output channels (8 buffers), plus a
		// `sumWeight` accumulator. All bounded by SEGMENT_SAMPLES. As "stable" samples
		// slide out the left edge each iteration, the accumulators shift left by
		// `stride` and the new contributions land in the right half.
		const stemAccum: Array<Float32Array> = [];

		for (let stem = 0; stem < STEM_OUTPUTS; stem++) stemAccum.push(new Float32Array(SEGMENT_SAMPLES));
		const sumWeight = new Float32Array(SEGMENT_SAMPLES);

		const { stems } = this.properties;
		const stemGains = [stems.drums, stems.bass, stems.other, stems.vocals];

		// `writerState` is declared above (next to `pumpDone` / `drainerDone`) so
		// the background drainer task can share the same `written` counter that
		// the direct (non-resample) path updates inline.

		const inv = 1 / (stats.std || 1);

		// === Main loop ===
		// Fill the segment ring, run inference, emit `stride` stable samples, drain
		// any available resampled output back to the buffer. Repeat until input is
		// exhausted; then emit the trailing partial segment + flush the OLA tail.
		for (;;) {
			// Fill the segment ring from segFilled..SEGMENT_SAMPLES by pulling 44.1 kHz
			// chunks (resampled if needed) and applying the global-stats normalization
			// inline.
			if (!inputExhausted) {
				while (segFilled < SEGMENT_SAMPLES) {
					const need = SEGMENT_SAMPLES - segFilled;
					const got = await pullNextChunkAt441({ buffer, pair, channels, frames: Math.min(need, CHUNK_FRAMES) });

					if (got === undefined || got[0].length === 0) {
						inputExhausted = true;
						break;
					}

					const left = got[0];
					const right = got[1];
					const frames = left.length;

					for (let index = 0; index < frames; index++) {
						segLeft[segFilled + index] = ((left[index] ?? 0) - stats.mean) * inv;
						segRight[segFilled + index] = ((right[index] ?? 0) - stats.mean) * inv;
					}

					segFilled += frames;
				}
			}

			if (segFilled === 0) break;

			const chunkLength = segFilled;
			const paddedLeft = reflectPad(segLeft, pad, padEnd, paddedLen);
			const paddedRight = reflectPad(segRight, pad, padEnd, paddedLen);
			const stftInputLeft = reflectPad(paddedLeft, stftPadConst, stftPadConst, stftLenConst);
			const stftInputRight = reflectPad(paddedRight, stftPadConst, stftPadConst, stftLenConst);
			const stftLeft = computeStftScaled(stftInputLeft);
			const stftRight = computeStftScaled(stftInputRight);

			const { inputData, xData } = buildModelInput(segLeft, segRight, stftLeft, stftRight, SEGMENT_SAMPLES, xBinsConst, xFramesConst);

			const result = this.session.run({
				input: { data: inputData, dims: [1, 2, SEGMENT_SAMPLES] },
				x: { data: xData, dims: [1, 4, xBinsConst, xFramesConst] },
			});

			const xtOut = result.add_67 ?? result[Object.keys(result).pop() ?? ""];
			const xOut = result.output ?? result[Object.keys(result)[0] ?? ""];

			// extractStems adds this segment's OLA contribution into stemAccum
			// starting at offset 0 (the leftmost of the rolling accumulator). Prior
			// segments' contributions are preserved.
			extractStems(xtOut, xOut, workspace, stemAccum, weight, 0, chunkLength, SEGMENT_SAMPLES);
			for (let index = 0; index < chunkLength; index++) {
				sumWeight[index] = (sumWeight[index] ?? 0) + (weight[index] ?? 0);
			}

			// On a non-final iteration we have a full segment and emit `stride` stable
			// samples; on the final iteration (input exhausted), we emit the entire
			// remaining segFilled samples.
			const isFinalIter = inputExhausted;
			const nStable = isFinalIter ? chunkLength : stride;

			await this.emitStable({
				nStable,
				stemAccum,
				sumWeight,
				stats,
				stemGains,
				pair,
				output,
				channels,
				sourceRate,
				bitDepth,
				originalFrames,
				writerState,
			});

			if (!isFinalIter) {
				// Slide ring left by stride so we can refill the right edge.
				segLeft.copyWithin(0, nStable, SEGMENT_SAMPLES);
				segRight.copyWithin(0, nStable, SEGMENT_SAMPLES);
				segLeft.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
				segRight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
				segFilled = SEGMENT_SAMPLES - nStable;
			} else {
				break;
			}
		}

		// The pump task should already be done by this point (we drained all of
		// resampleIn's output, which requires the pump to have closed stdin first).
		// Await defensively to surface any pump-side errors.
		await pumpDone;

		// Close output resampler stdin; wait for the drainer to finish copying
		// the tail into output.
		if (pair) {
			await pair.resampleOut.end();
		}

		await drainerDone;

		// Zero-pad if rate conversion produced fewer frames than the original input.
		await padTail(output, channels, originalFrames, writerState.written, sourceRate, bitDepth);
	}

	private async emitStable(args: {
		readonly nStable: number;
		readonly stemAccum: ReadonlyArray<Float32Array>;
		readonly sumWeight: Float32Array;
		readonly stats: { readonly mean: number; readonly std: number };
		readonly stemGains: ReadonlyArray<number>;
		readonly pair: StreamPair | undefined;
		readonly output: ChunkBuffer;
		readonly channels: number;
		readonly sourceRate: number;
		readonly bitDepth: number | undefined;
		readonly originalFrames: number;
		readonly writerState: { written: number };
	}): Promise<void> {
		const { nStable, stemAccum, sumWeight, stats, stemGains, pair, output, channels, sourceRate, bitDepth, originalFrames, writerState } = args;

		if (nStable <= 0) return;

		// De-normalise + mix stems into stereo at 44.1 kHz.
		const outLeft = new Float32Array(nStable);
		const outRight = new Float32Array(nStable);

		for (let index = 0; index < nStable; index++) {
			const sw = sumWeight[index] ?? 1;
			let mixedL = 0;
			let mixedR = 0;

			for (let stem = 0; stem < 4; stem++) {
				const gain = stemGains[stem] ?? 1;

				if (gain === 0) continue;

				const arrL = stemAccum[stem * 2];
				const arrR = stemAccum[stem * 2 + 1];

				if (arrL) mixedL += (sw === 0 ? 0 : (arrL[index] ?? 0) / sw) * gain;
				if (arrR) mixedR += (sw === 0 ? 0 : (arrR[index] ?? 0) / sw) * gain;
			}

			outLeft[index] = mixedL * stats.std + stats.mean;
			outRight[index] = mixedR * stats.std + stats.mean;
		}

		// Apply bandpass at 44.1 kHz (its native rate), per the original behaviour.
		bandpass([outLeft, outRight], HTDEMUCS_SAMPLE_RATE, this.properties.highPass, this.properties.lowPass);

		if (pair) {
			// Feed 44.1 kHz stable samples into resampleOut.stdin. The background
			// drainer task (see `drainResampleOutToBuffer`) reads stdout in parallel
			// and commits source-rate frames to `output`.
			await pair.resampleOut.write([outLeft, outRight]);
		} else {
			// Direct path — write 44.1 kHz stable samples to the output buffer at
			// the source channel count.
			const writeChannels = buildWriteChannels(outLeft, outRight, channels);
			const remaining = Math.max(0, originalFrames - writerState.written);

			if (remaining > 0) {
				const take = Math.min(nStable, remaining);
				const sliced = take === nStable ? writeChannels : writeChannels.map((channel) => channel.subarray(0, take));

				await output.write(sliced, sourceRate, bitDepth);
				writerState.written += take;
			}
		}

		// Shift stem accumulators + sumWeight left by nStable; zero the freed tail.
		for (let stem = 0; stem < STEM_OUTPUTS; stem++) {
			const arr = stemAccum[stem];

			if (!arr) continue;
			arr.copyWithin(0, nStable, SEGMENT_SAMPLES);
			arr.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
		}

		sumWeight.copyWithin(0, nStable, SEGMENT_SAMPLES);
		sumWeight.fill(0, SEGMENT_SAMPLES - nStable, SEGMENT_SAMPLES);
	}
}

// === Helpers ===

async function computeStreamingStats(buffer: ChunkBuffer, channels: number): Promise<{ readonly mean: number; readonly std: number }> {
	await buffer.reset();

	let sum = 0;
	let count = 0;

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const frames = chunk.samples[0]?.length ?? 0;

		if (frames === 0) break;

		// htdemucs's reference normalises over both channels jointly. When the
		// input is mono we treat channel 0 as both left and right to match the
		// reference's behaviour (which copies left to right before normalising).
		const left = chunk.samples[0];
		const right = channels >= 2 ? chunk.samples[1] : chunk.samples[0];

		if (left) {
			for (let index = 0; index < frames; index++) sum += left[index] ?? 0;
			count += frames;
		}

		if (right) {
			for (let index = 0; index < frames; index++) sum += right[index] ?? 0;
			count += frames;
		}

		if (frames < CHUNK_FRAMES) break;
	}

	const mean = count > 0 ? sum / count : 0;

	await buffer.reset();

	let variance = 0;
	let varCount = 0;

	for (;;) {
		const chunk = await buffer.read(CHUNK_FRAMES);
		const frames = chunk.samples[0]?.length ?? 0;

		if (frames === 0) break;

		const left = chunk.samples[0];
		const right = channels >= 2 ? chunk.samples[1] : chunk.samples[0];

		if (left) {
			for (let index = 0; index < frames; index++) {
				const diff = (left[index] ?? 0) - mean;

				variance += diff * diff;
			}

			varCount += frames;
		}

		if (right) {
			for (let index = 0; index < frames; index++) {
				const diff = (right[index] ?? 0) - mean;

				variance += diff * diff;
			}

			varCount += frames;
		}

		if (frames < CHUNK_FRAMES) break;
	}

	const std = varCount > 0 ? Math.sqrt(variance / varCount) || 1 : 1;

	return { mean, std };
}

/**
 * Pull up to `frames` of 44.1 kHz samples for the htdemucs segment loop. When
 * `pair` is set, reads from `resampleIn.stdout`; the producer side is handled
 * by a separate `pumpSourceToResampleIn` task running in parallel (see
 * `runMainPass`). Otherwise reads directly from the buffer at 44.1 kHz.
 *
 * Returns a `[left, right]` tuple of equal length, or `undefined` on
 * end-of-stream.
 */
async function pullNextChunkAt441(args: {
	readonly buffer: ChunkBuffer;
	readonly pair: StreamPair | undefined;
	readonly channels: number;
	readonly frames: number;
}): Promise<readonly [Float32Array, Float32Array] | undefined> {
	const { buffer, pair, channels, frames } = args;

	if (!pair) {
		const chunk = await buffer.read(frames);
		const got = chunk.samples[0]?.length ?? 0;

		if (got === 0) return undefined;

		const left = chunk.samples[0] ?? new Float32Array(got);
		const right = channels >= 2 ? (chunk.samples[1] ?? left) : left;

		return [left, right];
	}

	// Resample path: read directly from resampleIn.stdout. The pump task feeds
	// stdin in the background; read() blocks until ffmpeg produces output, then
	// returns up to `frames` of 44.1 kHz samples. `length === 0` signals
	// end-of-stream (ffmpeg drained its tail after the pump called `end()`).
	const out = await pair.resampleIn.read(frames);
	const got = out[0]?.length ?? 0;

	if (got === 0) return undefined;

	const left = out[0] ?? new Float32Array(got);
	const right = out[1] ?? left;

	return [left, right];
}

/**
 * Drain `buffer` (at sourceRate) into `resampleIn.stdin`, then call `end()`.
 * Runs as a background task in parallel with the main loop's reads from
 * `resampleIn.stdout`. ResampleStream handles per-write backpressure via its
 * internal `pendingDrain` promise, so a slow ffmpeg won't blow up Node's
 * memory.
 *
 * The resampler is always spawned with `channels: 2`; mono inputs are
 * duplicated to right so the segment loop sees a stable stereo stream.
 */
async function pumpSourceToResampleIn(args: {
	readonly buffer: ChunkBuffer;
	readonly resampleIn: ResampleStream;
	readonly channels: number;
	readonly chunkFrames: number;
}): Promise<void> {
	const { buffer, resampleIn, channels, chunkFrames } = args;

	for (;;) {
		const sourceChunk = await buffer.read(chunkFrames);
		const sourceFrames = sourceChunk.samples[0]?.length ?? 0;

		if (sourceFrames === 0) break;

		const sourceLeft = sourceChunk.samples[0] ?? new Float32Array(sourceFrames);
		const sourceRight = channels >= 2 ? (sourceChunk.samples[1] ?? sourceLeft) : sourceLeft;

		await resampleIn.write([sourceLeft, sourceRight]);

		if (sourceFrames < chunkFrames) break;
	}

	await resampleIn.end();
}

/**
 * Background drainer for the output resampler: continuously reads source-rate
 * samples from `resampleOut.stdout` and appends them to `output` (clamped to
 * `originalFrames` total). Terminates when `resampleOut.stdout` signals EOF,
 * which happens after the main loop calls `resampleOut.end()` and ffmpeg
 * drains its tail.
 */
async function drainResampleOutToBuffer(args: {
	readonly resampleOut: ResampleStream;
	readonly output: ChunkBuffer;
	readonly channels: number;
	readonly sourceRate: number;
	readonly bitDepth: number | undefined;
	readonly originalFrames: number;
	readonly writerState: { written: number };
}): Promise<void> {
	const { resampleOut, output, channels, sourceRate, bitDepth, originalFrames, writerState } = args;

	for (;;) {
		const chunk = await resampleOut.read(RESAMPLE_DRAIN_CHUNK);
		const got = chunk[0]?.length ?? 0;

		if (got === 0) return; // EOF

		await commitResampledFrames({ chunk, channels, output, sourceRate, bitDepth, originalFrames, writerState });
	}
}

async function commitResampledFrames(args: {
	readonly chunk: ReadonlyArray<Float32Array>;
	readonly channels: number;
	readonly output: ChunkBuffer;
	readonly sourceRate: number;
	readonly bitDepth: number | undefined;
	readonly originalFrames: number;
	readonly writerState: { written: number };
}): Promise<void> {
	const { chunk, channels, output, sourceRate, bitDepth, originalFrames, writerState } = args;
	const firstChannel = chunk[0];
	const got = firstChannel?.length ?? 0;

	if (got === 0 || !firstChannel) return;

	const remaining = originalFrames - writerState.written;

	if (remaining <= 0) return;

	const take = Math.min(got, remaining);
	const right = chunk[1] ?? firstChannel;
	const writeLeft = take === got ? firstChannel : firstChannel.subarray(0, take);
	const writeRight = take === got ? right : right.subarray(0, take);

	const writeChannels = buildWriteChannels(writeLeft, writeRight, channels);

	await output.write(writeChannels, sourceRate, bitDepth);
	writerState.written += take;
}

function buildWriteChannels(left: Float32Array, right: Float32Array, channels: number): Array<Float32Array> {
	const out: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) {
		if (channel === 0) out.push(left);
		else if (channel === 1) out.push(right);
		else out.push(left);
	}

	return out;
}

async function padTail(output: ChunkBuffer, channels: number, originalFrames: number, written: number, sourceRate: number, bitDepth: number | undefined): Promise<void> {
	if (written >= originalFrames) return;

	const missing = originalFrames - written;
	const padChannels: Array<Float32Array> = [];

	for (let channel = 0; channel < Math.max(1, channels); channel++) {
		padChannels.push(new Float32Array(missing));
	}

	await output.write(padChannels, sourceRate, bitDepth);
}

export class HtdemucsNode extends TransformNode<HtdemucsProperties> {
	static override readonly moduleName = "HTDemucs (Stem Separator)";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Rebalance stem volumes using HTDemucs source separation";
	static override readonly schema = schema;
	static override is(value: unknown): value is HtdemucsNode {
		return TransformNode.is(value) && value.type[2] === "htdemucs";
	}

	override readonly type = ["buffered-audio-node", "transform", "htdemucs"] as const;

	constructor(properties: HtdemucsProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	override createStream(): HtdemucsStream {
		return new HtdemucsStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<HtdemucsProperties>): HtdemucsNode {
		return new HtdemucsNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function htdemucs(
	modelPath: string,
	stems: Partial<StemGains>,
	options?: {
		ffmpegPath?: string;
		onnxAddonPath?: string;
		id?: string;
	},
): HtdemucsNode {
	const parsed = schema.parse({
		modelPath,
		ffmpegPath: options?.ffmpegPath,
		onnxAddonPath: options?.onnxAddonPath,
	});

	return new HtdemucsNode({
		...parsed,
		stems: {
			vocals: stems.vocals ?? 1,
			drums: stems.drums ?? 1,
			bass: stems.bass ?? 1,
			other: stems.other ?? 1,
		},
		id: options?.id,
	});
}
