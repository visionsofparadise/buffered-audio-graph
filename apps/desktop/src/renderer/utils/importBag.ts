import type { GraphDefinition, GraphEdge, GraphNode } from "@buffered-audio/core";
import { computeAutoLayout } from "./autoLayout";

const IMPORT_CLUSTER_GAP = 240;

type NodePositions = Record<string, { x: number; y: number }>;

interface MergeImportedBagOptions {
	readonly currentDefinition: GraphDefinition;
	readonly currentPositions: NodePositions;
	readonly importedDefinition: GraphDefinition;
}

interface MergeImportedBagResult {
	readonly definition: GraphDefinition;
	readonly positions: NodePositions;
	readonly importedNodeCount: number;
}

interface Bounds {
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
}

function clonePositions(positions: NodePositions): NodePositions {
	return Object.fromEntries(
		Object.entries(positions).map(([nodeId, position]) => [
			nodeId,
			{ x: position.x, y: position.y },
		]),
	);
}

function computeBounds(positions: NodePositions): Bounds | null {
	const values = Object.values(positions);

	if (values.length === 0) return null;

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;

	for (const position of values) {
		minX = Math.min(minX, position.x);
		maxX = Math.max(maxX, position.x);
		minY = Math.min(minY, position.y);
	}

	return { minX, maxX, minY };
}

function offsetImportedPositions(importedPositions: NodePositions, existingPositions: NodePositions): NodePositions {
	const importedBounds = computeBounds(importedPositions);

	if (!importedBounds) return importedPositions;

	const existingBounds = computeBounds(existingPositions);

	if (!existingBounds) return importedPositions;

	const offsetX = existingBounds.maxX + IMPORT_CLUSTER_GAP - importedBounds.minX;
	const offsetY = existingBounds.minY - importedBounds.minY;

	return Object.fromEntries(
		Object.entries(importedPositions).map(([nodeId, position]) => [
			nodeId,
			{ x: position.x + offsetX, y: position.y + offsetY },
		]),
	);
}

export function mergeImportedBag({
	currentDefinition,
	currentPositions,
	importedDefinition,
}: MergeImportedBagOptions): MergeImportedBagResult {
	if (importedDefinition.apiVersion !== currentDefinition.apiVersion) {
		throw new Error(
			`Cannot import a bag on API version ${String(importedDefinition.apiVersion)} into a bag on API version ${String(currentDefinition.apiVersion)}`,
		);
	}

	const idMap = new Map<string, string>();
	const importedNodes: Array<GraphNode> = importedDefinition.nodes.map((node) => {
		const nextId = crypto.randomUUID();

		idMap.set(node.id, nextId);

		return {
			...node,
			id: nextId,
		};
	});

	const importedEdges: Array<GraphEdge> = importedDefinition.edges.flatMap((edge) => {
		const from = idMap.get(edge.from);
		const to = idMap.get(edge.to);

		return from && to ? [{ from, to }] : [];
	});

	const importedPositions = offsetImportedPositions(
		computeAutoLayout(importedNodes, importedEdges),
		currentPositions,
	);

	return {
		definition: {
			...currentDefinition,
			nodes: [...currentDefinition.nodes, ...importedNodes],
			edges: [...currentDefinition.edges, ...importedEdges],
		},
		positions: {
			...clonePositions(currentPositions),
			...importedPositions,
		},
		importedNodeCount: importedNodes.length,
	};
}
