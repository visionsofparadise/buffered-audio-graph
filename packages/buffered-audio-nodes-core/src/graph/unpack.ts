import type { BufferedAudioNode } from "../node";
import type { SourceNode } from "../node/stream/source";
import type { TransformNode } from "../node/transform";
import type { GraphDefinition, NodeRegistry } from "./definition";

const canConnect = (node: BufferedAudioNode): node is SourceNode | TransformNode => typeof (node as { to?: unknown }).to === "function";
const isRenderable = (node: BufferedAudioNode): node is SourceNode => typeof (node as { createRenderJob?: unknown }).createRenderJob === "function";

export function unpack(definition: GraphDefinition, registry: NodeRegistry): Array<SourceNode> {
	const nodeMap = new Map<string, BufferedAudioNode>();

	for (const nodeDefinition of definition.nodes) {
		const packageVersions = registry.get(nodeDefinition.packageName);
		const packageNodes = packageVersions?.get(nodeDefinition.packageVersion);

		if (!packageNodes) throw new Error(`Unknown package: "${nodeDefinition.packageName}@${nodeDefinition.packageVersion}"`);

		const NodeClass = packageNodes.get(nodeDefinition.nodeName);

		if (!NodeClass) throw new Error(`Unknown node: "${nodeDefinition.nodeName}" in package "${nodeDefinition.packageName}@${nodeDefinition.packageVersion}"`);

		const classApiVersion = (NodeClass as unknown as typeof BufferedAudioNode).apiVersion;

		if (classApiVersion !== definition.apiVersion) {
			throw new Error(`apiVersion mismatch for node "${nodeDefinition.nodeName}": class is apiVersion ${classApiVersion}, bag is apiVersion ${definition.apiVersion}`);
		}

		const instance = new NodeClass({
			...(nodeDefinition.parameters ?? {}),
			id: nodeDefinition.id,
			packageVersion: nodeDefinition.packageVersion,
			...(nodeDefinition.options?.bypass !== undefined ? { bypass: nodeDefinition.options.bypass } : {}),
		});

		nodeMap.set(nodeDefinition.id, instance);
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

	for (const nodeDefinition of definition.nodes) {
		if (!targetIds.has(nodeDefinition.id)) {
			const node = nodeMap.get(nodeDefinition.id);

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
