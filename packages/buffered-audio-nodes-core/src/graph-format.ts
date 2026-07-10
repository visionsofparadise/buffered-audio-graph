import { randomUUID } from "crypto";
import { z } from "zod";
import type { BufferedAudioNode } from "./node";
import type { RenderJob, RenderOptions } from "./render-job";
import type { SourceNode } from "./source";
import type { TransformNode } from "./transform";

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

const placeholderPattern = /\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/g;

export function substituteParameters(definition: GraphDefinition, parameters: Record<string, string>): GraphDefinition {
	const usedNames = new Set<string>();
	const unboundNames = new Set<string>();

	const substituteValue = (value: unknown): unknown => {
		if (typeof value === "string") {
			return value.replace(placeholderPattern, (match, name: string) => {
				usedNames.add(name);

				const provided = Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : undefined;

				if (provided !== undefined) return provided;

				unboundNames.add(name);

				return match;
			});
		}

		if (Array.isArray(value)) return value.map(substituteValue);

		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substituteValue(entry)]));
		}

		return value;
	};

	const nodes = definition.nodes.map((node) => {
		if (node.parameters === undefined) return node;

		return { ...node, parameters: substituteValue(node.parameters) as Record<string, unknown> };
	});

	const unknownNames = Object.keys(parameters).filter((name) => !usedNames.has(name));

	if (unboundNames.size > 0 || unknownNames.length > 0) {
		const messages: Array<string> = [];

		if (unboundNames.size > 0) messages.push(`unbound placeholders: ${[...unboundNames].join(", ")}`);
		if (unknownNames.length > 0) messages.push(`unknown parameters: ${unknownNames.join(", ")}`);

		throw new Error(`Parameter substitution failed — ${messages.join("; ")}`);
	}

	return { ...definition, nodes };
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
			nodeName: ctor.nodeName,
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

const canConnect = (node: BufferedAudioNode): node is SourceNode | TransformNode => typeof (node as { to?: unknown }).to === "function";
const isRenderable = (node: BufferedAudioNode): node is SourceNode => typeof (node as { createRenderJob?: unknown }).createRenderJob === "function";

export function unpack(definition: GraphDefinition, registry: NodeRegistry): Array<SourceNode> {
	const nodeMap = new Map<string, BufferedAudioNode>();

	for (const nodeDef of definition.nodes) {
		const packageNodes = registry.get(nodeDef.packageName);

		if (!packageNodes) throw new Error(`Unknown package: "${nodeDef.packageName}"`);

		const NodeClass = packageNodes.get(nodeDef.nodeName);

		if (!NodeClass) throw new Error(`Unknown node: "${nodeDef.nodeName}" in package "${nodeDef.packageName}"`);

		const instance = new NodeClass({
			...(nodeDef.parameters ?? {}),
			id: nodeDef.id,
			...(nodeDef.options?.bypass !== undefined ? { bypass: nodeDef.options.bypass } : {}),
		});

		nodeMap.set(nodeDef.id, instance);
	}

	for (const edge of definition.edges) {
		const fromNode = nodeMap.get(edge.from);
		const toNode = nodeMap.get(edge.to);

		if (!fromNode) throw new Error(`Edge references unknown node: "${edge.from}"`);
		if (!toNode) throw new Error(`Edge references unknown node: "${edge.to}"`);

		if (canConnect(fromNode)) {
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

			if (node !== undefined && isRenderable(node)) {
				sources.push(node);
			}
		}
	}

	if (sources.length === 0) {
		throw new Error("No source nodes found in graph definition");
	}

	return sources;
}

export interface RenderGraphOptions extends RenderOptions {
	parameters?: Record<string, string>;
}

export function createRenderJobs(definition: GraphDefinition, registry: NodeRegistry, options?: RenderGraphOptions): Array<RenderJob> {
	const substituted = substituteParameters(definition, options?.parameters ?? {});
	const sources = unpack(substituted, registry);

	const { parameters: _parameters, ...renderOptions } = options ?? {};

	return sources.map((source) => source.createRenderJob(renderOptions));
}
