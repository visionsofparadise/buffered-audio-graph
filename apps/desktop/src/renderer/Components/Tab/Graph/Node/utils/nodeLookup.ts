import type { NodeJsonSchema, NodeJsonSchemaProperty } from "../../../../../../shared/ipc/Package/ensure/Renderer";
import type { GraphContext } from "../../../../../Models/Context";
import type { NodeCategory } from "../Container";

export function lookupNode(
	packageName: string,
	version: string,
	nodeName: string,
	context: GraphContext,
): { category: NodeCategory; description: string; schema: NodeJsonSchema | null; unresolvedReason: string | null } {
	let packageFound = false;

	for (const nodePackage of context.app.packages) {
		if (nodePackage.name === packageName && nodePackage.version === version) {
			packageFound = true;

			if (nodePackage.status === "error") {
				return {
					category: "transform",
					description: "",
					schema: null,
					unresolvedReason: nodePackage.error ?? `Package ${packageName}@${version} failed to load`,
				};
			}

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
		? `Node "${nodeName}" is not in ${packageName}@${version}`
		: `Package not installed: ${packageName}@${version}`;

	return { category: "transform", description: "", schema: null, unresolvedReason };
}

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
