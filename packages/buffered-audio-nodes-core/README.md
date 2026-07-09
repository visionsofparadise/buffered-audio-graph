# @buffered-audio/core

Foundational protocol layer for the buffered-audio-nodes ecosystem: base classes, streaming architecture, graph format (BAG), and executor.

## Install

```sh
npm install @buffered-audio/core
```

## Overview

This package defines the abstractions that all buffered-audio-nodes packages build on. It is used by two audiences:

- **Node authors** extend `SourceNode`, `TransformNode`, or `TargetNode` (pairing each with a stream class) to create concrete audio processing modules.
- **Graph executors** use the BAG format (`pack`, `unpack`, `createRenderJobs`) to serialize, deserialize, and run audio processing pipelines.

Concrete node implementations live in separate packages (e.g. `@buffered-audio/nodes`). This package provides only the protocol layer and has a single runtime dependency: `zod`.

## Node Types

Nodes are pure configuration. They hold parameters, bypass state, identity, and schema metadata, and reference a stream class. They carry no per-render state, so they are safe to serialize, reuse across pipelines, and share between renders. Each node type names its stream class through a `static readonly Stream`, and the executor constructs one stream instance per node per render pass.

### SourceNode

Produces audio. Its stream class extends `BufferedSourceStream` and drives a `ReadableStream<Block>`. Call `source.createRenderJob(options?)` to build a `RenderJob` for the entire pipeline rooted at this source.

### TransformNode

