import type { ModuleJsonSchema, ModuleJsonSchemaProperty } from "../../../../../../shared/ipc/Package/loadModules/Renderer";
import type { GraphContext } from "../../../../../models/Context";
import type { NodeCategory } from "../Container";

/**
 * Resolve a package module by (packageName, packageVersion, nodeName) from the
 * graph context. On success `unresolvedReason` is null and `schema` is the
 * module's JSON Schema. On failure `schema` is null and `unresolvedReason`
 * carries a human-readable reason — the node body renders it in place of the
 * parameter controls so an unresolvable node reads as broken, not empty.
 *
 * Generic — not coupled to any particular renderer component.
 */
export function lookupModule(
	packageName: string,
	packageVersion: string,
	nodeName: string,
	context: GraphContext,
): { category: NodeCategory; moduleDescription: string; schema: ModuleJsonSchema | null; unresolvedReason: string | null } {
	let packageFound = false;

	for (const modulePackage of context.app.packages) {
		if (modulePackage.name === packageName && modulePackage.version === packageVersion) {
			packageFound = true;

			for (const mod of modulePackage.modules) {
				if (mod.moduleName === nodeName) {
					return {
						category: mod.category,
						moduleDescription: mod.moduleDescription,
						schema: mod.schema as ModuleJsonSchema,
						unresolvedReason: null,
					};
				}
			}
		}
	}

	const unresolvedReason = packageFound
		? `Node "${nodeName}" is not in ${packageName}@${packageVersion}`
		: `Package not installed: ${packageName}@${packageVersion}`;

	return { category: "transform", moduleDescription: "", schema: null, unresolvedReason };
}

/**
 * Traverse a JSON Schema to find the property at the given path.
 * path[0] is the top-level parameter name; subsequent segments are property
 * names (string) or array item schema indicators (number — always resolves
 * to `items`).
 */
export function schemaPropertyAtPath(
	schema: ModuleJsonSchema | null,
	path: ReadonlyArray<string | number>,
): ModuleJsonSchemaProperty | null {
	if (!schema?.properties || path.length === 0) return null;

	const [head, ...tail] = path;

	if (typeof head !== "string") return null;

	let current: ModuleJsonSchemaProperty | undefined = schema.properties[head];

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
