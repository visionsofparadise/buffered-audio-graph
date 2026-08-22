import { join } from "node:path";
import {
	UnbufferedTransformStream,
	TransformNode,
	type Block,
	type StreamSetupContext,
	type TransformNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { PACKAGE_NAME } from "../../package-metadata";
import { createFaustAddonPathField } from "../../utils/binary-fields";
import { loadFaustAddon, type FaustFactory, type FaustInstance } from "../../utils/faust-runtime";
import { resolveFaustDispatch, type FaustDispatch } from "./utils/dispatch";

const schema = z.object({
	code: z.string().min(1).describe('Faust DSP source; import("stdfaust.lib") is available'),
	faustAddonPath: createFaustAddonPathField(),
});

export interface FaustProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class FaustStream extends UnbufferedTransformStream<FaustNode> {
	private factory?: FaustFactory;
	private instances: Array<FaustInstance> = [];
	private numInputs = 0;
	private numOutputs = 0;
	private sampleRate = 0;
	private dispatch?: FaustDispatch;
	private dispatchChannels = 0;

	override _setup(context: StreamSetupContext): void {
		const addon = loadFaustAddon(this.properties.faustAddonPath);
		const stdlibDirectory = join(context.temporaryDirectory, "faust-stdlib");

		addon.extractStandardLibrary(stdlibDirectory);
		this.factory = addon.createFactory("bag", this.properties.code, [stdlibDirectory]);

		const probe = this.factory.createInstance();

		this.numInputs = probe.getNumInputs();
		this.numOutputs = probe.getNumOutputs();
		probe.dispose();
		this.sampleRate = Math.round(context.sampleRate);
	}

	override *_transform(block: Block): Generator<Block> {
		const channels = block.samples.length;
		const frames = block.samples[0]?.length ?? 0;
		const factory = this.factory;
		let dispatch = this.dispatch;

		if (!dispatch) {
			if (!factory) {
				throw new Error("Faust factory missing");
			}

			dispatch = resolveFaustDispatch(this.numInputs, this.numOutputs, channels);
			this.dispatch = dispatch;
			this.dispatchChannels = channels;

			const instanceCount = dispatch.mode === "single" ? 1 : channels;

			for (let index = 0; index < instanceCount; index++) {
				const instance = factory.createInstance();

				instance.init(this.sampleRate);
				this.instances.push(instance);
			}

			this.log("faust compiled", {
				numInputs: this.numInputs,
				numOutputs: this.numOutputs,
				mode: dispatch.mode,
				channels,
			});
		} else if (channels !== this.dispatchChannels) {
			throw new Error(
				`Faust resolved its dispatch against ${this.dispatchChannels} channels; this block has ${channels} channels`,
			);
		}

		const outputs = Array.from({ length: dispatch.outputChannels }, () => new Float32Array(frames));

		if (dispatch.mode === "single") {
			const instance = this.instances[0];

			if (!instance) {
				throw new Error("Faust instance missing");
			}

			instance.compute(frames, block.samples, outputs);
		} else {
			for (let index = 0; index < channels; index++) {
				const channel = block.samples[index];
				const output = outputs[index];
				const instance = this.instances[index];

				if (channel === undefined || output === undefined || !instance) {
					throw new Error("Faust per-channel compute missing channel, output, or instance");
				}

				instance.compute(frames, [channel], [output]);
			}
		}

		yield {
			samples: outputs,
			offset: block.offset,
			sampleRate: block.sampleRate,
			bitDepth: block.bitDepth,
		};
	}

	override _destroy(): void {
		try {
			for (const instance of this.instances) {
				instance.dispose();
			}
		} finally {
			this.instances = [];
			this.factory?.dispose();
			this.factory = undefined;
		}
	}
}

export class FaustNode extends TransformNode<FaustProperties> {
	static override readonly nodeName = "Faust";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly description = "Compile Faust DSP source and stream audio through JIT instances";
	static override readonly schema = schema;
	static override readonly Stream = FaustStream;
}

export function faust(options: { code: string; faustAddonPath?: string; id?: string }): FaustNode {
	return new FaustNode(options);
}
