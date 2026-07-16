import { randomUUID } from "crypto";
import type { BufferedAudioNode } from "../node";
import type { SourceNode } from "../node/stream/source";
import { resolvePackageVersion } from "../utils/resolve-package-version";
import { validateGraphDefinition, type GraphDefinition, type GraphEdge, type GraphNode } from "./definition";

export function pack(sources: ReadonlyArray<SourceNode>, metadata?: { name?: string; id?: string; anchor?: string }): GraphDefinition {
	const visited = new Set<BufferedAudioNode>();
	const nodes: Array<GraphNode> = [];
	const edges: Array<GraphEdge> = [];
	const apiVersions: Array<{ packageName: string; nodeName: string; apiVersion: number }> = [];
	const detectedVersions = new Map<string, string>();

	const detect = (packageName: string): string => {
		const memoized = detectedVersions.get(packageName);

		if (memoized !== undefined) return memoized;

		const anchor = metadata?.anchor ?? process.argv[1];

		if (anchor === undefined) {
			throw new Error("Cannot resolve package versions: no anchor was provided and process.argv[1] is undefined (REPL or `node -e`). Pass `anchor: import.meta.url` to pack().");
		}

		const version = resolvePackageVersion(packageName, anchor);

		detectedVersions.set(packageName, version);

		return version;
	};

	const ensureId = (node: BufferedAudioNode): string => {
		if (node.id) return node.id;
		const id = randomUUID();

		node.properties = { ...node.properties, id };

		return id;
	};

	const walk = (node: BufferedAudioNode): void => {
		if (visited.has(node)) return;
		visited.add(node);

		const constructor = node.constructor as typeof BufferedAudioNode;
		const id = ensureId(node);
		const parameters = constructor.schema.parse(node.properties);

		apiVersions.push({ packageName: constructor.packageName, nodeName: constructor.nodeName, apiVersion: constructor.apiVersion });

		const options: { bypass?: boolean } = {};

		if (node.isBypassed) options.bypass = true;

		const graphNode: GraphNode = {
			id,
			packageName: constructor.packageName,
			packageVersion: node.properties.packageVersion ?? detect(constructor.packageName),
			nodeName: constructor.nodeName,
			...(Object.keys(parameters as Record<string, unknown>).length > 0 && { parameters: parameters as Record<string, unknown> }),
			...(Object.keys(options).length > 0 && { options }),
		};

		nodes.push(graphNode);

		const rawChildren = node.properties.children ?? [];

		for (const child of rawChildren) {
			edges.push({ from: id, to: ensureId(child) });
			walk(child);
		}
	};

	for (const source of sources) {
		walk(source);
	}

	const distinctVersions = new Set(apiVersions.map((entry) => entry.apiVersion));

	if (distinctVersions.size > 1) {
		const detail = apiVersions.map((entry) => `"${entry.nodeName}" (apiVersion ${entry.apiVersion})`).join(", ");

		throw new Error(`Cannot pack nodes at differing apiVersions: ${detail}`);
	}

	const apiVersion = [...distinctVersions][0];

	return validateGraphDefinition({ id: metadata?.id ?? randomUUID(), name: metadata?.name ?? "Untitled", apiVersion, nodes, edges });
}
