# @buffered-audio/core

Foundational protocol layer for the buffered-audio-nodes ecosystem: base classes, streaming architecture, graph format (BAG), and executor.

## Install

```sh
npm install @buffered-audio/core
```

## Overview

This package defines the abstractions that all buffered-audio-nodes packages build on. It is used by two audiences:

- **Node authors** extend `SourceNode`, `TransformNode`, or `TargetNode` to create concrete audio processing modules.
- **Graph executors** use the BAG format (`pack`, `unpack`, `renderGraph`) to serialize, deserialize, and run audio processing pipelines.

Concrete node implementations live in separate packages (e.g. `@buffered-audio/nodes`). This package provides only the protocol layer and has a single runtime dependency: `zod`.

## Node Types

Nodes are inert descriptors. They hold parameters, bypass state, and schema metadata. They are safe to serialize, reuse, and share. Each node type has a corresponding stream class that handles the actual runtime processing.

### SourceNode

Produces audio. Implements `createStream()` returning a `BufferedSourceStream` that provides a `ReadableStream<AudioChunk>`. Call `source.render(options?)` to execute the entire pipeline rooted at this source.

### TransformNode

Processes audio. Implements `createStream()` returning a `BufferedTransformStream` that pipes through a `TransformStream<AudioChunk, AudioChunk>`. Supports buffering modes via `bufferSize`.

### TargetNode

Consumes audio. Implements `createStream()` returning a `BufferedTargetStream` that writes to a `WritableStream<AudioChunk>`. Typically writes output to a file or destination.

### CompositeNode

Abstract base for multi-node compositions. Exposes `head` and `tail` properties to define the internal sub-graph. Calling `.to()` on a composite connects downstream from `tail`. If the head is a `SourceNode`, the composite can be rendered directly.

## Streams

Every render creates fresh stream instances via `node.createStream()`. Streams are mutable runtime objects that hold processing state for a single render pass. They are never reused.

```ts
class MyTransform extends TransformNode {
	readonly type = ["buffered-audio-node", "transform", "my-transform"] as const;

	createStream() {
		return new MyTransformStream(this.properties);
	}

	clone() {
		return new MyTransform(this.properties);
	}
}
```

Nodes connect with `.to()`:

```ts
source.to(transform);
transform.to(target);
await source.render();
```

Fan-out is supported by calling `.to()` multiple times from the same node.

## Stream Hooks

### Source Hooks

`BufferedSourceStream` provides three hooks:

#### `getMetadata(): Promise<SourceMetadata>`

Return the audio format: `{ sampleRate, channels, durationFrames? }`. Called before render to compute backpressure and pipeline context.

#### `_read(): Promise<AudioChunk | undefined>`

Produce the next chunk of audio. Return `undefined` to signal end of stream. Called repeatedly by the readable stream's pull mechanism.

#### `_flush(): Promise<void>`

Cleanup after the last chunk has been read. Close file handles, finalize readers.

### Target Hooks

`BufferedTargetStream` provides two hooks:

#### `_write(chunk: AudioChunk): Promise<void>`

Consume each incoming chunk. Write to disk, accumulate statistics, or forward to an external process.

#### `_close(): Promise<void>`

Finalize after the last chunk has been written. Flush buffers, close file handles, write headers.

### Transform Hooks

`BufferedTransformStream` provides four hooks for processing audio:

### `_buffer(chunk, buffer)`

Accumulate incoming audio into the `ChunkBuffer`. Default implementation calls `buffer.write(chunk.samples, chunk.sampleRate, chunk.bitDepth)`. Override to pre-process or filter chunks before buffering.

### `_process(buffer)`

Called when the buffer reaches the `bufferSize` threshold (or on flush for `WHOLE_FILE` mode). Read the buffer sequentially, transform, and write the result back. Not called when `bufferSize` is `0`.

### `_unbuffer(chunk)`

Transform individual chunks during emission. Called for every chunk read back from the buffer. Return `undefined` to drop a chunk.

### `_setup(input, context)`

Override for custom stream wiring. Default implementation pipes input through `createTransformStream()`. Use this to set up context-dependent resources before processing begins.

### `_teardown()`

Cleanup after render completes. Override to close file handles, free native resources, or release ONNX sessions. Called automatically on all streams after the pipeline finishes (whether it succeeds or fails). Defined on `BufferedStream` — available to all stream types, not just transforms.

### bufferSize Modes

| Value | Behavior |
|---|---|
| `0` | Pass-through. Chunks flow directly through `_buffer` then `_unbuffer`. `_process` is never called. |
| `N` | Block mode. Accumulate `N` frames, call `_process`, then emit. |
| `WHOLE_FILE` | Buffer all audio before processing. `_process` runs once on flush with the complete file. |

