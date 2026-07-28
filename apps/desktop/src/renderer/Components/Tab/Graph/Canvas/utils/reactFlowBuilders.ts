import { buildParameters, type Parameter } from "../../Node/utils/buildParameters";
import { lookupNode } from "../../Node/utils/nodeLookup";
import type { GraphContext } from "../../../../../Models/Context";
import type { NodeContainerData } from "../../Node/Container";
import type { Edge, Node } from "@xyflow/react";

export function buildReactFlowNodes(context: GraphContext): Array<Node<NodeContainerData>> {
	const binaryDefaults = context.app.binaries as Record<string, string>;
	const connectedInputs = new Set(context.graphDefinition.edges.map((edge) => edge.to));
	const connectedOutputs = new Set(context.graphDefinition.edges.map((edge) => edge.from));

	return context.graphDefinition.nodes.map((graphNode) => {
		const { category, description, schema, unresolvedReason } = lookupNode(
			graphNode.packageName,
			graphNode.packageVersion,
			graphNode.nodeName,
			context,
		);
		const parameters: Array<Parameter> = buildParameters(graphNode, schema, binaryDefaults, context.logger);

		return {
			id: graphNode.id,
			type: "bufferedAudioNode",
			position: context.positions.positions[graphNode.id] ?? { x: 0, y: 0 },
			data: {
				label: graphNode.nodeName,
				packageName: graphNode.packageName,
				packageVersion: graphNode.packageVersion,
				nodeName: graphNode.nodeName,
				category,
				bypassed: graphNode.options?.bypass ?? false,
				inputConnected: connectedInputs.has(graphNode.id),
				outputConnected: connectedOutputs.has(graphNode.id),
				parameters,
				unresolvedReason,
				nodeId: graphNode.id,
				description,
			},
		};
	});
}

export function buildReactFlowEdges(context: GraphContext): Array<Edge> {
	return context.graphDefinition.edges.map((edge) => ({
		id: `${edge.from}-${edge.to}`,
		source: edge.from,
		target: edge.to,
		sourceHandle: "source",
		targetHandle: "target",
		type: "bufferedAudioEdge",
	}));
}