Processes audio. Its stream class extends either `UnbufferedTransformStream` or `BufferedTransformStream` (see [Transform Streams](#transform-streams)), piping input `Block`s through to output.

### TargetNode

Consumes audio. Its stream class extends `BufferedTargetStream` and writes to a `WritableStream<Block>`, typically an output file or destination.

## Node Construction

The `BufferedAudioNode` base constructor is the single defaulting and validation site. It runs `schema.parse(properties ?? {})` and merges the parsed result over the input, so schema `.default()`s apply once, on every path — both the fluent factory and BAG `unpack` flow through it. The constructor accepts the input shape `BufferedAudioNodeInput<P>` (`Partial<P> & BufferedAudioNodeProperties`); parsing strips unknown keys and preserves the base keys `id`, `bypass`, and `children`. A schema failure throws with the node name and the Zod message.

Concrete nodes are pure static declaration — no methods. Each names four statics — `static readonly nodeName`, `static readonly description`, `static readonly schema`, `static readonly Stream` — plus `packageName`/`packageVersion` for serialization.

```ts
import { z } from "zod";
import { UnbufferedTransformStream, TransformNode, type Block, type TransformNodeProperties } from "@buffered-audio/core";

export const schema = z.object({
	gain: z.number().min(-60).max(24).default(0).describe("Gain (dB)"),
});

export interface GainProperties extends z.infer<typeof schema>, TransformNodeProperties {}

export class GainStream extends UnbufferedTransformStream<GainNode> {
	override *_transform(block: Block): Generator<Block> {
		const linear = Math.pow(10, this.properties.gain / 20);

		if (linear === 1) {
			yield block;

			return;
		}

		const samples = block.samples.map((channel) => channel.map((sample) => sample * linear));

		yield { samples, offset: block.offset, sampleRate: block.sampleRate, bitDepth: block.bitDepth };
	}
}

export class GainNode extends TransformNode<GainProperties> {
	static override readonly nodeName = "Gain";
	static override readonly packageName = "@buffered-audio/nodes";
	static override readonly packageVersion = "0.8.0";
	static override readonly description = "Adjust signal level by a fixed amount in dB";
	static override readonly schema = schema;
	static override readonly Stream = GainStream;
}

export function gain(options?: { gain?: number; id?: string }): GainNode {
	return new GainNode(options ?? {});
}
```

## Block

`Block` is the unit of audio flowing through the pipeline: per-channel samples carrying their stream position and format.

```ts
interface Block {
	readonly samples: Array<Float32Array>;  // one Float32Array per channel
	readonly offset: number;                // frame position in the stream
	readonly sampleRate: number;
	readonly bitDepth: number;
}
```

A frame is one multichannel sample step; `samples[channel][frame]` addresses a single value.

## Connecting Nodes

`.to()` connects a node downstream and returns void. It exists on `SourceNode` and `TransformNode`; `TargetNode` is always a leaf.

```ts
source.to(transform);
transform.to(target);

const job = source.createRenderJob();
await job.render();
```

Fan-out is multiple `.to()` calls from the same node — the executor branches the readable with `teeReadable()`. Fan-in (a node reached by several paths) instantiates that node's stream once per path; each instance is independent, which is safe because nodes carry no per-render state.

`.to()` also accepts a `Composition` — the `{ head, tail }` handle returned by `chain()` in the nodes package — and unwraps it to its `head`, so separately-built subgraphs compose. Core exports the `Composition` interface for typing; `chain()` itself lives in `@buffered-audio/nodes`.

## Render Jobs

A render runs in two phases. `source.createRenderJob(options?)` synchronously builds a `RenderJob` — it walks the graph from the source, constructs every stream, and allocates the event emitter, so subscription and stream inspection are guaranteed to precede the first event. `job.render()` then probes metadata, wires the pipeline, streams, and cleans up.

```ts
class RenderJob {
	readonly events: RenderEvents;
	readonly streams: ReadonlyMap<BufferedAudioNode, ReadonlyArray<BufferedStream>>;
	get timing(): RenderTiming | undefined;  // set after render() resolves
	abort(): void;
	render(): Promise<void>;                 // single-use; a second call throws
}
```

Construction resolves bypass and composites: a bypassed node contributes no stream and its children are visited in its place, and cycles throw. A node reached by fan-in appears in `streams` with one entry per path. `abort()` aborts an internal controller chained with `options.signal`; `timing` holds `{ totalMs, audioDurationMs, realTimeMultiplier }` once the render resolves.

`RenderOptions` are the caller-facing knobs: `{ chunkSize?, highWaterMark?, memoryLimit?, signal?, executionProviders? }`.

### Events

Subscribe on `job.events`, a typed `EventEmitter`. Each event carries the emitting node's `NodeIdentity` as its first argument, followed by a payload:

```ts
type RenderEvents = EventEmitter<{
	started: [NodeIdentity, StartedPayload];
	finished: [NodeIdentity, FinishedPayload];
	progress: [NodeIdentity, ProgressPayload];
	log: [NodeIdentity, LogPayload];
}>;
```

`NodeIdentity` is `{ nodeName, nodeId?, streamId }` — `streamId` is a per-job monotonic counter minted at stream construction, unique within a job even when two id-less nodes share a `nodeName`. Every payload carries `createdAt` (Unix ms, stamped at the emit site): `StartedPayload` is `{ createdAt }`, `ProgressPayload` is `{ phase, framesDone, framesTotal?, createdAt }` over the phases `"read" | "buffer" | "process" | "emit" | "write"`, `FinishedPayload` is `{ framesDone, processingMs?, createdAt }`, and `LogPayload` is `{ level, message, data?, createdAt }`. Streams emit progress on every call; a stream author paces emission with `createProgressGate` (see [Reporting from hooks](#reporting-from-hooks)), and consumers derive elapsed time from `createdAt`.

```ts
const job = source.createRenderJob();

job.events.on("progress", (node, { phase, framesDone, framesTotal }) => {
	console.log(`${node.nodeName} ${phase}: ${framesDone}/${framesTotal ?? "?"}`);
});
job.events.on("finished", (node, { processingMs }) => {
	console.log(`${node.nodeName} done in ${processingMs ?? 0}ms`);
});

await job.render();
```

## Streams

The executor constructs one stream per node per render via `new node.Stream(node, context)`, passing a `StreamRenderContext` (`{ events, startedAt, nextStreamId }`) the job builds once per render. Streams are mutable runtime objects holding processing state for a single pass; they are never reused. The base constructor mints the stream's `identity` (allocating a `streamId` from the context) and exposes `get properties()`, which reads through to `this.node.properties`. The node reference stays available on `this.node` for statics.

### `_destroy()`

`BufferedStream` provides `_destroy(): Promise<void> | void` (no-op base) for resource cleanup — file handles, subprocesses, ONNX sessions, FFT workspaces. The framework invokes it at each stream's own termination on every path (graceful end, error, cancel), and guarantees it runs at most once, so overrides must be idempotent. Because it fires on every path, cleanup that must not leak belongs here rather than in the graceful-only data hooks below.

### Source Streams

`BufferedSourceStream` has two abstract hooks:

- `getMetadata(): Promise<SourceMetadata>` — return `{ sampleRate, channels, durationFrames? }`. The job calls this first to compute backpressure and progress denominators.
- `_read(): Promise<Block | undefined>` — produce the next block, or `undefined` to signal end of stream. The framework owns the controller (enqueue, close, frame counting) and calls `_read()` repeatedly on pull.

### Target Streams

`BufferedTargetStream` has two abstract hooks:

- `_write(block: Block): Promise<void> | void` — consume each incoming block (write to disk, accumulate statistics, forward to a subprocess).
- `_close(): Promise<void> | void` — finalize on graceful end of stream (flush buffers, rewrite a WAV header). Graceful-path only; resource release goes in `_destroy()`.

## Transform Streams

Transform authoring splits along one question: does the node care about block size? The answer picks the base class.

### UnbufferedTransformStream

An instrumented pass-through with no accumulation and no block size — for per-block streaming transforms (gain, pan) and external pumps (ffmpeg) whose output cadence is decoupled from input.

- `_transform(block: Block): AsyncIterable<Block> | Iterable<Block>` (abstract) — a generator called once per incoming block. `yield` as many output blocks as you like; yield nothing to drop the input. Sync transforms may use a plain generator (`*_transform`).
- `_flush(): AsyncIterable<Block> | Iterable<Block>` (base yields nothing) — a generator that emits trailing output at graceful end of stream.

### BufferedTransformStream

Accumulates incoming blocks into a `BlockBuffer` until a full block is assembled, then hands the buffer to the author. For measure-then-apply DSP (normalize) and windowed processing. Its properties type is `BufferedTransformNodeProperties` — `TransformNodeProperties` plus optional `blockSize`/`streamChunkSize`.

- `blockSize: number` — the assembly size, read from `properties.blockSize`, defaulting to `WHOLE_FILE`. Positive integer or `WHOLE_FILE`; `0` throws in the constructor. In block mode the buffer holds exactly `blockSize` frames per firing (short only at end of stream); `WHOLE_FILE` fires once at end of stream with the whole signal.
- `_prepare(block: Block): Promise<Block> | Block` (identity base) — a transform on each incoming block before buffering. The framework writes the returned block into the buffer, so `_prepare` must be length-preserving. Use it to accumulate a streaming measurement (peak, LUFS) on the way in, or to reshape format.
- `_transform(buffered: BlockBuffer): AsyncIterable<Block>` — a generator that fires when a full block is assembled and once at end of stream with the trailing partial. Read the buffer and `yield` output blocks. Authors own output offsets: the framework never rewrites `offset`, it only counts emitted frames for progress and re-slices any yielded block larger than the output chunk size. The default drains the buffer unchanged (`yield* buffered.iterate(outputChunkSize)`), so a bare `BufferedTransformStream` is a valid barrier pass-through.
- `_flush(): AsyncIterable<Block> | Iterable<Block>` (base yields nothing) — a generator that emits trailing output at graceful end of stream, after the final `_transform` firing.

The framework serves the pull loop: each downstream pull advances the active `_transform` (or `_flush`) generator by one block, so production is paced by consumer demand. It clears the buffer after each batch and closes it in `_destroy()`. A measure-then-apply transform reads its accumulated statistic in `_transform`, then walks the buffer and applies it:

```ts
class NormalizeStream extends BufferedTransformStream<NormalizeNode> {
	override blockSize = WHOLE_FILE;

	private peak = 0;

	override _prepare(block: Block): Block {
		for (const channel of block.samples) {
			for (const sample of channel) this.peak = Math.max(this.peak, Math.abs(sample));
		}

		return block;  // length-preserving; the framework writes this to the buffer
	}

	override async *_transform(buffered: BlockBuffer): AsyncGenerator<Block> {
		const target = Math.pow(10, this.properties.ceiling / 20);
		const scale = this.peak > 0 ? target / this.peak : 1;

		for await (const block of buffered.iterate(44100)) {
			yield {
				samples: block.samples.map((channel) => channel.map((sample) => sample * scale)),
				offset: block.offset,
				sampleRate: block.sampleRate,
				bitDepth: block.bitDepth,
			};
		}
	}
}
```

### Setup and Piping

Both transform bases split wiring into two hooks. `_setup(context: StreamContext): Promise<void> | void` (no-op base) runs context-dependent initialization — open a subprocess, load an ONNX session, build an FFT workspace. `_pipe(input: ReadableStream<Block>): ReadableStream<Block>` (default: the pull-driven machine above) maps the input readable to the output readable; override it to compose inner streams by chaining their `_pipe()` calls (e.g. wrapping the core transform in resamplers). `StreamContext` carries `{ executionProviders, memoryLimit, durationFrames?, highWaterMark, signal? }`; it deliberately omits sample rate and channels, which streams read from the blocks themselves so upstream rate changes are honored.

### Reporting from hooks

Inside any hook, protected helpers report to the render's event stream. `this.emitProgress(phase, framesDone, framesTotal?)` emits a `progress` event on every call — pace it yourself with `createProgressGate(framesTotal?)`, which returns a `(framesDone, now) => boolean` that passes at most once per 1% bucket and no more often than every 10 s:

```ts
const gate = createProgressGate(totalFrames);

for (const framesDone of frameCounts) {
	if (gate(framesDone, Date.now())) this.emitProgress("process", framesDone, totalFrames);
}
```

`this.log(message, data?, level?)` emits a structured `log` event.

## BlockBuffer

`BlockBuffer` is the sequential, disk-spilling accumulator used by `BufferedTransformStream` and constructible by transforms needing scratch space. Data stays in memory until it exceeds ~10 MB, then spills to a temp file (unlinked on `close()`), so memory stays bounded regardless of source length. Access is strictly sequential — there is no offset-based random read, which makes the whole-source-`Float32Array` antipattern structurally impossible.

| Method | Behavior |
|---|---|
| `read(frames): Promise<Block>` | Pull the next N frames from the read cursor. Returns a short (possibly empty) block at end of buffer. |
| `iterate(frames): AsyncIterableIterator<Block>` | Yield successive `read(frames)` results including the trailing short block, then complete. An empty buffer yields nothing. |
| `write(samples, sampleRate?, bitDepth?): Promise<void>` | Append samples at the tail. Captures format on the first call and validates it thereafter. |
| `flushWrites(): Promise<void>` | Force pending writes to disk so subsequent reads see them. |
| `reset(): Promise<void>` | Rewind the read cursor; preserve data. |
| `clear(): Promise<void>` | Drop all data and reset cursors. |
| `setSampleRate(rate)` / `setBitDepth(depth)` | Override the captured format (resample, dither). |
| `openReverseReader(): Promise<ReverseBlockReader>` | Open a read-only reverse view over the buffer. |
| `close(): Promise<void>` | Release the temp file and reset state. |

Walk a buffer with `iterate` (or `read` in a loop until a short block). Transforms whose output differs in length, position, or rate from the input allocate a separate scratch `BlockBuffer`, stream output into it, `clear()` the source, then stream the scratch back.

### ReverseBlockReader

`openReverseReader()` returns a `ReverseBlockReader` — a borrowed, read-only view that walks the buffer end-to-start, delivering samples already in reverse time order. It exposes `read(frames)` and `iterate(frames)` (mirroring the forward API) plus `frames`/`channels` snapshotted at open. It holds its own file handle and must be `close()`d: a leaked handle blocks the parent buffer's `unlink()` on Windows. The source closes any still-open readers in `clear()`/`close()`, but wrap a reader in `try`/`finally` at the call site so it closes on throw.

## Graph Format (BAG)

BAG (Buffered Audio Graph) is a JSON format for serializing audio pipelines. A `GraphDefinition` contains:

- `id` — stable UUID identity, persistent across path changes
- `name` — graph name
- `nodes` — flat array of `{ id, packageName, packageVersion, nodeName, parameters?, options? }`
- `edges` — flat array of `{ from, to }` referencing node IDs

The flat nodes/edges shape represents DAGs directly. `GraphNode`, `GraphEdge`, and `GraphDefinition` are exported types.

### NodeRegistry

A two-level `Map<packageName, Map<nodeName, Constructor>>` mapping serialized references back to their classes:

```ts
const registry: NodeRegistry = new Map([
	["@buffered-audio/nodes", new Map([
		["read", ReadNode],
		["gain", GainNode],
		["write", WriteNode],
	])],
]);
```

### pack

Serialize live nodes into a `GraphDefinition`. Parameters are extracted through each node's schema, so serialization is self-maintaining as schemas evolve.

```ts
import { pack } from "@buffered-audio/core";

const definition = pack([source], { name: "my-graph" });
```

### unpack

Deserialize a `GraphDefinition` back into live node instances. Each node is constructed through its schema (defaults applied), then edges are wired with `.to()`. Returns the source nodes.

```ts
import { unpack } from "@buffered-audio/core";

const sources = unpack(definition, registry);
const job = sources[0].createRenderJob();
await job.render();
```

### createRenderJobs

Substitute parameters, unpack, and build one `RenderJob` per source in a single synchronous call. It returns the un-rendered jobs so callers can subscribe before starting; the caller renders them.

```ts
import { createRenderJobs } from "@buffered-audio/core";

const jobs = createRenderJobs(definition, registry, { memoryLimit: 512 * 1024 * 1024 });

for (const job of jobs) {
	job.events.on("finished", (node) => console.log(`${node.nodeName} done`));
}

await Promise.all(jobs.map((job) => job.render()));
```

`RenderGraphOptions` extends `RenderOptions` with `parameters?: Record<string, string>` for `{{name}}` template substitution, applied to a copy per call so the definition stays a durable template.

### validateGraphDefinition

Validate raw JSON against the BAG schema with Zod:

```ts
import { validateGraphDefinition } from "@buffered-audio/core";

const definition = validateGraphDefinition(JSON.parse(raw));
```

## Backpressure

`RenderJob` computes a `highWaterMark` from the pipeline stage count, channel count, and chunk size, bounded by a configurable `memoryLimit` (default 256 MB), and threads it to every stream through `StreamContext` for consistent backpressure across the pipeline. Whole-file transforms consume memory outside this budget but self-regulate through `BlockBuffer`'s disk spillover. An explicit `highWaterMark` in `RenderOptions` overrides the calculation.

## License

ISC
</content>
</invoke>