`ChunkBuffer` exposes only sequential access. Read with `buffer.read(N)` in a loop until the returned chunk is shorter than `N` (end-of-buffer); write with `buffer.write(samples, sampleRate, bitDepth)`. There is no offset-based random access — see the [ChunkBuffer](#chunkbuffer) section below.

Example transform that processes in 4096-frame blocks using the two-buffer pattern (stream the input into a temp buffer applying the transform, then swap the temp back into the framework's buffer):

```ts
const CHUNK_FRAMES = 4096;

class MyTransformStream extends BufferedTransformStream {
	constructor(properties: TransformNodeProperties) {
		super({ ...properties, bufferSize: 4096 });
	}

	override async _process(buffer: ChunkBuffer): Promise<void> {
		const sr = buffer.sampleRate;
		const bd = buffer.bitDepth;
		const output = new ChunkBuffer();

		try {
			for (;;) {
				const chunk = await buffer.read(CHUNK_FRAMES);
				const got = chunk.samples[0]?.length ?? 0;

				if (got === 0) break;
				const processed = doSomething(chunk.samples);

				await output.write(processed, sr, bd);
				if (got < CHUNK_FRAMES) break;
			}

			await buffer.clear();
			await output.reset();

			for (;;) {
				const chunk = await output.read(CHUNK_FRAMES);
				const got = chunk.samples[0]?.length ?? 0;

				if (got === 0) break;
				await buffer.write(chunk.samples, sr, bd);
				if (got < CHUNK_FRAMES) break;
			}
		} finally {
			await output.close();
		}
	}
}
```

For simple in-place transforms where `bufferSize` is small and bounded (so a single `buffer.read(buffer.frames)` is safe), drop the temp buffer: read everything in one call, process it, `buffer.clear()`, then `buffer.write(...)` the result. The two-buffer pattern is the general case — use it for transforms whose output differs in length, position, or rate from the input (pad/trim/reverse, ML segment streaming), or wherever a single bounded read isn't appropriate.

## Graph Format (BAG)

BAG (Buffered Audio Graph) is a JSON format for serializing audio processing pipelines. A `GraphDefinition` contains:

- `name` -- graph name
- `nodes` -- flat array of `{ id, packageName, nodeName, parameters?, options? }`
- `edges` -- flat array of `{ from, to }` referencing node IDs

### NodeRegistry

A two-level `Map<packageName, Map<nodeName, Constructor>>` that maps serialized node references back to their classes:

```ts
const registry: NodeRegistry = new Map([
	["@buffered-audio/nodes", new Map([
		["wav-source", WavSourceNode],
		["gain", GainNode],
		["wav-target", WavTargetNode],
	])],
]);
```

### pack

Serialize live nodes into a `GraphDefinition`:

```ts
import { pack } from "@buffered-audio/core";

const definition = pack([source], "my-graph");
```

### unpack

Deserialize a `GraphDefinition` back into live node instances:

```ts
import { unpack } from "@buffered-audio/core";

const sources = unpack(definition, registry);
await sources[0].render();
```

### renderGraph

Shorthand to unpack and render in one step:

```ts
import { renderGraph } from "@buffered-audio/core";

await renderGraph(definition, registry, { memoryLimit: 512 * 1024 * 1024 });
```

### validateGraphDefinition

Validates raw JSON against the BAG schema using Zod:

```ts
import { validateGraphDefinition } from "@buffered-audio/core";

const definition = validateGraphDefinition(JSON.parse(raw));
```

## ChunkBuffer

`ChunkBuffer` is the audio sample storage used internally by `BufferedTransformStream` and constructible by transforms that need their own scratch space. A single concrete class — data lives in an in-memory write batch until it exceeds a 10 MB threshold, at which point a temp file is lazily created and the batch flushes. Buffers whose total lifetime stays under 10 MB never touch disk; large buffers (e.g. `WHOLE_FILE` mode) auto-spill so memory stays bounded. The temp file is unlinked on `close()`.

### Sequential-only API

All access is sequential through internal cursors — there is no offset-based random access:

| Method | Behavior |
|---|---|
| `read(n): Promise<AudioChunk>` | Pull the next N frames from the forward read cursor. Returns a short chunk (possibly zero-length) at end of buffer. |
| `readReverse(n): Promise<AudioChunk>` | Same, advancing backward from the tail. |
| `write(samples, sampleRate?, bitDepth?): Promise<void>` | Append samples at the tail via the internal writer's batch. Capture or validate sample-rate/bit-depth on the first call. |
| `writeReverse(samples, sampleRate?, bitDepth?): Promise<void>` | Prepend samples at the head. |
| `flushWrites(): Promise<void>` | Force the in-flight write batch to disk so subsequent reads see it. |
| `reset(): Promise<void>` | Rewind cursors to their starting positions; preserve data. |
| `clear(): Promise<void>` | Drop all data and reset cursors. |
| `setSampleRate(rate)` / `setBitDepth(depth)` | Override the captured format (e.g. for resample / dither transforms). |
| `close(): Promise<void>` | Release the temp file (if any) and reset state. |

`read(N)` returns an `AudioChunk` whose `samples[0].length === N` when N frames are available; at end of buffer the returned chunk has fewer (possibly zero) frames. Callers loop until the short chunk and then break.

Concurrent read + write on the same buffer is allowed under the invariant that the read cursor leads the write cursor (callers maintain the invariant; the buffer does not enforce). Reads see disk plus already-flushed writes; in-flight write batches are invisible until `flushWrites()` or `close()`.

The sequential-only contract eliminates the whole-source `Float32Array` antipattern at the API level — random-access reads are structurally impossible, so transforms cannot accidentally materialize an entire source in memory. Transforms that need to compose or rearrange audio allocate a separate temp `ChunkBuffer`, stream output into it, then `buffer.clear()` and stream the temp back (see the `_process` example above).

## Backpressure

`SourceNode.render()` computes a `highWaterMark` from the pipeline depth, channel count, and chunk size, bounded by a configurable `memoryLimit` (default 256 MB). This is passed to all streams via `StreamContext` to apply consistent backpressure across the pipeline.

## License

ISC
