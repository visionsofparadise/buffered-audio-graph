/* eslint-disable barrel-files/avoid-barrel-files */
export type { Composition } from "./node";
export type { FileInputMeta, NodeSchema } from "./node/schema";

export { BufferedAudioNode, type BufferedAudioNodeInput, type BufferedAudioNodeProperties } from "./node";
export {
	BufferedStream,
	type ExecutionProvider,
	type FinishedPayload,
	type LogPayload,
	type ProgressPayload,
	type RenderEvents,
	type RenderLivenessPayload,
	type StartedPayload,
	type StreamContext,
	type StreamIdentity,
	type StreamPhase,
	type StreamSetupContext,
} from "./node/stream";
export type { Block } from "./node/stream/block";
export { BufferedSourceStream, SourceNode, type RenderTiming, type SourceMetadata, type SourceNodeProperties } from "./node/stream/source";
export { BufferedTargetStream, TargetNode, type TargetNodeProperties } from "./node/stream/target";
export { TransformNode, type TransformNodeProperties } from "./node/stream/transform";
export { BufferedTransformStream, WHOLE_FILE } from "./node/stream/transform/buffered-transform";
export { UnbufferedTransformStream } from "./node/stream/transform/unbuffered-transform";
export { BlockBuffer } from "./node/stream/transform/utils/block-buffer";
export { ReverseBlockReader } from "./node/stream/transform/utils/reverse-block-reader";
export { createProgressGate, PROGRESS_MIN_INTERVAL_MS, PROGRESS_PERCENT_QUANTUM } from "./node/stream/utils/progress-gate";
export { RenderJob, type RenderOptions } from "./render-job";

export { createRenderJobs, type RenderGraphOptions } from "./graph/create-render-jobs";
export { validateGraphDefinition, type GraphDefinition, type GraphEdge, type GraphNode, type NodeRegistry } from "./graph/definition";
export { pack } from "./graph/pack";
export { substituteParameters } from "./graph/substitute-parameters";
export { unpack } from "./graph/unpack";

export { windowedIterate, type WindowedIterateOptions } from "./node/stream/transform/utils/windowed-iterate";
export { teeReadable } from "./utils/tee-readable";
