import { z } from "zod";
import { BufferedTransformStream, TransformNode, type AudioChunk, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";

export const schema = z.object({
	invert: z.boolean().default(true).describe("Invert"),
	angle: z.number().min(-180).max(180).multipleOf(1).optional().describe("Angle"),
});

export interface PhaseProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class PhaseStream extends BufferedTransformStream<PhaseProperties> {
	private allpassState: Array<number> = [];

	override _unbuffer(chunk: AudioChunk): AudioChunk {
		const { invert, angle } = this.properties;

		if (angle !== undefined) {
			return this.applyPhaseRotation(chunk, angle);
		}

		if (invert) {
			return this.applyInvert(chunk);
		}

		return chunk;
	}

	private applyInvert(chunk: AudioChunk): AudioChunk {
		const samples = chunk.samples.map((channel) => {
			const output = new Float32Array(channel.length);

			for (let index = 0; index < channel.length; index++) {
				output[index] = -(channel[index] ?? 0);
			}

			return output;
		});

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}

	private applyPhaseRotation(chunk: AudioChunk, angle: number): AudioChunk {
		const radians = (angle * Math.PI) / 180;
		const coefficient = Math.tan((radians - Math.PI) / 4);

		while (this.allpassState.length < chunk.samples.length) {
			this.allpassState.push(0);
		}

		const samples = chunk.samples.map((channel, ch) => {
			const output = new Float32Array(channel.length);
			let state = this.allpassState[ch] ?? 0;

			for (let index = 0; index < channel.length; index++) {
				const input = channel[index] ?? 0;
				const allpassOut = coefficient * input + state;

				state = input - coefficient * allpassOut;
				output[index] = allpassOut;
			}

			this.allpassState[ch] = state;

			return output;
		});

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class PhaseNode extends TransformNode<PhaseProperties> {
	static override readonly moduleName = "Phase";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly moduleDescription = "Invert or rotate signal phase";
	static override readonly schema = schema;
	static override is(value: unknown): value is PhaseNode {
		return TransformNode.is(value) && value.type[2] === "phase";
	}

	override readonly type = ["buffered-audio-node", "transform", "phase"] as const;

	override createStream(): PhaseStream {
		return new PhaseStream({ ...this.properties, bufferSize: this.bufferSize, overlap: this.properties.overlap ?? 0 });
	}

	override clone(overrides?: Partial<PhaseProperties>): PhaseNode {
		return new PhaseNode({ ...this.properties, previousProperties: this.properties, ...overrides });
	}
}

export function phase(options?: { invert?: boolean; angle?: number; id?: string }): PhaseNode {
	return new PhaseNode({
		invert: options?.invert ?? true,
		angle: options?.angle,
		id: options?.id,
	});
}

export function invert(options?: { id?: string }): PhaseNode {
	return phase({ invert: true, id: options?.id });
}
