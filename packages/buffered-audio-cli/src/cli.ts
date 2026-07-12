import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRenderJobs, validateGraphDefinition, BufferedSourceStream, SourceNode, type GraphDefinition, type StreamIdentity, type StartedPayload, type ProgressPayload, type FinishedPayload, type LogPayload, type RenderEvents, type RenderJob } from "@buffered-audio/core";
import { resolvePackages } from "./resolve-packages";
import { parseParams, parseResolveOverrides } from "./parse-options";

const labelOf = (identity: StreamIdentity): string => (identity.nodeId !== undefined ? `${identity.nodeName}#${identity.nodeId}` : `${identity.nodeName}#${identity.streamId}`);

function sourceLabel(job: RenderJob): string | undefined {
	for (const streams of job.streams.values()) {
		for (const stream of streams) {
			if (stream instanceof BufferedSourceStream) return labelOf(stream.identity);
		}
	}

	return undefined;
}

const collect = (value: string, previous: Array<string>): Array<string> => [...previous, value];

function stamp(createdAt: number): string {
	const date = new Date(createdAt);
	const pad = (value: number): string => String(value).padStart(2, "0");

	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

interface EventSink {
	subscribe: (events: RenderEvents) => void;
	printSummary: (jobs: ReadonlyArray<RenderJob>) => void;
}

function createEventSink(): EventSink {
	// Keyed by streamId, not label: id-less same-type nodes share a label but each has a unique streamId.
	const totals = new Map<number, { label: string; framesDone: number; processingMs?: number }>();

	const subscribe = (events: RenderEvents): void => {
		events.on("started", (node: StreamIdentity, payload: StartedPayload) => {
			process.stdout.write(`${stamp(payload.createdAt)} [${labelOf(node)}] started\n`);
		});

		events.on("progress", (node: StreamIdentity, payload: ProgressPayload) => {
			const label = labelOf(node);

			if (payload.framesTotal !== undefined) {
				const percent = Math.round((payload.framesDone / payload.framesTotal) * 100);

				process.stdout.write(`${stamp(payload.createdAt)} [${label}] ${payload.phase} ${percent}%\n`);
			} else {
				process.stdout.write(`${stamp(payload.createdAt)} [${label}] ${payload.phase} frames=${payload.framesDone}\n`);
			}
		});

		events.on("log", (node: StreamIdentity, payload: LogPayload) => {
			const data = payload.data ? Object.entries(payload.data).map(([key, value]) => `${key}=${String(value)}`) : [];
			const parts = [payload.message, ...data].join(" ");
			const prefix = payload.level === "warn" ? "warn: " : "";

			process.stdout.write(`${stamp(payload.createdAt)} ${prefix}[${labelOf(node)}] ${parts}\n`);
		});

		events.on("finished", (node: StreamIdentity, payload: FinishedPayload) => {
			totals.set(node.streamId, { label: labelOf(node), framesDone: payload.framesDone, processingMs: payload.processingMs });

			const ms = payload.processingMs !== undefined ? ` ms=${Math.round(payload.processingMs)}` : "";

			process.stdout.write(`${stamp(payload.createdAt)} [${labelOf(node)}] finished frames=${payload.framesDone}${ms}\n`);
		});
	};

	const printSummary = (jobs: ReadonlyArray<RenderJob>): void => {
		for (const { label, framesDone, processingMs } of totals.values()) {
			if (processingMs !== undefined) {
				process.stdout.write(`${stamp(Date.now())} [${label}] processed ${framesDone} frames in ${Math.round(processingMs)}ms\n`);
			} else {
				process.stdout.write(`${stamp(Date.now())} [${label}] processed ${framesDone} frames\n`);
			}
		}

		for (const job of jobs) {
			const timing = job.timing;

			if (!timing) continue;

			const label = sourceLabel(job) ?? "source";

			process.stdout.write(`${stamp(Date.now())} [${label}] total ${(timing.totalMs / 1000).toFixed(1)}s, ${timing.realTimeMultiplier.toFixed(1)}x RT\n`);
		}
	};

	return { subscribe, printSummary };
}

const program = new Command();

program.name("bag").description("Process audio through buffered audio node pipelines");

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
	.option("--no-install", "Disable on-demand fetch of pinned packages; fail if a pin cannot be satisfied locally")
	.option("--resolve <name=path>", "Override a package pin with a local directory (repeatable)", collect, [])
	.action(async (file: string, options: { chunkSize?: string; highWaterMark?: string; param: Array<string>; install: boolean; resolve: Array<string> }) => {
		const bagPath = resolve(file);

		if (!existsSync(bagPath)) {
			process.stderr.write(`Error: file not found: ${bagPath}\n`);
			process.exit(1);
		}

		let definition: GraphDefinition;
		let overrides: Map<string, string>;
		let parameters: Record<string, string>;

		try {
			const json = JSON.parse(readFileSync(bagPath, "utf-8")) as unknown;

			definition = validateGraphDefinition(json);
			overrides = parseResolveOverrides(options.resolve);
			parameters = parseParams(options.param);
		} catch (error) {
			process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		}

		const { register } = await import("tsx/esm/api");
		const unregister = register();

		try {
			const chunkSize = options.chunkSize ? parseInt(options.chunkSize, 10) : undefined;
			const highWaterMark = options.highWaterMark ? parseInt(options.highWaterMark, 10) : undefined;

			const sink = createEventSink();

			try {
				const registry = await resolvePackages(definition.packages, { install: options.install, overrides });

				process.stdout.write(`Rendering graph: ${definition.name}\n`);

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
