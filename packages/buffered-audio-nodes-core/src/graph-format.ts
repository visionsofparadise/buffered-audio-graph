import { randomUUID } from "crypto";
import { z } from "zod";
import type { BufferedAudioNode, RenderOptions } from "./node";
import { SourceNode } from "./source";
import { TransformNode } from "./transform";

const graphNodeSchema = z.object({
	id: z.string().min(1),
	packageName: z.string().min(1),
	packageVersion: z.string().min(1),
	nodeName: z.string().min(1),
	parameters: z.record(z.string(), z.unknown()).optional(),
	options: z
		.object({
			bypass: z.boolean().optional(),
		})
		.optional(),
});

const graphEdgeSchema = z.object({
	from: z.string().min(1),
	to: z.string().min(1),
});

const graphDefinitionSchema = z.object({
	id: z.uuid(),
	name: z.string().default("Untitled"),
	nodes: z.array(graphNodeSchema),
	edges: z.array(graphEdgeSchema),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphDefinition = z.infer<typeof graphDefinitionSchema>;

export type NodeRegistry = Map<string, Map<string, new (options?: Record<string, unknown>) => BufferedAudioNode>>;

export function validateGraphDefinition(json: unknown): GraphDefinition {
	return graphDefinitionSchema.parse(json);
}

export function pack(sources: ReadonlyArray<SourceNode>, metadata?: { name?: string; id?: string }): GraphDefinition {
	const visited = new Set<BufferedAudioNode>();
	const nodes: Array<GraphNode> = [];
	const edges: Array<GraphEdge> = [];

	const ensureId = (node: BufferedAudioNode): string => {
		if (node.id) return node.id;
		const id = randomUUID();

		node.properties = { ...node.properties, id };

		return id;
	};

	const walk = (node: BufferedAudioNode): void => {
		if (visited.has(node)) return;
		visited.add(node);

		const ctor = node.constructor as typeof BufferedAudioNode;
		const id = ensureId(node);
		const parameters = ctor.schema.parse(node.properties);

		const options: { bypass?: boolean } = {};

		if (node.isBypassed) options.bypass = true;

		const graphNode: GraphNode = {
			id,
			packageName: ctor.packageName,
			packageVersion: ctor.packageVersion,
			nodeName: ctor.moduleName,
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

	return graphDefinitionSchema.parse({ id: metadata?.id ?? randomUUID(), name: metadata?.name ?? "Untitled", nodes, edges });
}

export function unpack(definition: GraphDefinition, registry: NodeRegistry): Array<SourceNode> {
	const nodeMap = new Map<string, BufferedAudioNode>();

	for (const nodeDef of definition.nodes) {
		const packageModules = registry.get(nodeDef.packageName);

		if (!packageModules) throw new Error(`Unknown package: "${nodeDef.packageName}"`);

		const NodeClass = packageModules.get(nodeDef.nodeName);

		if (!NodeClass) throw new Error(`Unknown node: "${nodeDef.nodeName}" in package "${nodeDef.packageName}"`);

		// Apply the node's Zod schema to the serialized parameters before
		// construction — symmetric with `pack()` (which serializes via
		// `ctor.schema.parse(node.properties)`) and with the convenience
		// constructors (which `schema.parse(options)` before `new`). Without
		// this, a bag that omits a defaulted parameter (e.g. crestReduce with
		// only `smoothing` set) instantiates the node with that parameter
		// `undefined` instead of its schema default, surfacing as a
		// downstream `NaN`/crash (frameSize→hopSize→frameCount).
		const ctor = NodeClass as unknown as typeof BufferedAudioNode;
		const parameters = ctor.schema.parse(nodeDef.parameters ?? {}) as Record<string, unknown>;
		const instance = new NodeClass(parameters);

		if (nodeDef.options?.bypass) {
			instance.properties = { ...instance.properties, bypass: nodeDef.options.bypass };
		}

		nodeMap.set(nodeDef.id, instance);
	}

	for (const edge of definition.edges) {
		const fromNode = nodeMap.get(edge.from);
		const toNode = nodeMap.get(edge.to);

		if (!fromNode) throw new Error(`Edge references unknown node: "${edge.from}"`);
		if (!toNode) throw new Error(`Edge references unknown node: "${edge.to}"`);

		if (SourceNode.is(fromNode) || TransformNode.is(fromNode)) {
			fromNode.to(toNode);
		} else {
			throw new Error(`Cannot connect from target node "${edge.from}"`);
		}
	}

	const targetIds = new Set(definition.edges.map((edge) => edge.to));
	const sources: Array<SourceNode> = [];

	for (const nodeDef of definition.nodes) {
		if (!targetIds.has(nodeDef.id)) {
			const node = nodeMap.get(nodeDef.id);

			if (SourceNode.is(node)) {
				sources.push(node);
			}
		}
	}

	if (sources.length === 0) {
		throw new Error("No source nodes found in graph definition");
	}

	return sources;
}

export async function renderGraph(definition: GraphDefinition, registry: NodeRegistry, options?: RenderOptions): Promise<void> {
	const sources = unpack(definition, registry);

	await Promise.all(sources.map((source) => source.render(options)));
}
