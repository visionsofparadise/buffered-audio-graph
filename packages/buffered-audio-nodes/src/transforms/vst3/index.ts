import {
	BufferedTransformStream,
	createProgressGate,
	UnbufferedTransformStream,
	TransformNode,
	WHOLE_FILE,
	type Block,
	type BlockBuffer,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { startProcessLivenessMonitor, type ProcessLivenessOptions } from "../../utils/process-liveness";
import {
	processStreamingThroughVstHost,
	spawnVstHostReady,
	terminateVstHost,
	writeStagesJson,
	type VstHostHandle,
	type VstStage,
} from "./utils/process";

const stageSchema = z.object({
	pluginPath: z.string().meta({ input: "file", mode: "open", accept: ".vst3" }).describe("VST3 plugin file or bundle"),
	pluginName: z
		.string()
		.optional()
		.describe("Sub-plugin name when pluginPath is a multi-plugin shell (e.g. WaveShell)"),
	presetPath: z
		.string()
		.optional()
		.meta({ input: "file", mode: "open", accept: ".vstpreset" })
		.describe("Optional .vstpreset state file applied after the plugin loads"),
});

export const schema = z.object({
	vstHostPath: z
		.string()
		.default("")
		.meta({
			input: "file",
			mode: "open",
			binary: "vst-host",
			download: "https://github.com/visionsofparadise/vst-host",
		})
		.describe("vst-host — Pedalboard-based VST3 host CLI"),
	stages: z
		.array(stageSchema)
		.min(1)
		.describe("Ordered chain of plugin/preset stages — processed end-to-end inside one Pedalboard offline call"),
	bypass: z.boolean().default(false).describe("Pass audio through unchanged (no subprocess spawn)"),
});

export interface Vst3Properties extends TransformNodeProperties {
	readonly vstHostPath: string;
	readonly stages: ReadonlyArray<VstStage>;
	readonly bypass?: boolean;
	/**
	 * test-only: spawn `node <stub>` by passing `node` as vstHostPath + [stub] here.
	 */
	readonly extraArgs?: ReadonlyArray<string>;
	/**
	 * test-only: override the 30000 ms monitor interval so heavy tests can force ticks.
	 */
	readonly monitorIntervalMs?: number;
	/**
	 * test-only: replace process-tree sampling so heavy tests can drive monitor outcomes.
	 */
	readonly monitorSampler?: ProcessLivenessOptions["sampler"];
}

export class Vst3PassthroughStream<P extends Vst3Properties = Vst3Properties> extends UnbufferedTransformStream<
	Vst3Node<P>
> {
	override *_transform(block: Block): Generator<Block> {
		yield block;
	}
}

export class Vst3Stream<P extends Vst3Properties = Vst3Properties> extends BufferedTransformStream<Vst3Node<P>> {
	override blockSize = WHOLE_FILE;

	private streamContext?: StreamSetupContext;
	private stagesJsonPath?: string;
	private activeHost?: VstHostHandle;

	override async _setup(context: StreamSetupContext): Promise<void> {
		this.streamContext = context;

		this.stagesJsonPath = await writeStagesJson(this.properties.stages, context.temporaryDirectory);
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		if (!this.streamContext) throw new Error("Vst3Stream._transform called before setup()");

		if (!this.stagesJsonPath) throw new Error("Vst3Stream._transform called without a stages JSON file");

		if (buffered.frames === 0) return;

		const channels = buffered.channels;
		const sampleRate = this.sampleRate ?? 44100;
		const bd = buffered.bitDepth;
		const inputGate = createProgressGate(buffered.frames);
		const outputGate = createProgressGate(buffered.frames);

		const args: Array<string> = [
			...(this.properties.extraArgs ?? []),
			"--stages-json",
			this.stagesJsonPath,
			"--sample-rate",
			String(sampleRate),
			"--channels",
			String(channels),
		];

		const handle = await spawnVstHostReady(this.properties.vstHostPath, args, {
			signal: this.streamContext.signal,
			onRetry: (failedAttempt, error) => {
				this.log("vst-host init crash, retrying", { attempt: failedAttempt, error: error.message }, "warn");
			},
		});

		this.activeHost = handle;

		const stopMonitor =
			handle.proc.pid === undefined
				? undefined
				: startProcessLivenessMonitor(
						handle.proc.pid,
						(sample) => {
							this.log("vst-host liveness", { ...sample }, sample.state === "idle" ? "warn" : "info");
						},
						{
							intervalMs: this.properties.monitorIntervalMs,
							sampler: this.properties.monitorSampler,
							onError: (error) => {
								this.log("vst-host liveness sample failed", { error: String(error) }, "warn");
							},
						},
					);

		try {
			await processStreamingThroughVstHost(handle, buffered, {
				channelCount: channels,
				sampleRate,
				bitDepth: bd,
				signal: this.streamContext.signal,
				onInputProgress: (progress) => {
					if (inputGate(progress.framesDone, Date.now())) {
						this.log("vst-host input", {
							framesDone: progress.framesDone,
							framesTotal: progress.framesTotal,
							bytesDone: progress.bytesDone,
							bytesTotal: progress.bytesTotal,
						});
					}
				},
				onOutputProgress: (progress) => {
					if (outputGate(progress.framesDone, Date.now())) {
						this.log("vst-host output", {
							framesDone: progress.framesDone,
							framesTotal: progress.framesTotal,
							bytesDone: progress.bytesDone,
							bytesTotal: progress.bytesTotal,
						});
					}
				},
			});
		} finally {
			try {
				await stopMonitor?.();
			} finally {
				try {
					await terminateVstHost(handle);
				} finally {
					if (this.activeHost === handle) this.activeHost = undefined;
				}
			}
		}

		await buffered.reset();

		yield* buffered.iterate(44100);
	}

	override async _destroy(): Promise<void> {
		const activeHost = this.activeHost;

		this.activeHost = undefined;
		this.stagesJsonPath = undefined;

		if (activeHost) await terminateVstHost(activeHost);
	}
}

export class Vst3Node<P extends Vst3Properties = Vst3Properties> extends TransformNode<P> {
	static override readonly nodeName: string = "VST3";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description: string =
		"Host a chain of VST3 effect plugins via Pedalboard (whole-file offline mode)";
	static override readonly schema: z.ZodType = schema;
	static override readonly Stream = Vst3Stream;
}

export function vst3(options: {
	vstHostPath: string;
	stages: ReadonlyArray<VstStage>;
	bypass?: boolean;
	id?: string;
	extraArgs?: ReadonlyArray<string>;
	monitorIntervalMs?: number;
	monitorSampler?: ProcessLivenessOptions["sampler"];
}): Vst3Node {
	return new Vst3Node({
		vstHostPath: options.vstHostPath,
		stages: options.stages,
		bypass: options.bypass,
		id: options.id,
		extraArgs: options.extraArgs,
		monitorIntervalMs: options.monitorIntervalMs,
		monitorSampler: options.monitorSampler,
	});
}

export type { VstStage };
