import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderGraph, validateGraphDefinition, SourceNode, type NodeIdentity, type StreamEvent, type NodeRegistry, type BufferedAudioNode } from "@buffered-audio/core";

const labelOf = (node: { moduleName: string; id?: string }): string => (node.id ? `${node.moduleName}#${node.id}` : node.moduleName);

interface EventSink {
	onEvent: (node: NodeIdentity, event: StreamEvent) => void;
	printSummary: (sources: ReadonlyArray<SourceNode>) => void;
}

function createEventSink(): EventSink {
	// Keyed by identity object, not label: id-less same-type nodes share a label but must not collide.
	const totals = new Map<NodeIdentity, { framesDone: number; processingMs?: number }>();

	const onEvent = (node: NodeIdentity, event: StreamEvent): void => {
		const label = labelOf(node);

		switch (event.kind) {
			case "started":
				process.stdout.write(`[${label}] started\n`);
				break;
			case "progress":
				if (event.framesTotal !== undefined) {
					const percent = Math.round((event.framesDone / event.framesTotal) * 100);

					process.stdout.write(`[${label}] ${event.phase} ${percent}%\n`);
				} else {
					process.stdout.write(`[${label}] ${event.phase} frames=${event.framesDone}\n`);
				}

				break;
			case "log": {
				const data = event.data ? Object.entries(event.data).map(([key, value]) => `${key}=${String(value)}`) : [];
				const parts = [event.message, ...data].join(" ");
				const prefix = event.level === "warn" ? "warn: " : "";

				process.stdout.write(`${prefix}[${label}] ${parts}\n`);
				break;
			}

			case "finished":
				totals.set(node, { framesDone: event.framesDone, processingMs: event.processingMs });
				process.stdout.write(`[${label}] finished\n`);
				break;
		}
	};

	const printSummary = (sources: ReadonlyArray<SourceNode>): void => {
		for (const [node, { framesDone, processingMs }] of totals) {
			const label = labelOf(node);

			if (processingMs !== undefined) {
				process.stdout.write(`[${label}] processed ${framesDone} frames in ${Math.round(processingMs)}ms\n`);
			} else {
				process.stdout.write(`[${label}] processed ${framesDone} frames\n`);
			}
		}

		for (const source of sources) {
			const timing = source.renderTiming;

			if (!timing) continue;

			const label = labelOf({ moduleName: (source.constructor as typeof BufferedAudioNode).moduleName, id: source.id });

			process.stdout.write(`[${label}] total ${(timing.totalMs / 1000).toFixed(1)}s, ${timing.realTimeMultiplier.toFixed(1)}x RT\n`);
		}
	};

	return { onEvent, printSummary };
}

const program = new Command();

program.name("buffered-audio-nodes").description("Process audio through buffered audio node pipelines");

program
	.command("process")
	.description("Run an async audio processing pipeline")
	.requiredOption("--pipeline <file>", "TypeScript file with default SourceAsyncModule export")
	.option("--chunk-size <samples>", "Chunk size in samples")
	.option("--high-water-mark <count>", "Stream backpressure high water mark")
	.action(async (options: { pipeline: string; chunkSize?: string; highWaterMark?: string }) => {
		const pipelinePath = resolve(options.pipeline);

		if (!existsSync(pipelinePath)) {
			process.stderr.write(`Error: pipeline file not found: ${pipelinePath}\n`);
			process.exit(1);
		}

		const { register } = await import("tsx/esm/api");
		const unregister = register();

		try {
			const mod = (await import(pipelinePath)) as Record<string, unknown>;
			const source = mod.default;

			if (!(source instanceof SourceNode)) {
				process.stderr.write("Error: default export must be a SourceAsyncModule\n");
				process.exit(1);
			}

			const chunkSize = options.chunkSize ? parseInt(options.chunkSize, 10) : undefined;
			const highWaterMark = options.highWaterMark ? parseInt(options.highWaterMark, 10) : undefined;

			if (chunkSize !== undefined && (!Number.isFinite(chunkSize) || chunkSize <= 0)) {
				process.stderr.write(`Error: --chunk-size must be a positive integer, got "${options.chunkSize}"\n`);
				process.exit(1);
			}

			if (highWaterMark !== undefined && (!Number.isFinite(highWaterMark) || highWaterMark <= 0)) {
				process.stderr.write(`Error: --high-water-mark must be a positive integer, got "${options.highWaterMark}"\n`);
				process.exit(1);
			}

			const sink = createEventSink();

			const renderOptions = {
				chunkSize,
				highWaterMark,
				onEvent: sink.onEvent,
			};

			process.stdout.write(`Processing pipeline: ${pipelinePath}\n`);
			await source.render(renderOptions);
			sink.printSummary([source]);
			process.stdout.write("Done.\n");
		} finally {
			await unregister();
		}
	});

program
	.command("render")
	.description("Render a .bag graph definition file")
	.argument("<file>", "Path to .bag file (JSON)")
	.option("--chunk-size <samples>", "Chunk size in samples")
	.option("--high-water-mark <count>", "Stream backpressure high water mark")
	.action(async (file: string, options: { chunkSize?: string; highWaterMark?: string }) => {
		const bagPath = resolve(file);

		if (!existsSync(bagPath)) {
			process.stderr.write(`Error: file not found: ${bagPath}\n`);
			process.exit(1);
		}

		const json = JSON.parse(readFileSync(bagPath, "utf-8")) as unknown;
		const definition = validateGraphDefinition(json);

		const { register } = await import("tsx/esm/api");
		const unregister = register();

		try {
			const registry: NodeRegistry = new Map();

			for (const nodeDef of definition.nodes) {
				if (!registry.has(nodeDef.packageName)) {
					const mod = (await import(nodeDef.packageName)) as Record<string, unknown>;
					const packageMap = new Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>();

					// Bag node lookups go by `moduleName` (what `pack()` writes), not
					// by export binding name. Index every export that has a string
					// `moduleName`; ignore the rest (factory functions, types, etc.).
					for (const value of Object.values(mod)) {
						if (typeof value !== "function") continue;

						const ctor = value as { moduleName?: unknown } & (new (options?: Record<string, unknown>) => BufferedAudioNode);

						if (typeof ctor.moduleName !== "string") continue;

						packageMap.set(ctor.moduleName, ctor);
					}

					registry.set(nodeDef.packageName, packageMap);
				}
			}

			const chunkSize = options.chunkSize ? parseInt(options.chunkSize, 10) : undefined;
			const highWaterMark = options.highWaterMark ? parseInt(options.highWaterMark, 10) : undefined;

			const sink = createEventSink();

			process.stdout.write(`Rendering graph: ${definition.name}\n`);
			const sources = await renderGraph(definition, registry, { chunkSize, highWaterMark, onEvent: sink.onEvent });

			sink.printSummary(sources);
			process.stdout.write("Done.\n");
		} finally {
			await unregister();
		}
	});

program.parse();
