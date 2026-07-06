import { z } from "zod";
import { BufferedTransformStream, UnbufferedTransformStream, TransformNode, WHOLE_FILE, type Block, type BlockBuffer, type StreamContext, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { processStreamingThroughVstHost, spawnVstHostReady, writeStagesJson, type VstStage } from "./utils/process";

export const stageSchema = z.object({
	pluginPath: z
		.string()
		.meta({ input: "file", mode: "open", accept: ".vst3" })
		.describe("VST3 plugin file or bundle"),
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
		.meta({ input: "file", mode: "open", binary: "vst-host", download: "https://github.com/visionsofparadise/vst-host" })
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
	// test-only: spawn `node <stub>` by passing `node` as vstHostPath + [stub] here.
	readonly extraArgs?: ReadonlyArray<string>;
}

export class Vst3PassthroughStream<P extends Vst3Properties = Vst3Properties> extends UnbufferedTransformStream<P> {
	override transform(block: Block, enqueue: (block: Block) => void): void {
		// Bypass: pass audio through unchanged (no subprocess spawn).
		enqueue(block);
	}
}

export class Vst3Stream<P extends Vst3Properties = Vst3Properties> extends BufferedTransformStream<P> {
	override blockSize = WHOLE_FILE;

	private streamContext?: StreamContext;
	private stagesJsonPath?: string;
	private stagesJsonCleanup?: () => Promise<void>;

	override async _setup(input: ReadableStream<Block>, context: StreamContext): Promise<ReadableStream<Block>> {
		this.streamContext = context;

		const { path, cleanup } = await writeStagesJson(this.properties.stages);

		this.stagesJsonPath = path;
		this.stagesJsonCleanup = cleanup;

		return super._setup(input, context);
	}

	override async transform(buffered: BlockBuffer, enqueue: (block: Block) => void): Promise<void> {
		if (!this.streamContext) throw new Error("Vst3Stream.transform called before setup()");
		if (!this.stagesJsonPath) throw new Error("Vst3Stream.transform called without a stages JSON file");

		if (buffered.frames === 0) return;

		const channels = buffered.channels;
		const sampleRate = this.sampleRate ?? 44100;
		const bd = buffered.bitDepth;

		const args: Array<string> = [
			...(this.properties.extraArgs ?? []),
			"--stages-json",
			this.stagesJsonPath,
			"--sample-rate",
			String(sampleRate),
			"--channels",
			String(channels),
		];

		// Retries the pre-READY init crash (Windows 0xC0000005 / exit 3221225477); see design-vst3.md (2026-06-01).
		const handle = await spawnVstHostReady(this.properties.vstHostPath, args, {
			onRetry: (failedAttempt, error) => {
				this.log("vst-host init crash, retrying", { attempt: failedAttempt, error: error.message }, "warn");
			},
		});

		await processStreamingThroughVstHost(handle, buffered, channels, sampleRate, bd);

		await buffered.reset();

		for await (const block of buffered.iterate(44100)) {
			enqueue(block);
		}
	}

	override async _destroy(): Promise<void> {
		const cleanup = this.stagesJsonCleanup;

		this.stagesJsonPath = undefined;
		this.stagesJsonCleanup = undefined;

		if (cleanup) {
			try {
				await cleanup();
			} catch {
				// Temp-file cleanup is best-effort.
			}
		}
	}
}

export class Vst3Node<P extends Vst3Properties = Vst3Properties> extends TransformNode<P> {
	static override readonly nodeName: string = "VST3";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly nodeDescription: string = "Host a chain of VST3 effect plugins via Pedalboard (whole-file offline mode)";
	static override readonly schema: z.ZodType = schema;
	static override readonly streamClass = Vst3Stream;
	static override is(value: unknown): value is Vst3Node {
		return TransformNode.is(value) && value.type[2] === "vst3";
	}

	override readonly type: ReadonlyArray<string> = ["buffered-audio-node", "transform", "vst3"];

	override clone(overrides?: Partial<P>): Vst3Node<P> {
		return new Vst3Node<P>({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function vst3(options: {
	vstHostPath: string;
	stages: ReadonlyArray<VstStage>;
	bypass?: boolean;
	id?: string;
	extraArgs?: ReadonlyArray<string>;
}): Vst3Node {
	return new Vst3Node({
		vstHostPath: options.vstHostPath,
		stages: options.stages,
		bypass: options.bypass,
		id: options.id,
		extraArgs: options.extraArgs,
	});
}

export type { VstStage };
