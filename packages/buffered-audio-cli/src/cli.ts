import { createRenderJobs, validateGraphDefinition, type GraphDefinition } from "@buffered-audio/core";
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import packageJson from "../package.json";
import { createEventSink } from "./event-sink";
import { parseParams, parseResolveOverrides } from "./parse-options";
import { resolvePackages } from "./resolve-packages";

const program = new Command();

program.name("bag").description("Process audio through buffered audio node pipelines").version(packageJson.version);

program
	.command("render")
	.description("Render a .bag graph definition file")
	.argument("<file>", "Path to .bag file (JSON)")
	.option("--chunk-size <samples>", "Chunk size in samples")
	.option("--high-water-mark <count>", "Stream backpressure high water mark")
	.option("--param <name=value>", "Bind a {{name}} template placeholder in the bag (repeatable)", (value: string, previous: Array<string>) => [...previous, value], [])
	.option("--no-install", "Disable on-demand fetch of pinned packages; fail if a pin cannot be satisfied locally")
	.option("--resolve <name=path>", "Override a package pin with a local directory (repeatable)", (value: string, previous: Array<string>) => [...previous, value], [])
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
				const seen = new Set<string>();
				const pairs: Array<{ packageName: string; packageVersion: string }> = [];

				for (const node of definition.nodes) {
					const key = `${node.packageName}@${node.packageVersion}`;

					if (seen.has(key)) continue;

					seen.add(key);
					pairs.push({ packageName: node.packageName, packageVersion: node.packageVersion });
				}

				const registry = await resolvePackages(pairs, { install: options.install, overrides });

				process.stdout.write(`Rendering graph: ${definition.name}\n`);

				const jobs = createRenderJobs(definition, registry, { chunkSize, highWaterMark, parameters });

				for (const job of jobs) sink.subscribe(job);

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
