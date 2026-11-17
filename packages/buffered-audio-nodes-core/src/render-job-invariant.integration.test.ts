import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SourceNode } from "./node/source";
import { BufferedSourceStream, type SourceMetadata, type SourceNodeProperties } from "./node/stream/source";
import { BufferedTargetStream, TargetNode, type TargetNodeProperties } from "./node/stream/target";
import {
	BufferedTransformStream,
	type BufferedTransformNodeProperties,
} from "./node/stream/transform/buffered-transform";
import { UnbufferedTransformStream } from "./node/stream/transform/unbuffered-transform";
import { TransformNode, type TransformNodeProperties } from "./node/transform";
import type { BufferedAudioNode } from "./node";
import type { Block } from "./node/stream/block";
import type { BlockBuffer } from "./node/stream/transform/utils/block-buffer";

// Each probed stream counts its own hook code in flight, from a hook's first statement to its last (a generator
// hook's finally included), and records a violation when _destroy runs with any of it in flight, when a hook
// starts after teardown began, or when render() settles with any of it still running.

interface Recorder {
	readonly violations: Array<string>;
	readonly probes: Array<Probe>;
}

class Probe {
	inFlight = 0;

	constructor(
		readonly name: string,
		private readonly recorder: Recorder,
	) {
		recorder.probes.push(this);
	}

	enter(hook: string, destroyed: boolean): void {
		if (destroyed) this.recorder.violations.push(`${this.name}: ${hook} started after teardown began`);

		this.inFlight += 1;
	}

	exit(): void {
		this.inFlight -= 1;
	}

	destroying(): void {
		if (this.inFlight > 0)
			this.recorder.violations.push(`${this.name}: _destroy ran with ${this.inFlight} hook(s) in flight`);
	}
}

const delay = (milliseconds: number): Promise<void> =>
	milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();

interface HookTiming {
	readonly delays?: ReadonlyArray<number>;
	readonly finallyDelays?: ReadonlyArray<number>;
	readonly failAt?: number;
}

const at = (values: ReadonlyArray<number> | undefined, call: number): number => values?.[call] ?? values?.at(-1) ?? 0;

interface ProbeProperties {
	readonly probe: Probe;
	readonly timing: HookTiming;
}

interface ProbeSourceProperties extends SourceNodeProperties, ProbeProperties {
	readonly blockCount: number;
	readonly blockFrames: number;
}

class ProbeSourceStream extends BufferedSourceStream<ProbeSource> {
	private reads = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		const { probe, timing, blockCount, blockFrames } = this.properties;
		const call = this.reads;

		this.reads += 1;
		probe.enter("_read", this.isDestroyed);

		try {
			await delay(at(timing.delays, call));

			if (timing.failAt === call) throw new Error(`${probe.name} read failed`);

			if (call >= blockCount) return undefined;

			return {
				samples: [new Float32Array(blockFrames).fill(call)],
				offset: call * blockFrames,
				sampleRate: 44100,
				bitDepth: 32,
			};
		} finally {
			probe.exit();
		}
	}

	override _destroy(): void {
		this.properties.probe.destroying();
	}
}

class ProbeSource extends SourceNode<ProbeSourceProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "probe-source";
	static override readonly schema = z.object({});
	static override readonly Stream = ProbeSourceStream;
}

interface ProbeTransformProperties extends TransformNodeProperties, ProbeProperties {}

class ProbeUnbufferedStream extends UnbufferedTransformStream<ProbeUnbuffered> {
	private calls = 0;

	override async *_transform(block: Block): AsyncGenerator<Block> {
		const { probe, timing } = this.properties;
		const call = this.calls;

		this.calls += 1;
		probe.enter("_transform", this.isDestroyed);

		try {
			await delay(at(timing.delays, call));

			if (timing.failAt === call) throw new Error(`${probe.name} transform failed`);

			yield block;
		} finally {
			await delay(at(timing.finallyDelays, call));
			probe.exit();
		}
	}

	override _destroy(): void {
		this.properties.probe.destroying();
	}
}

