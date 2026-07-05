export interface WindowBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface FileChangedPayload {
	path: string;
	contentHash: string;
}

export interface AudioProgressPayload {
	jobId: string;
	nodeId: string;
	phase: string;
	framesDone: number;
	framesTotal?: number;
}

export interface MainEventMap {
	windowBoundsChanged: [windowBounds: WindowBounds];
	"file:changed": [payload: FileChangedPayload];
	"audio:progress": [payload: AudioProgressPayload];
}

export interface RendererEventMap {}
