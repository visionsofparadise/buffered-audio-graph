import type { GraphNode } from "@buffered-audio/core";
import type { NodeJsonSchema, NodeJsonSchemaProperty } from "../../../../../shared/ipc/Package/loadNodes/Renderer";
import type { FileParamStat } from "../../../../../shared/utilities/serializeFileParamStats";
import type { GraphContext } from "../../../../models/Context";
import type { Main } from "../../../../models/Main";
import { lookupNode } from "../Node/utils/nodeLookup";

interface FileParamValue {
	readonly parameterPath: string;
	readonly value: string;
}

/**
 * Walk a node's JSON Schema collecting every file-kind parameter
 * (`prop.input === "file" | "folder"`, including array-of-object item
 * properties) that carries a non-empty string value. Mirrors the file-param
 * discrimination in `buildParameters`. `parameterPath` is a dotted path
 * (`stages.0.presetPath`) used only for deterministic hash ordering.
 */
function collectFileParamValues(
	properties: Readonly<Record<string, NodeJsonSchemaProperty>>,
	values: Record<string, unknown> | undefined,
	pathPrefix: string,
	out: Array<FileParamValue>,
): void {
	for (const [name, prop] of Object.entries(properties)) {
		const value = values?.[name];
		const parameterPath = pathPrefix ? `${pathPrefix}.${name}` : name;

		if (prop.input === "file" || prop.input === "folder") {
			// Only input files invalidate a node. mode:"save" outputs are produced
			// by the node, not consumed — folding their stats would defeat the
			// snapshot cache (output write → new mtime → new hash every render).
			if (prop.mode !== "save" && typeof value === "string" && value.length > 0) {
				out.push({ parameterPath, value });
			}

			continue;
		}

		if (prop.type === "object" && prop.properties) {
			const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

			collectFileParamValues(prop.properties, record, parameterPath, out);

			continue;
		}

		if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
			const itemProperties = prop.items.properties;
			const rows = Array.isArray(value) ? value : [];

			rows.forEach((row, index) => {
				const record = row !== null && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : undefined;

				collectFileParamValues(itemProperties, record, `${parameterPath}.${index}`, out);
			});
		}
	}
}

/**
 * Stat every file-kind parameter of a node, producing the sorted-serializable
 * `FileParamStat` list folded into its content hash. A missing or unstattable
 * file contributes `{ parameterPath, stat: null }` — a stat failure never
 * throws, because a missing file is a legitimate pre-render state.
 */
async function collectFileParamStats(
	schema: NodeJsonSchema | null,
	parameters: Record<string, unknown> | undefined,
	main: Pick<Main, "stat">,
): Promise<Array<FileParamStat>> {
	if (!schema?.properties) return [];

	const fileParamValues: Array<FileParamValue> = [];

	collectFileParamValues(schema.properties, parameters, "", fileParamValues);

	return Promise.all(
		fileParamValues.map(async ({ parameterPath, value }): Promise<FileParamStat> => {
			try {
				const stat = await main.stat(value);

				return { parameterPath, stat: { mtimeMs: stat.mtimeMs, size: stat.size } };
			} catch {
				return { parameterPath, stat: null };
			}
		}),
	);
}

/**
 * Resolve the file-param stats for every node in a graph, keyed by node id, so
 * both hash-computing call sites (`useNodeStates`, `buildRenderPlan`) fold
 * identical file staleness into their hashes. Nodes whose package/schema can't
 * be resolved contribute an empty list.
 */
export async function resolveFileStatsByNode(
	nodes: ReadonlyArray<GraphNode>,
	context: GraphContext,
): Promise<Map<string, Array<FileParamStat>>> {
	const entries = await Promise.all(
		nodes.map(async (node): Promise<[string, Array<FileParamStat>]> => {
			const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";
			const { schema } = lookupNode(node.packageName, packageVersion, node.nodeName, context);
			const stats = await collectFileParamStats(schema, node.parameters ?? undefined, context.main);

			return [node.id, stats];
		}),
	);

	return new Map(entries);
}
