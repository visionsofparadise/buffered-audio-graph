import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BufferedTargetStream, TargetNode, WHOLE_FILE, type AudioChunk, type StreamContext, type TargetNodeProperties } from "@buffered-audio/core";
import { AmplitudeHistogramAccumulator, LoudnessAccumulator, TruePeakAccumulator } from "@buffered-audio/utils";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	bucketCount: z.number().int().positive().default(1024).describe("Amplitude histogram bucket count"),
	outputPath: z.string().default("").meta({ input: "file", mode: "save" }).describe("Output Path (JSON sidecar). Empty string disables file output."),
});

export interface LoudnessStatsProperties extends z.infer<typeof schema>, TargetNodeProperties {}

export interface AmplitudeDistribution {
	readonly buckets: Uint32Array;
	readonly bucketMax: number;
	readonly totalSamples: number;
	readonly median: number;
	percentile(p: number): number;
}

export interface LoudnessStats {
	readonly integrated: number;
	readonly truePeak: number;
	readonly range: number;
	readonly amplitude: AmplitudeDistribution;
}

export class LoudnessStatsStream extends BufferedTargetStream<LoudnessStatsProperties> {
	private channels = 0;
	private sampleRate = 0;
	private truePeakAccumulator: TruePeakAccumulator | undefined;
	private loudnessAccumulator: LoudnessAccumulator | undefined;
	private histogramAccumulator: AmplitudeHistogramAccumulator | undefined;
	private _stats?: LoudnessStats;
	private statsInitialized = false;
	private fileHandle?: FileHandle;

	get stats(): LoudnessStats | undefined {
		return this._stats;
	}

	override async _setup(input: ReadableStream<AudioChunk>, context: StreamContext): Promise<void> {
		// Eagerly open the sidecar file (matching the waveform target convention)
		// so an unwritable path fails fast rather than at close time. Empty string
		// disables the sidecar — programmatic API still works.
		if (this.properties.outputPath !== "") {
			this.fileHandle = await open(this.properties.outputPath, "w");
		}

		return super._setup(input, context);
	}

	private ensureInit(chunk: AudioChunk): void {
		if (this.statsInitialized) return;
		this.statsInitialized = true;
		this.channels = chunk.samples.length;
		this.sampleRate = chunk.sampleRate;

		this.truePeakAccumulator = new TruePeakAccumulator(this.sampleRate, this.channels);
		this.loudnessAccumulator = new LoudnessAccumulator(this.sampleRate, this.channels);
		this.histogramAccumulator = new AmplitudeHistogramAccumulator(this.properties.bucketCount);
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	override async _write(chunk: AudioChunk): Promise<void> {
		this.ensureInit(chunk);

		const frames = chunk.samples[0]?.length ?? 0;

		if (frames <= 0) return;

		this.loudnessAccumulator?.push(chunk.samples, frames);
		this.histogramAccumulator?.push(chunk.samples, frames);
		this.truePeakAccumulator?.push(chunk.samples, frames);
	}

	override async _close(): Promise<void> {
		const loudness = this.loudnessAccumulator?.finalize() ?? {
			integrated: -Infinity,
			range: 0,
		};
		const histogram = this.histogramAccumulator?.finalize() ?? {
			buckets: new Uint32Array(this.properties.bucketCount),
			bucketMax: 0,
			median: 0,
		};

		const truePeakLinear = this.truePeakAccumulator?.finalize() ?? 0;
		const truePeak = 20 * Math.log10(Math.max(truePeakLinear, 1e-10));

		const buckets = histogram.buckets;
		const bucketMax = histogram.bucketMax;
		const median = histogram.median;
		let totalSamples = 0;

		for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) totalSamples += buckets[bucketIndex] ?? 0;

		const percentile = (percent: number): number => {
			if (totalSamples === 0 || bucketMax === 0) return 0;

			const target = (percent / 100) * totalSamples;
			let cumulative = 0;

			for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
				const count = buckets[bucketIndex] ?? 0;
				const next = cumulative + count;

				if (next >= target) {
					const fractionIntoBucket = count > 0 ? (target - cumulative) / count : 0;
					const bucketWidth = bucketMax / buckets.length;

					return (bucketIndex + fractionIntoBucket) * bucketWidth;
				}

				cumulative = next;
			}

			return bucketMax;
		};

		const amplitude: AmplitudeDistribution = {
			buckets,
			bucketMax,
			totalSamples,
			median,
			percentile,
		};

		this._stats = {
			integrated: loudness.integrated,
			truePeak,
			range: loudness.range,
			amplitude,
		};

		if (this.fileHandle) {
			const serializable = {
				integrated: this._stats.integrated,
				truePeak: this._stats.truePeak,
				range: this._stats.range,
				amplitude: {
					buckets: Array.from(this._stats.amplitude.buckets),
					bucketMax: this._stats.amplitude.bucketMax,
					totalSamples: this._stats.amplitude.totalSamples,
					median: this._stats.amplitude.median,
				},
			};
			const payload = Buffer.from(JSON.stringify(serializable, null, 2), "utf8");

			await this.fileHandle.write(payload, 0, payload.length, 0);
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}
	}
}

export class LoudnessStatsNode extends TargetNode<LoudnessStatsProperties> {
	static override readonly moduleName = "Loudness Stats";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Measure integrated loudness, true peak, and loudness range per EBU R128, plus an amplitude-distribution histogram";
	static override readonly schema = schema;

	static override is(value: unknown): value is LoudnessStatsNode {
		return TargetNode.is(value) && value.type[2] === "loudness-stats";
	}

	override readonly type = ["buffered-audio-node", "target", "loudness-stats"] as const;

	private cachedStats?: LoudnessStats;

	constructor(properties: LoudnessStatsProperties) {
		super({ bufferSize: WHOLE_FILE, latency: WHOLE_FILE, ...properties });
	}

	get stats(): LoudnessStats | undefined {
		const last = this.streams[this.streams.length - 1];

		return last instanceof LoudnessStatsStream ? last.stats : this.cachedStats;
	}

	override _teardown(): void {
		const last = this.streams[this.streams.length - 1];

		if (last instanceof LoudnessStatsStream && last.stats) {
			this.cachedStats = last.stats;
		}
	}

	override createStream(): LoudnessStatsStream {
		return new LoudnessStatsStream(this.properties);
	}

	override clone(overrides?: Partial<LoudnessStatsProperties>): LoudnessStatsNode {
		return new LoudnessStatsNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function loudnessStats(options?: { id?: string; bucketCount?: number; outputPath?: string }): LoudnessStatsNode {
	return new LoudnessStatsNode({
		id: options?.id,
		bucketCount: options?.bucketCount ?? 1024,
		outputPath: options?.outputPath ?? "",
	});
}
