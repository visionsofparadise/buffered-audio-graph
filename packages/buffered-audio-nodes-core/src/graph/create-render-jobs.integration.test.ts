import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BufferedAudioNode } from "../node";
import type { Block } from "../node/stream/block";
import { BufferedSourceStream, SourceNode, type SourceMetadata, type SourceNodeProperties } from "../node/stream/source";
import { BufferedTargetStream, TargetNode, type TargetNodeProperties } from "../node/stream/target";
import { createRenderJobs } from "./create-render-jobs";
import type { GraphDefinition, NodeRegistry } from "./definition";

function createBlock(value: number, offset: number, frames: number): Block {
	return { samples: [new Float32Array(frames).fill(value)], offset, sampleRate: 44100, bitDepth: 32 };
}

interface PathSourceProperties extends SourceNodeProperties {
	readonly path: string;
	done?: boolean;
}

class PathSourceStream extends BufferedSourceStream<PathSource> {
	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: 44100, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		if (this.properties.done) return undefined;
		this.properties.done = true;

		return createBlock(1, 0, 10);
	}
}

class PathSource extends SourceNode<PathSourceProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "path-source";
	static override readonly schema = z.object({ path: z.string() });
	static override readonly Stream = PathSourceStream;
}

const capturedPaths: Array<string> = [];

interface PathTargetProperties extends TargetNodeProperties {
	readonly path: string;
}

class PathTargetStream extends BufferedTargetStream<PathTarget> {
	override async _write(): Promise<void> {}
	override async _close(): Promise<void> {
		capturedPaths.push(this.properties.path);
	}
}

class PathTarget extends TargetNode<PathTargetProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "path-target";
	static override readonly schema = z.object({ path: z.string() });
	static override readonly Stream = PathTargetStream;
}

describe("createRenderJobs parameter substitution", () => {
	const registry: NodeRegistry = new Map([
		[
			"test",
			new Map([
				[
					"1.0.0",
					new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>([
						["path-source", PathSource as never],
						["path-target", PathTarget as never],
					]),
				],
			]),
		],
	]);

	const definition: GraphDefinition = {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		name: "Test",
		apiVersion: 1,
		nodes: [
			{ id: "s", packageName: "test", packageVersion: "1.0.0", nodeName: "path-source", parameters: { path: "{{dir}}/in.wav" } },
			{ id: "t", packageName: "test", packageVersion: "1.0.0", nodeName: "path-target", parameters: { path: "{{dir}}/out.wav" } },
		],
		edges: [{ from: "s", to: "t" }],
	};

	it("renders the same definition twice with different parameters, each seeing its own values", async () => {
		capturedPaths.length = 0;

		for (const job of createRenderJobs(definition, registry, { parameters: { dir: "e260" } })) await job.render();
		for (const job of createRenderJobs(definition, registry, { parameters: { dir: "e261" } })) await job.render();

		expect(capturedPaths).toEqual(["e260/out.wav", "e261/out.wav"]);
	});

	it("throws before any job is created when a required parameter is missing", () => {
		expect(() => createRenderJobs(definition, registry, { parameters: {} })).toThrow(/unbound placeholders: dir/);
	});
});
