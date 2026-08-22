import type { SpeechSegment } from "./segments";

export class GateGain {
	private readonly segments: ReadonlyArray<SpeechSegment>;
	private readonly attackFrames: number;
	private readonly releaseFrames: number;
	private readonly floorGain: number;
	private cursor = 0;

	constructor(
		segments: ReadonlyArray<SpeechSegment>,
		options: { readonly attackFrames: number; readonly releaseFrames: number; readonly floorGain: number },
	) {
		this.segments = segments;
		this.attackFrames = options.attackFrames;
		this.releaseFrames = options.releaseFrames;
		this.floorGain = options.floorGain;
	}

	fill(gain: Float32Array, startFrame: number): void {
		while (this.cursor < this.segments.length) {
			const segment = this.segments[this.cursor];

			if (segment === undefined) break;

			if (segment.end + this.releaseFrames >= startFrame) break;

			this.cursor += 1;
		}

		for (let offset = 0; offset < gain.length; offset++) {
			gain[offset] = this.gainAt(startFrame + offset);
		}
	}

	private gainAt(frame: number): number {
		let sampleGain = this.floorGain;

		for (let segmentIndex = this.cursor; segmentIndex < this.segments.length; segmentIndex++) {
			const segment = this.segments[segmentIndex];

			if (segment === undefined) break;

			if (segment.start - this.attackFrames > frame) break;

			sampleGain = Math.max(sampleGain, this.gainOfSegment(segment, frame));
		}

		return sampleGain;
	}

	private gainOfSegment(segment: SpeechSegment, frame: number): number {
		const { start, end } = segment;
		const { attackFrames, releaseFrames, floorGain } = this;

		if (frame >= start && frame < end) return 1;

		if (attackFrames > 0 && frame >= start - attackFrames && frame < start) {
			const phase = (frame - (start - attackFrames)) / attackFrames;

			return raisedCosineGain(floorGain, 1, phase);
		}

		if (releaseFrames > 0 && frame >= end && frame <= end + releaseFrames) {
			const phase = (frame - end) / releaseFrames;

			return raisedCosineGain(1, floorGain, phase);
		}

		return floorGain;
	}
}

function raisedCosineGain(fromGain: number, toGain: number, phase: number): number {
	const mixed = 0.5 * (1 - Math.cos(Math.PI * phase));

	return fromGain + (toGain - fromGain) * mixed;
}
