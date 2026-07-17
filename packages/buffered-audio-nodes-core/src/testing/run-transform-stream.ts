import type { BufferedAudioNode } from "../node";
import type { BufferedStream, StreamContext, StreamIdentity, StreamSetupContext } from "../node/stream";
import type { Block } from "../node/stream/block";
import { BufferedTransformStream } from "../node/stream/transform/buffered-transform";
import { UnbufferedTransformStream } from "../node/stream/transform/unbuffered-transform";
import { createTestSetupContext, createTestStreamContext } from "./contexts";
import { drainBlocks, readableFrom } from "./streams";

export interface CapturedEvent {
	kind: "started" | "progress" | "log" | "finished";
	identity: StreamIdentity;
	payload: unknown;
}

export async function runTransformStream(
	node: BufferedAudioNode,
	blocks: Array<Block>,
	options?: { setup?: Partial<StreamSetupContext> },
): Promise<{ blocks: Array<Block>; events: Array<CapturedEvent> }> {
	const { context, events } = createTestStreamContext();
	const captured: Array<CapturedEvent> = [];

	events.on("started", (identity, payload) => captured.push({ kind: "started", identity, payload }));
	events.on("progress", (identity, payload) => captured.push({ kind: "progress", identity, payload }));
	events.on("log", (identity, payload) => captured.push({ kind: "log", identity, payload }));
	events.on("finished", (identity, payload) => captured.push({ kind: "finished", identity, payload }));

	const constructor = node.constructor as typeof BufferedAudioNode;
	const Stream = constructor.Stream as new (node: BufferedAudioNode, context: StreamContext) => BufferedStream;
	const stream = new Stream(node, context);

	if (!(stream instanceof BufferedTransformStream || stream instanceof UnbufferedTransformStream)) {
		throw new Error(`runTransformStream: node "${constructor.nodeName}" did not produce a transform stream`);
	}

	const setupContext = createTestSetupContext({
		sourceSampleRate: blocks[0]?.sampleRate ?? 44100,
		sampleRate: blocks[0]?.sampleRate ?? 44100,
		...options?.setup,
	});

	const output = await stream.setup(readableFrom(blocks), setupContext);
	const drained = await drainBlocks(output);

	for (const block of drained) {
		if (block.sampleRate !== setupContext.sampleRate) {
			throw new Error(
				`runTransformStream: node "${constructor.nodeName}" emitted ${block.sampleRate} Hz where ${setupContext.sampleRate} Hz was declared — a rate-changing stream must assign context.sampleRate in _setup`,
			);
		}
	}

	return { blocks: drained, events: captured };
}
