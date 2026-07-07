import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRenderJobs, validateGraphDefinition, BufferedSourceStream, SourceNode, type NodeIdentity, type ProgressPayload, type FinishedPayload, type LogPayload, type NodeRegistry, type BufferedAudioNode, type RenderEvents, type RenderJob } from "@buffered-audio/core";

const labelOf = (node: { nodeName: string; id?: string }): string => (node.id ? `${node.nodeName}#${node.id}` : node.nodeName);

function sourceLabel(job: RenderJob): string | undefined {
	for (const [node, streams] of job.streams) {
		if (streams.some((stream) => stream instanceof BufferedSourceStream)) {
			return labelOf({ nodeName: (node.constructor as typeof BufferedAudioNode).nodeName, id: node.id });
		}
	}

	return undefined;
}

const collect = (value: string, previous: Array<string>): Array<string> => [...previous, value];

function parseParams(entries: ReadonlyArray<string>): Record<string, string> {
	const parameters = new Map<string, string>();

	for (const entry of entries) {
		const separatorIndex = entry.indexOf("=");

		if (separatorIndex === -1) {
			process.stderr.write(`Error: --param must be in name=value form, got "${entry}"\n`);
			process.exit(1);
		}

		const name = entry.slice(0, separatorIndex);
		const value = entry.slice(separatorIndex + 1);

		if (name === "") {
			process.stderr.write(`Error: --param name must not be empty, got "${entry}"\n`);
			process.exit(1);
		}

		if (parameters.has(name)) {
			process.stderr.write(`Error: --param ${name} given more than once\n`);
			process.exit(1);
		}

		parameters.set(name, value);
	}

	return Object.fromEntries(parameters);
}

function stamp(): string {
	const now = new Date();
	const pad = (value: number): string => String(value).padStart(2, "0");

	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

interface EventSink {
	subscribe: (events: RenderEvents) => void;
	printSummary: (jobs: ReadonlyArray<RenderJob>) => void;
}

function createEventSink(): EventSink {
	// Keyed by identity object, not label: id-less same-type nodes share a label but must not collide.
	const totals = new Map<NodeIdentity, { framesDone: number; processingMs?: number }>();

	const subscribe = (events: RenderEvents): void => {
		events.on("started", (node: NodeIdentity) => {
			process.stdout.write(`${stamp()} [${labelOf(node)}] started\n`);
		});

		events.on("progress", (node: NodeIdentity, payload: ProgressPayload) => {
			const label = labelOf(node);

			if (payload.framesTotal !== undefined) {
				const percent = Math.round((payload.framesDone / payload.framesTotal) * 100);

				process.stdout.write(`${stamp()} [${label}] ${payload.phase} ${percent}%\n`);
			} else {
				process.stdout.write(`${stamp()} [${label}] ${payload.phase} frames=${payload.framesDone}\n`);
			}
		});

		events.on("log", (node: NodeIdentity, payload: LogPayload) => {
			const data = payload.data ? Object.entries(payload.data).map(([key, value]) => `${key}=${String(value)}`) : [];
			const parts = [payload.message, ...data].join(" ");
			const prefix = payload.level === "warn" ? "warn: " : "";

			process.stdout.write(`${stamp()} ${prefix}[${labelOf(node)}] ${parts}\n`);
		});

		events.on("finished", (node: NodeIdentity, payload: FinishedPayload) => {
			totals.set(node, { framesDone: payload.framesDone, processingMs: payload.processingMs });

			const ms = payload.processingMs !== undefined ? ` ms=${Math.round(payload.processingMs)}` : "";

			process.stdout.write(`${stamp()} [${labelOf(node)}] finished frames=${payload.framesDone}${ms}\n`);
		});
	};

	const printSummary = (jobs: ReadonlyArray<RenderJob>): void => {
		for (const [node, { framesDone, processingMs }] of totals) {
			const label = labelOf(node);

			if (processingMs !== undefined) {
				process.stdout.write(`${stamp()} [${label}] processed ${framesDone} frames in ${Math.round(processingMs)}ms\n`);
			} else {
				process.stdout.write(`${stamp()} [${label}] processed ${framesDone} frames\n`);
			}
		}

		for (const job of jobs) {
			const timing = job.timing;

			if (!timing) continue;

			const label = sourceLabel(job) ?? "source";

			process.stdout.write(`${stamp()} [${label}] total ${(timing.totalMs / 1000).toFixed(1)}s, ${timing.realTimeMultiplier.toFixed(1)}x RT\n`);
		}
	};

	return { subscribe, printSummary };
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

			const job = source.createRenderJob({ chunkSize, highWaterMark });

			sink.subscribe(job.events);

			process.stdout.write(`Processing pipeline: ${pipelinePath}\n`);
			await job.render();
			sink.printSummary([job]);
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
	.option("--param <name=value>", "Bind a {{name}} template placeholder in the bag (repeatable)", collect, [])
	.action(async (file: string, options: { chunkSize?: string; highWaterMark?: string; param: Array<string> }) => {
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

					// Bag node lookups go by `nodeName` (what `pack()` writes), not
					// by export binding name. Index every export that has a string
					// `nodeName`; ignore the rest (factory functions, types, etc.).
					for (const value of Object.values(mod)) {
						if (typeof value !== "function") continue;

						const ctor = value as { nodeName?: unknown } & (new (options?: Record<string, unknown>) => BufferedAudioNode);

						if (typeof ctor.nodeName !== "string") continue;

						packageMap.set(ctor.nodeName, ctor);
					}

					registry.set(nodeDef.packageName, packageMap);
				}
			}

			const chunkSize = options.chunkSize ? parseInt(options.chunkSize, 10) : undefined;
			const highWaterMark = options.highWaterMark ? parseInt(options.highWaterMark, 10) : undefined;
			const parameters = parseParams(options.param);

			const sink = createEventSink();

			process.stdout.write(`Rendering graph: ${definition.name}\n`);

			try {
				const jobs = createRenderJobs(definition, registry, { chunkSize, highWaterMark, parameters });

				for (const job of jobs) sink.subscribe(job.events);

				await Promise.all(jobs.map((job) => job.render()));

				sink.printSummary(jobs);
				process.stdout.write("Done.\n");
			} catch (error) {
				process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			}
		} finally {
			await unregister();
		}
	});

program.parse();