class ProbeUnbuffered extends TransformNode<ProbeTransformProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "probe-unbuffered";
	static override readonly schema = z.object({});
	static override readonly Stream = ProbeUnbufferedStream;
}

interface ProbeBufferedProperties extends BufferedTransformNodeProperties, ProbeProperties {}

class ProbeBufferedStream extends BufferedTransformStream<ProbeBuffered> {
	private prepares = 0;
	private batches = 0;

	override async _prepare(block: Block): Promise<Block> {
		const { probe, timing } = this.properties;
		const call = this.prepares;

		this.prepares += 1;
		probe.enter("_prepare", this.isDestroyed);

		try {
			await delay(at(timing.delays, call));

			if (timing.failAt === call) throw new Error(`${probe.name} prepare failed`);

			return block;
		} finally {
			probe.exit();
		}
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const { probe, timing } = this.properties;
		const call = this.batches;

		this.batches += 1;
		probe.enter("_transform", this.isDestroyed);

		try {
			yield* buffered.iterate(10);
		} finally {
			await delay(at(timing.finallyDelays, call));
			probe.exit();
		}
	}

	override _destroy(): void {
		this.properties.probe.destroying();
	}
}

class ProbeBuffered extends TransformNode<ProbeBufferedProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "probe-buffered";
	static override readonly schema = z.object({});
	static override readonly Stream = ProbeBufferedStream;
}

interface ProbeTargetProperties extends TargetNodeProperties, ProbeProperties {}

class ProbeTargetStream extends BufferedTargetStream<ProbeTarget> {
	private writes = 0;

	override async _write(): Promise<void> {
		const { probe, timing } = this.properties;
		const call = this.writes;

		this.writes += 1;
		probe.enter("_write", this.isDestroyed);

		try {
			await delay(at(timing.delays, call));

			if (timing.failAt === call) throw new Error(`${probe.name} write failed`);
		} finally {
			probe.exit();
		}
	}

	override async _close(): Promise<void> {
		const { probe } = this.properties;

		probe.enter("_close", this.isDestroyed);

		try {
			await delay(1);
		} finally {
			probe.exit();
		}
	}

	override _destroy(): void {
		this.properties.probe.destroying();
	}
}

class ProbeTarget extends TargetNode<ProbeTargetProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "probe-target";
	static override readonly schema = z.object({});
	static override readonly Stream = ProbeTargetStream;
}

type NodeSpec =
	| { readonly kind: "unbuffered"; readonly timing: HookTiming; readonly children: ReadonlyArray<NodeSpec> }
	| {
			readonly kind: "buffered";
			readonly blockSize: number;
			readonly timing: HookTiming;
			readonly children: ReadonlyArray<NodeSpec>;
	  }
	| { readonly kind: "target"; readonly timing: HookTiming };

interface GraphSpec {
	readonly blockCount: number;
	readonly blockFrames?: number;
	readonly source: HookTiming;
	readonly children: ReadonlyArray<NodeSpec>;
	readonly abortAt?: number;
	readonly highWaterMark: number;
}

function build(spec: NodeSpec, recorder: Recorder, name: string): BufferedAudioNode {
	const probe = new Probe(name, recorder);

	if (spec.kind === "target") return new ProbeTarget({ probe, timing: spec.timing });

	const node =
		spec.kind === "unbuffered"
			? new ProbeUnbuffered({ probe, timing: spec.timing })
			: new ProbeBuffered({ probe, timing: spec.timing, blockSize: spec.blockSize });

	spec.children.forEach((child, index) => node.to(build(child, recorder, `${name}.${String(index)}`) as TargetNode));

	return node;
}

