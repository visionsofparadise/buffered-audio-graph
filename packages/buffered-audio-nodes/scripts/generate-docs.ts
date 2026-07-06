import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { glob } from "node:fs/promises";
import type { z } from "zod";
import { zodToRows, type Row } from "./zod-rows";

/**
 * Minimal shape a discovered class must satisfy to be documented. All three
 * fields must be present and non-empty; `schema` must be a Zod schema.
 */
interface NodeClass {
	readonly nodeName: string;
	readonly nodeDescription: string;
	readonly schema: z.ZodType;
}

/**
 * Discovered node class plus the source file it was imported from. The source
 * path is the `index.ts` location that yielded the class; it becomes the
 * `[Source]` link target in the rendered block.
 */
interface DiscoveredNode {
	readonly cls: NodeClass;
	readonly sourcePath: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const SRC_ROOT = resolve(PACKAGE_ROOT, "src");
const README_PATH = resolve(PACKAGE_ROOT, "README.md");

/**
 * Determine whether an exported value is a class with the required statics.
 *
 * Classes in TypeScript compile to functions with a non-default `prototype`.
 * We accept any function that declares all three documented statics because
 * the generator is a discovery tool — adding an `instanceof` check against the
 * core base class would require importing core here, and the statics are the
 * authoritative signal already.
 */
function isNodeClass(value: unknown): value is NodeClass {
	if (typeof value !== "function") return false;

	const candidate = value as { nodeName?: unknown; nodeDescription?: unknown; schema?: unknown };

	if (typeof candidate.nodeName !== "string" || candidate.nodeName === "") return false;
	if (typeof candidate.nodeDescription !== "string") return false;
	if (candidate.schema === undefined || candidate.schema === null) return false;

	return true;
}

/**
 * Import every `src/**\/*.ts` file (except the package barrel, test files, and
 * declaration files) and collect exported classes that satisfy
 * {@link isNodeClass}. Deduplicated by class identity — a node re-exported from
 * multiple files is kept once, with the first discovery's source path
 * preserved.
 *
 * The glob scans all `.ts` sources (not just `index.ts`) so that node classes
 * living at non-index paths — e.g. `transforms/de-click/de-crackle.ts` — are
 * discovered. The `isNodeClass` filter plus identity-based dedup ensure that
 * utility modules, types-only files, and re-exports don't produce false
 * positives or duplicates.
 */
async function discoverNodes(): Promise<Array<DiscoveredNode>> {
	const paths: Array<string> = [];

	for await (const entry of glob("**/*.ts", { cwd: SRC_ROOT })) {
		// Normalize path separators so Windows and POSIX produce identical matches.
		const normalized = entry.split("\\").join("/");

		if (normalized === "index.ts") continue;
		// `src/cli.ts` is an executable script that calls `program.parse()` at
		// module top-level. Importing it would run the CLI. Skip it explicitly.
		if (normalized === "cli.ts") continue;
		if (normalized.endsWith(".d.ts")) continue;
		if (normalized.endsWith(".test.ts")) continue;
		if (normalized.endsWith(".unit.test.ts")) continue;
		if (normalized.endsWith(".integration.test.ts")) continue;
		if (normalized.endsWith(".spec.ts")) continue;

		paths.push(resolve(SRC_ROOT, entry));
	}

	paths.sort();

	const seen = new Set<NodeClass>();
	const discovered: Array<DiscoveredNode> = [];

	for (const path of paths) {
		const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;

		for (const value of Object.values(mod)) {
			if (!isNodeClass(value)) continue;
			if (seen.has(value)) continue;

			seen.add(value);
			discovered.push({ cls: value, sourcePath: path });
		}
	}

	discovered.sort((left, right) => left.cls.nodeName.localeCompare(right.cls.nodeName));

	return discovered;
}

/** Render the parameter table body for a set of rows. */
function renderRows(rows: ReadonlyArray<Row>): string {
	return rows.map((row) => `| \`${row.name}\` | ${row.type} | ${row.default} | ${row.description} |`).join("\n");
}

/**
 * Render a single node's section: heading, description, source link, and the
 * parameter table. Section ends with no trailing newline — the caller glues
 * sections together.
 */
function renderNodeSection(node: DiscoveredNode): string {
	const relativeSource = relative(PACKAGE_ROOT, node.sourcePath).split("\\").join("/");
	const rows = zodToRows(node.cls.schema);
	const header = `### ${node.cls.nodeName}

${node.cls.nodeDescription}

[Source](./${relativeSource})`;

	if (rows.length === 0) {
		return header;
	}

	const table = `| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
${renderRows(rows)}`;

	return `${header}

${table}`;
}

/** Render the full `## Nodes` body — all discovered node sections joined. */
function renderNodesBlock(nodes: ReadonlyArray<DiscoveredNode>): string {
	return nodes.map(renderNodeSection).join("\n\n");
}

/**
 * Replace the README's `## Nodes` section body (everything between the
 * `## Nodes` heading and the next `## ` heading, exclusive of both) with the
 * generated block wrapped in blank lines.
 *
 * Throws when the markers can't be located so the script fails loudly instead
 * of silently emitting a malformed README.
 */
function replaceNodesSection(readme: string, generatedBlock: string): string {
	const lines = readme.split("\n");
	const headingIndex = lines.findIndex((line) => line.trim() === "## Nodes");

	if (headingIndex === -1) {
		throw new Error("README.md is missing the `## Nodes` heading");
	}

	let nextHeadingIndex = -1;

	for (let index = headingIndex + 1; index < lines.length; index++) {
		const line = lines[index];

		if (line?.startsWith("## ")) {
			nextHeadingIndex = index;
			break;
		}
	}

	if (nextHeadingIndex === -1) {
		throw new Error("README.md has no `## ` heading after `## Nodes` — cannot determine section end");
	}

	const before = lines.slice(0, headingIndex + 1).join("\n");
	const after = lines.slice(nextHeadingIndex).join("\n");

	return `${before}\n\n${generatedBlock}\n\n${after}`;
}

async function main(): Promise<void> {
	const nodes = await discoverNodes();
	const generatedBlock = renderNodesBlock(nodes);
	const readme = await readFile(README_PATH, "utf8");
	const next = replaceNodesSection(readme, generatedBlock);

	await writeFile(README_PATH, next, "utf8");

	process.stdout.write(`Generated docs for ${String(nodes.length)} nodes\n`);
}

await main();
