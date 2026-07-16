export interface Block {
	readonly samples: Array<Float32Array>;
	readonly offset: number;
	readonly sampleRate: number;
	readonly bitDepth: number;
}
