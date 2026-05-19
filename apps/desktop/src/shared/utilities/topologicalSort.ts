import type { GraphEdge, GraphNode } from "@buffered-audio/core";

/**
 * Topological sort using Kahn's algorithm.
 * Returns layers where each layer contains node IDs that can execute in parallel.
 * Layer 0 contains source nodes (no incoming edges). Layer N depends only on layers < N.
 */
export function topologicalSort(nodes: Array<GraphNode>, edges: Array<GraphEdge>): Array<Array<string>> {
	const nodeIds = new Set(nodes.map((node) => node.id));
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, Array<string>>();

	for (const id of nodeIds) {
		inDegree.set(id, 0);
		adjacency.set(id, []);
	}

	for (const edge of edges) {
		inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);

		const neighbors = adjacency.get(edge.from);

		if (neighbors) neighbors.push(edge.to);
	}

	const layers: Array<Array<string>> = [];
	let currentLayer = [...nodeIds].filter((id) => inDegree.get(id) === 0);
	let processed = 0;

	while (currentLayer.length > 0) {
		layers.push(currentLayer);
		processed += currentLayer.length;

		const nextLayer: Array<string> = [];

		for (const id of currentLayer) {
			const neighbors = adjacency.get(id);

			if (!neighbors) continue;

			for (const neighbor of neighbors) {
				const newDegree = (inDegree.get(neighbor) ?? 0) - 1;

				inDegree.set(neighbor, newDegree);

				if (newDegree === 0) {
					nextLayer.push(neighbor);
				}
			}
		}

		currentLayer = nextLayer;
	}

	if (processed !== nodeIds.size) {
		throw new Error("Cycle detected in graph");
	}

	return layers;
}
