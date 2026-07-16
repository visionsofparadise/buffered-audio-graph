import { EventEmitter } from "node:events";
import type { BufferedAudioNode } from "./node";
import type { BufferedStream, ExecutionProvider, RenderEvents, StreamContext, StreamSetupContext } from "./node/stream";
import type { Block } from "./node/stream/block";
import { BufferedSourceStream, type RenderTiming, type SourceNode } from "./node/stream/source";
import { BufferedTargetStream } from "./node/stream/target";
import { BufferedTransformStream } from "./node/stream/transform/buffered-transform";
import { UnbufferedTransformStream } from "./node/stream/transform/unbuffered-transform";
import { teeReadable } from "./utils/tee-readable";

const RENDER_LIVENESS_INTERVAL_MS = 30_000;

export interface RenderOptions {
	readonly chunkSize?: number;
	readonly highWaterMark?: number;
	readonly memoryLimit?: number;
	readonly signal?: AbortSignal;
	readonly executionProviders?: ReadonlyArray<ExecutionProvider>;
}

interface PlanNode {
	readonly node: BufferedAudioNode;
	readonly stream: BufferedStream;
	readonly children: Array<PlanNode>;
}

export class RenderJob {
	readonly events: RenderEvents = new EventEmitter();

	private readonly streamsMap = new Map<BufferedAudioNode, Array<BufferedStream>>();
	private readonly abortController = new AbortController();
	private readonly renderContext: StreamContext;

	private readonly root: PlanNode;
	private readonly sourceStream;

	private timingData?: RenderTiming;
	private started = false;

	constructor(
		source: SourceNode,
		private readonly options?: RenderOptions,
	) {
		let streamIdCounter = 0;

		this.renderContext = { events: this.events, nextStreamId: () => streamIdCounter++ };

		this.root = this.build(source, new Set<BufferedAudioNode>());

		const sourceStream = this.root.stream;

		if (!(sourceStream instanceof BufferedSourceStream)) {
			throw new Error("Source node did not produce a source stream");
		}

		this.sourceStream = sourceStream;
	}

	get streams(): ReadonlyMap<BufferedAudioNode, ReadonlyArray<BufferedStream>> {
		return this.streamsMap;
	}

	get timing(): RenderTiming | undefined {
		return this.timingData;
	}

	abort(): void {
		this.abortController.abort();
	}

	private build(node: BufferedAudioNode, path: Set<BufferedAudioNode>): PlanNode {
		if (path.has(node)) throw new Error("Cycle detected in node graph");

		path.add(node);

		const constructor = node.constructor as typeof BufferedAudioNode;
		const Stream = constructor.Stream as new (node: BufferedAudioNode, context: StreamContext) => BufferedStream;
		const stream = new Stream(node, this.renderContext);

		const existing = this.streamsMap.get(node);

		if (existing) {
			existing.push(stream);
		} else {
			this.streamsMap.set(node, [stream]);
		}

		const effective = this.effectiveChildren(node.children, path);

		if (effective.length === 0 && typeof (node as { to?: unknown }).to === "function") {
			const nodeName = (node.constructor as typeof BufferedAudioNode).nodeName;
			const suffix = node.id !== undefined ? `#${node.id}` : "";

			throw new Error(`Graph leaf "${nodeName}"${suffix} is not a target — every path must end in a target node`);
		}

		const children: Array<PlanNode> = [];

		for (const child of effective) {
			children.push(this.build(child, path));
		}

		path.delete(node);

		return { node, stream, children };
	}

	private effectiveChildren(children: ReadonlyArray<BufferedAudioNode>, path: Set<BufferedAudioNode>): Array<BufferedAudioNode> {
		const resolved: Array<BufferedAudioNode> = [];

		for (const child of children) {
			if (child.isBypassed) {
				if (path.has(child)) throw new Error("Cycle detected in node graph");

				resolved.push(...this.effectiveChildren(child.children, path));
			} else {
				resolved.push(child);
			}
		}

		return resolved;
	}

	async render(): Promise<void> {
		if (this.started) throw new Error("RenderJob is single-use; render() was already called");
		this.started = true;
		const renderCalledAt = performance.now();
		const livenessInterval = setInterval(() => {
			this.events.emit("liveness", { createdAt: Date.now(), elapsedMs: performance.now() - renderCalledAt });
		}, RENDER_LIVENESS_INTERVAL_MS);

		try {
			const meta = await this.sourceStream.getMetadata();

			const defaultProviders: ReadonlyArray<ExecutionProvider> = ["gpu", "cpu-native", "cpu"];
			const memoryLimit = this.options?.memoryLimit ?? 256 * 1024 * 1024;
			const stages = Math.max(1, this.countStreams());
			const chunkSize = this.options?.chunkSize ?? 128 * 1024;
			const bytesPerChunk = meta.channels * chunkSize * 4;
			const computedHighWaterMark = Math.max(1, Math.floor(memoryLimit / (stages * bytesPerChunk)));

			const context: StreamSetupContext = {
				executionProviders: this.options?.executionProviders ?? defaultProviders,
				memoryLimit,
				durationFrames: meta.durationFrames,
				highWaterMark: this.options?.highWaterMark ?? computedHighWaterMark,
				signal: this.signal(),
			};

			const start = performance.now();

			try {
				const readable = await this.sourceStream.setup(context);
				const promises = await this.wireChildren(this.root.children, readable, context);

				await Promise.all(promises);
			} finally {
				for (const streams of this.streamsMap.values()) {
					for (const stream of streams) {
						await stream.destroy();
					}
				}

				const totalMs = performance.now() - start;
				const audioDurationMs = meta.durationFrames !== undefined ? (meta.durationFrames / meta.sampleRate) * 1000 : 0;

				this.timingData = {
					totalMs,
					audioDurationMs,
					realTimeMultiplier: audioDurationMs > 0 ? audioDurationMs / totalMs : 0,
				};
			}
		} finally {
			clearInterval(livenessInterval);
		}
	}

	private async wireChildren(children: Array<PlanNode>, readable: ReadableStream<Block>, context: StreamSetupContext): Promise<Array<Promise<void>>> {
		const pairs = teeReadable(readable, children);

		const nested = await Promise.all(pairs.map(([branch, child]) => this.wire(child, branch, context)));

		return nested.flat();
	}

	private async wire(plan: PlanNode, input: ReadableStream<Block>, context: StreamSetupContext): Promise<Array<Promise<void>>> {
		const { stream } = plan;

		if (stream instanceof BufferedTargetStream) {
			return [stream.setup(input, context)];
		}

		if (stream instanceof BufferedTransformStream || stream instanceof UnbufferedTransformStream) {
			const output = await stream.setup(input, context);

			return this.wireChildren(plan.children, output, context);
		}

		throw new Error(`Unexpected stream type for node "${(plan.node.constructor as typeof BufferedAudioNode).nodeName}"`);
	}

	private countStreams(): number {
		let count = 0;

		for (const streams of this.streamsMap.values()) count += streams.length;

		return count;
	}

	private signal(): AbortSignal | undefined {
		if (!this.options?.signal) return this.abortController.signal;

		return AbortSignal.any([this.options.signal, this.abortController.signal]);
	}
}
