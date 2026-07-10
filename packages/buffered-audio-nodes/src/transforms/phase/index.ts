import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../package-metadata";
import { applyAllpass, invertSamples, phaseCoefficient } from "./utils/phase-shift";

export const schema = z.object({
	invert: z.boolean().default(true).describe("Invert"),
	angle: z.number().min(-180).max(180).multipleOf(1).optional().describe("Angle"),
});

export interface PhaseProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class PhaseStream extends UnbufferedTransformStream<PhaseNode> {
	private allpassState: Array<number> = [];

	override *_transform(chunk: Block): Generator<Block> {
		const { invert, angle } = this.properties;

		if (angle !== undefined) {
			yield this.applyPhaseRotation(chunk, angle);

			return;
		}

		if (invert) {
			yield this.applyInvert(chunk);

			return;
		}

		yield chunk;
	}

	private applyInvert(chunk: Block): Block {
		return { samples: invertSamples(chunk.samples), offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}

	private applyPhaseRotation(chunk: Block, angle: number): Block {
		const coefficient = phaseCoefficient(angle);

		while (this.allpassState.length < chunk.samples.length) {
			this.allpassState.push(0);
		}

		const samples = chunk.samples.map((channel, ch) => {
			const { output, state } = applyAllpass(channel, coefficient, this.allpassState[ch] ?? 0);

			this.allpassState[ch] = state;

			return output;
		});

		return { samples, offset: chunk.offset, sampleRate: chunk.sampleRate, bitDepth: chunk.bitDepth };
	}
}

export class PhaseNode extends TransformNode<PhaseProperties> {
	static override readonly nodeName = "Phase";
	static override readonly packageName = PACKAGE_NAME;
	static override readonly packageVersion = PACKAGE_VERSION;
	static override readonly description = "Invert or rotate signal phase";
	static override readonly schema = schema;
	static override readonly Stream = PhaseStream;
}

export function phase(options?: { invert?: boolean; angle?: number; id?: string }): PhaseNode {
	return new PhaseNode(options ?? {});
}

export function invert(options?: { id?: string }): PhaseNode {
	return phase({ invert: true, id: options?.id });
}
