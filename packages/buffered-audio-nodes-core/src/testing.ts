import { EventEmitter } from "node:events";
import type { Block } from "./block-buffer";
import { BufferedTransformStream } from "./buffered-transform";
import type { BufferedAudioNode } from "./node";
import type { BufferedStream, RenderEvents, StreamContext, StreamIdentity, StreamSetupContext } from "./stream";
import { UnbufferedTransformStream } from "./unbuffered-transform";

export function createBlock(value: number, offset: number, frames: number, options?: { channels?: number; sampleRate?: number; bitDepth?: number }): Block {
	const channels = options?.channels ?? 1;
	const samples: Array<Float32Array> = [];

	for (let channel = 0; channel < channels; channel++) samples.push(new Float32Array(frames).fill(value));

	return { samples, offset, sampleRate: options?.sampleRate ?? 44100, bitDepth: options?.bitDepth ?? 32 };
}

export function blockFromSamples(samples: Array<Float32Array>, offset: number, options?: { sampleRate?: number; bitDepth?: number }): Block {
	return { samples, offset, sampleRate: options?.sampleRate ?? 44100, bitDepth: options?.bitDepth ?? 32 };
}

export function readableFrom(blocks: Array<Block>): ReadableStream<Block> {
	let index = 0;

	return new ReadableStream<Block>({
		pull: (controller) => {
			const block = blocks[index];

			if (block) {
				index += 1;
				controller.enqueue(block);
			} else {
				controller.close();
			}
		},
	});
}

export async function drainBlocks(readable: ReadableStream<Block>): Promise<Array<Block>> {
	const out: Array<Block> = [];
	const reader = readable.getReader();

	for (;;) {
		const { done, value } = await reader.read();

		if (done) break;

		out.push(value);
	}

	return out;
}

export function channelSamples(blocks: Array<Block>, channel: number): Float32Array {
	const total = blocks.reduce((sum, block) => sum + (block.samples[channel]?.length ?? 0), 0);
	const out = new Float32Array(total);
	let offset = 0;

	for (const block of blocks) {
		const samples = block.samples[channel];

		if (!samples) continue;

		out.set(samples, offset);
		offset += samples.length;
	}

	return out;
}

export function createTestSetupContext(overrides?: Partial<StreamSetupContext>): StreamSetupContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16, ...overrides };
}

export function createTestStreamContext(): { context: StreamContext; events: RenderEvents } {
	const events: RenderEvents = new EventEmitter();
	let counter = 0;

	return { events, context: { events, nextStreamId: () => counter++ } };
}

export interface CapturedEvent {
	kind: "started" | "progress" | "log" | "finished";
	identity: StreamIdentity;
	payload: unknown;
}

export async function runTransformStream(node: BufferedAudioNode, blocks: Array<Block>, options?: { setup?: Partial<StreamSetupContext> }): Promise<{ blocks: Array<Block>; events: Array<CapturedEvent> }> {
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

	const output = await stream.setup(readableFrom(blocks), createTestSetupContext(options?.setup));

	return { blocks: await drainBlocks(output), events: captured };
}
