import type { StreamPhase } from "@buffered-audio/core";
import type { Vst3EditorEventPayload } from "../ipc/Vst3/Vst3EditorEvent";
import type { Vst3ScanEntry } from "../ipc/Vst3/Vst3ScanEntry";

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
	phase: StreamPhase;
	framesDone: number;
	framesTotal?: number;
}

export interface MainEventMap {
	windowBoundsChanged: [windowBounds: WindowBounds];
	"file:changed": [payload: FileChangedPayload];
	"audio:progress": [payload: AudioProgressPayload];
	"vst3:scanUpdate": [payload: { entries: Array<Vst3ScanEntry> }];
	"vst3:editorEvent": [payload: Vst3EditorEventPayload];
}

export interface RendererEventMap {}
