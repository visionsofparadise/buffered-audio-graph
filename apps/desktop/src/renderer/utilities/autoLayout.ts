import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "@buffered-audio/core";

const NODE_WIDTH = 260;
const NODE_HEIGHT = 200;

export function computeAutoLayout(
	nodes: ReadonlyArray<GraphNode>,
	edges: ReadonlyArray<GraphEdge>,
): Record<string, { x: number; y: number }> {
	const graph = new dagre.graphlib.Graph();

	graph.setGraph({
		rankdir: "LR",
		nodesep: 80,
		ranksep: 200,
	});

	graph.setDefaultEdgeLabel(() => ({}));

	for (const node of nodes) {
		graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}

	for (const edge of edges) {
		graph.setEdge(edge.from, edge.to);
	}

	dagre.layout(graph);

	const positions: Record<string, { x: number; y: number }> = {};

	for (const node of nodes) {
		const layoutNode = graph.node(node.id) as { x: number; y: number };

		positions[node.id] = {
			x: layoutNode.x - NODE_WIDTH / 2,
			y: layoutNode.y - NODE_HEIGHT / 2,
		};
	}

	return positions;
}
