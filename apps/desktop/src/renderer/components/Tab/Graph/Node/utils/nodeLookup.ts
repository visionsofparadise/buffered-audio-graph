import type { NodeJsonSchema, NodeJsonSchemaProperty } from "../../../../../../shared/ipc/Package/loadNodes/Renderer";
import type { GraphContext } from "../../../../../models/Context";
import type { NodeCategory } from "../Container";

/**
 * Resolve a node class by (packageName, packageVersion, nodeName) from the
 * graph context. On success `unresolvedReason` is null and `schema` is the
 * node's JSON Schema. On failure `schema` is null and `unresolvedReason`
 * carries a human-readable reason — the node body renders it in place of the
 * parameter controls so an unresolvable node reads as broken, not empty.
 *
 * Generic — not coupled to any particular renderer component.
 */
export function lookupNode(
	packageName: string,
	packageVersion: string,
	nodeName: string,
	context: GraphContext,
): { category: NodeCategory; description: string; schema: NodeJsonSchema | null; unresolvedReason: string | null } {
	let packageFound = false;

	for (const nodePackage of context.app.packages) {
		if (nodePackage.name === packageName && nodePackage.version === packageVersion) {
			packageFound = true;

			for (const node of nodePackage.nodes) {
				if (node.nodeName === nodeName) {
					return {
						category: node.category,
						description: node.description,
						schema: node.schema as NodeJsonSchema,
						unresolvedReason: null,
					};
				}
			}
		}
	}

	const unresolvedReason = packageFound
		? `Node "${nodeName}" is not in ${packageName}@${packageVersion}`
		: `Package not installed: ${packageName}@${packageVersion}`;

	return { category: "transform", description: "", schema: null, unresolvedReason };
}

/**
 * Traverse a JSON Schema to find the property at the given path.
 * path[0] is the top-level parameter name; subsequent segments are property
 * names (string) or array item schema indicators (number — always resolves
 * to `items`).
 */
export function schemaPropertyAtPath(
	schema: NodeJsonSchema | null,
	path: ReadonlyArray<string | number>,
): NodeJsonSchemaProperty | null {
	if (!schema?.properties || path.length === 0) return null;

	const [head, ...tail] = path;

	if (typeof head !== "string") return null;

	let current: NodeJsonSchemaProperty | undefined = schema.properties[head];

	for (const segment of tail) {
		if (!current) return null;

		if (typeof segment === "number") {
			current = current.items;
		} else {
			current = current.properties?.[segment];
		}
	}

	return current ?? null;
}