async function renderGraph(spec: GraphSpec, timeoutMs = 3000): Promise<Array<string>> {
	const recorder: Recorder = { violations: [], probes: [] };
	const source = new ProbeSource({
		probe: new Probe("S", recorder),
		timing: spec.source,
		blockCount: spec.blockCount,
		blockFrames: spec.blockFrames ?? 10,
	});

	spec.children.forEach((child, index) => source.to(build(child, recorder, `S.${String(index)}`) as TargetNode));

	const controller = new AbortController();
	const render = source.createRenderJob({ highWaterMark: spec.highWaterMark, signal: controller.signal }).render();
	const abortTimer = spec.abortAt === undefined ? undefined : setTimeout(() => controller.abort(), spec.abortAt);
	let hangTimer: ReturnType<typeof setTimeout> | undefined;
	const settled = await Promise.race([
		render.then(
			() => "settled",
			() => "settled",
		),
		new Promise<string>((resolve) => {
			hangTimer = setTimeout(() => resolve("hung"), timeoutMs);
		}),
	]);

	clearTimeout(abortTimer);
	clearTimeout(hangTimer);

	if (settled === "hung") recorder.violations.push(`render did not settle within ${String(timeoutMs)} ms`);

	for (const probe of recorder.probes) {
		if (probe.inFlight > 0) recorder.violations.push(`${probe.name}: render settled with a hook in flight`);
	}

	return recorder.violations;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;

		let value = state;

		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function randomGraph(seed: number): GraphSpec {
	const random = mulberry32(seed);
	const int = (max: number): number => Math.floor(random() * (max + 1));
	const timing = (): HookTiming => ({
		delays: Array.from({ length: 4 }, () => int(8)),
		finallyDelays: Array.from({ length: 4 }, () => (random() < 0.3 ? int(12) : 0)),
		failAt: random() < 0.15 ? int(3) : undefined,
	});
	const node = (depth: number): NodeSpec => {
		if (depth >= 2 || random() < 0.35) return { kind: "target", timing: timing() };

		const children = Array.from({ length: 1 + int(1) }, () => node(depth + 1));

		return random() < 0.5
			? { kind: "unbuffered", timing: timing(), children }
			: { kind: "buffered", blockSize: 10 + 10 * int(2), timing: timing(), children };
	};

	return {
		blockCount: 3 + int(4),
		source: { delays: Array.from({ length: 8 }, () => int(5)), failAt: random() < 0.1 ? int(4) : undefined },
		children: Array.from({ length: 1 + int(1) }, () => node(0)),
		abortAt: random() < 0.5 ? int(40) : undefined,
		highWaterMark: 1 + int(1),
	};
}

describe("RenderJob teardown invariant", () => {
	it("tears down the upstream of a split only after its _transform finally ends", async () => {
		const violations = await renderGraph({
			blockCount: 6,
			source: {},
			children: [
				{
					kind: "unbuffered",
					timing: { finallyDelays: [300] },
					children: [
						{ kind: "target", timing: {} },
						{ kind: "target", timing: { delays: [400] } },
					],
				},
			],
			abortAt: 350,
			highWaterMark: 1,
		});

		expect(violations).toEqual([]);
	});

	it("tears down a buffered split upstream only after its in-flight _prepare ends", async () => {
		const violations = await renderGraph({
			blockCount: 6,
			blockFrames: 100,
			source: {},
			children: [
				{
					kind: "buffered",
					blockSize: 100,
					timing: { delays: [0, 300] },
					children: [
						{ kind: "target", timing: {} },
						{ kind: "target", timing: {} },
					],
				},
			],
			abortAt: 100,
			highWaterMark: 1,
		});

		expect(violations).toEqual([]);
	});

	it("holds for fuzzer seed 70, whose split ends in a branch whose write fails", async () => {
		// Seed 70 builds S → [buffered → target, buffered → buffered → [target, target whose second write fails]].
		expect(await renderGraph(randomGraph(70))).toEqual([]);
	});

	it("holds across seeded random graphs with delays, failures and aborts", async () => {
		const failures: Array<string> = [];

		for (let seed = 1; seed <= 60; seed += 1) {
			const violations = await renderGraph(randomGraph(seed));

			for (const violation of violations) failures.push(`seed ${String(seed)}: ${violation}`);
		}

		expect(failures).toEqual([]);
	}, 30_000);
});
