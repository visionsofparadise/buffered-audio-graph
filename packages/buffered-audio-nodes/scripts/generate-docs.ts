import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { glob } from "node:fs/promises";
import type { z } from "zod";
import { zodToRows, type Row } from "./zod-rows";

interface NodeClass {
	readonly nodeName: string;
	readonly description: string;
	readonly schema: z.ZodType;
}

interface DiscoveredNode {
	readonly cls: NodeClass;
	readonly sourcePath: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const SRC_ROOT = resolve(PACKAGE_ROOT, "src");
const README_PATH = resolve(PACKAGE_ROOT, "README.md");

function isNodeClass(value: unknown): value is NodeClass {
	if (typeof value !== "function") return false;

	const candidate = value as { nodeName?: unknown; description?: unknown; schema?: unknown };

	if (typeof candidate.nodeName !== "string" || candidate.nodeName === "") return false;
	if (typeof candidate.description !== "string") return false;
	if (candidate.schema === undefined || candidate.schema === null) return false;

	return true;
}

async function discoverNodes(): Promise<Array<DiscoveredNode>> {
	const paths: Array<string> = [];

	for await (const entry of glob("**/*.ts", { cwd: SRC_ROOT })) {
		const normalized = entry.split("\\").join("/");

		if (normalized === "index.ts") continue;
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

function renderRows(rows: ReadonlyArray<Row>): string {
	return rows.map((row) => `| \`${row.name}\` | ${row.type} | ${row.default} | ${row.description} |`).join("\n");
}

function renderNodeSection(node: DiscoveredNode): string {
	const relativeSource = relative(PACKAGE_ROOT, node.sourcePath).split("\\").join("/");
	const rows = zodToRows(node.cls.schema);
	const header = `### ${node.cls.nodeName}

${node.cls.description}

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

function renderNodesBlock(nodes: ReadonlyArray<DiscoveredNode>): string {
	return nodes.map(renderNodeSection).join("\n\n");
}

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
