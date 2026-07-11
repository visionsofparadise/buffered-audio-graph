import type { GraphNode } from "@buffered-audio/core";
import { useCallback, useEffect, useState } from "react";
import { topologicalSort } from "../../../../../shared/utilities/topologicalSort";
import type { GraphContext } from "../../../../models/Context";
import { contentHash } from "../../../../utils/contentHash";
import type { NodeState } from "../Node/Container";

interface NodeStateEntry {
	readonly state: NodeState;
	readonly hash: string;
}

interface UseNodeStatesReturn {
	readonly nodeStates: Map<string, NodeStateEntry>;
	readonly refresh: () => void;
}

function getParentIds(nodeId: string, edges: GraphContext["graphDefinition"]["edges"]): Array<string> {
	return edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
}

/**
 * For a given parent node, walk back through bypassed ancestors to find the nearest
 * non-bypassed ancestor's hash. If all ancestors are bypassed (or the parent is a
 * bypassed source node), returns "".
 */
function resolveUpstreamHash(
	parentId: string,
	nodeMap: Map<string, GraphNode>,
	edges: GraphContext["graphDefinition"]["edges"],
	computedHashes: Map<string, string>,
): string {
	const parentNode = nodeMap.get(parentId);

	if (!parentNode) return "";

	if (parentNode.options?.bypass !== true) {
		return computedHashes.get(parentId) ?? "";
	}

	const grandparentIds = getParentIds(parentId, edges);

	if (grandparentIds.length === 0) return "";

	const firstGrandparent = grandparentIds[0];

	if (firstGrandparent === undefined) return "";

	return resolveUpstreamHash(firstGrandparent, nodeMap, edges, computedHashes);
}

export function useNodeStates(context: GraphContext): UseNodeStatesReturn {
	const { graphDefinition, main, userDataPath, bagId } = context;
	const [nodeStates, setNodeStates] = useState<Map<string, NodeStateEntry>>(() => new Map());

	const compute = useCallback(async () => {
		const { nodes, edges } = graphDefinition;

		if (nodes.length === 0) {
			setNodeStates(new Map());

			return;
		}

		const nodeMap = new Map<string, GraphNode>();

		for (const node of nodes) {
			nodeMap.set(node.id, node);
		}

		let layers: Array<Array<string>>;

		try {
			layers = topologicalSort([...nodes], [...edges]);
		} catch {
			setNodeStates(new Map());

			return;
		}

		const computedHashes = new Map<string, string>();

		for (const layer of layers) {
			await Promise.all(
				layer.map(async (nodeId) => {
					const node = nodeMap.get(nodeId);

					if (!node) return;
					const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";

					const parentIds = getParentIds(nodeId, edges);
					let upstreamHash = "";

					if (parentIds.length > 0) {
						const parentHashes = parentIds.map((parentId) =>
							resolveUpstreamHash(parentId, nodeMap, edges, computedHashes),
						);

						upstreamHash = parentHashes.join("");
					}

					const hash = await contentHash(
						upstreamHash,
						node.packageName,
						packageVersion,
						node.nodeName,
						node.parameters ?? {},
						node.options?.bypass ?? false,
					);

					computedHashes.set(nodeId, hash);
				}),
			);
		}

		const snapshotEntries = await Promise.all(
			nodes.map(async (node): Promise<[string, NodeStateEntry]> => {
				const hash = computedHashes.get(node.id) ?? "";

				if (node.options?.bypass === true) {
					return [node.id, { state: "bypassed", hash }];
				}

				const snapshotDir = `${userDataPath}/snapshots/${bagId}/${node.id}/`;
				let directoryEntries: Array<string> = [];

				try {
					directoryEntries = await main.readDirectory(snapshotDir);
				} catch {
					directoryEntries = [];
				}

				let state: NodeState;

				if (directoryEntries.includes(hash)) {
					state = "rendered";
				} else if (directoryEntries.length > 0) {
					state = "stale";
				} else {
					state = "pending";
				}

				return [node.id, { state, hash }];
			}),
		);

		setNodeStates(new Map(snapshotEntries));
	}, [graphDefinition, main, userDataPath, bagId]);

	const refresh = useCallback(() => {
		void compute();
	}, [compute]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	return { nodeStates, refresh };
}
