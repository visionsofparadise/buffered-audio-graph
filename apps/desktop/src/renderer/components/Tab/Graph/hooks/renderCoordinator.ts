import type { GraphDefinition, GraphNode } from "@buffered-audio/core";
import type { FileParamStat } from "../../../../../shared/utilities/serializeFileParamStats";
import { topologicalSort } from "../../../../../shared/utilities/topologicalSort";
import type { Main } from "../../../../models/Main";
import { contentHash } from "../../../../utils/contentHash";

export interface NodeRenderPlan {
	readonly nodeId: string;
	readonly hash: string;
	/** `{snapshotsDir}/{bagId}/{nodeId}/` — the directory whose entries are this node's cached hashes. */
	readonly nodeDir: string;
	/** `{snapshotsDir}/{bagId}/{nodeId}/{hash}/` — this render's output directory. */
	readonly snapshotDir: string;
	readonly audioPath: string;
	readonly isSourceNode: boolean;
	/** Empty string when the node is a source node. */
	readonly inputPath: string;
	readonly bypassed: boolean;
}

export interface RenderPlan {
	readonly layers: ReadonlyArray<ReadonlyArray<string>>;
	readonly plansByNodeId: ReadonlyMap<string, NodeRenderPlan>;
	readonly snapshotPathsByNodeId: ReadonlyMap<string, string>;
}

/** Resolve the nearest non-bypassed ancestor's hash by walking back through bypassed parents. */
function resolveUpstreamHash(
	nodeId: string,
	parentMap: Map<string, string>,
	bypassedSet: Set<string>,
	nodeHashes: Map<string, string>,
): string {
	let currentId = parentMap.get(nodeId);

	while (currentId !== undefined && bypassedSet.has(currentId)) {
		currentId = parentMap.get(currentId);
	}

	if (currentId === undefined) return "";

	return nodeHashes.get(currentId) ?? "";
}

/** Walk back through bypassed parents to find the nearest non-bypassed ancestor's id. */
function resolveUpstreamNodeId(
	nodeId: string,
	parentMap: Map<string, string>,
	bypassedSet: Set<string>,
): string | undefined {
	let currentId = parentMap.get(nodeId);

	while (currentId !== undefined && bypassedSet.has(currentId)) {
		currentId = parentMap.get(currentId);
	}

	return currentId;
}

/**
 * Build a full render plan for a graph: topologically sort nodes, compute
 * per-node content hashes (using bypass-aware upstream-hash resolution), and
 * derive each node's snapshot directory and input audio path. The plan is
 * pure data — it does not call any IPC; the caller supplies per-node file-param
 * stats (gathered via IPC) so the hashes match `useNodeStates`.
 */
export async function buildRenderPlan(
	graphDefinition: GraphDefinition,
	snapshotsDir: string,
	bagId: string,
	fileStatsByNodeId: ReadonlyMap<string, ReadonlyArray<FileParamStat>>,
): Promise<RenderPlan> {
	const { nodes, edges } = graphDefinition;
	const layers = topologicalSort([...nodes], [...edges]);
	const nodeMap = new Map<string, GraphNode>(nodes.map((node) => [node.id, node]));
	const parentMap = new Map<string, string>();

	for (const edge of edges) {
		parentMap.set(edge.to, edge.from);
	}

	const bypassedSet = new Set<string>();

	for (const node of nodes) {
		if (node.options?.bypass) bypassedSet.add(node.id);
	}

	const nodeHashes = new Map<string, string>();

	for (const layer of layers) {
		await Promise.all(
			layer.map(async (nodeId) => {
				const node = nodeMap.get(nodeId);

				if (!node) return;
				const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";
				const upstreamHash = resolveUpstreamHash(nodeId, parentMap, bypassedSet, nodeHashes);
				const hash = await contentHash(
					upstreamHash,
					node.packageName,
					packageVersion,
					node.nodeName,
					node.parameters ?? {},
					node.options?.bypass ?? false,
					fileStatsByNodeId.get(nodeId) ?? [],
				);

				nodeHashes.set(nodeId, hash);
			}),
		);
	}

	const plansByNodeId = new Map<string, NodeRenderPlan>();
	const snapshotPathsByNodeId = new Map<string, string>();

	for (const node of nodes) {
		const hash = nodeHashes.get(node.id) ?? "";
		const nodeDir = `${snapshotsDir}/${bagId}/${node.id}/`;
		const snapshotDir = `${nodeDir}${hash}`;
		const audioPath = `${snapshotDir}/audio.wav`;
		const isSourceNode = !parentMap.has(node.id);
		const bypassed = bypassedSet.has(node.id);

		let inputPath = "";

		if (isSourceNode) {
			inputPath = typeof node.parameters?.path === "string" ? node.parameters.path : "";
		} else {
			const ancestorId = resolveUpstreamNodeId(node.id, parentMap, bypassedSet);

			if (ancestorId !== undefined) {
				const ancestorHash = nodeHashes.get(ancestorId) ?? "";

				inputPath = `${snapshotsDir}/${bagId}/${ancestorId}/${ancestorHash}/audio.wav`;
			}
		}

		plansByNodeId.set(node.id, { nodeId: node.id, hash, nodeDir, snapshotDir, audioPath, isSourceNode, inputPath, bypassed });
		snapshotPathsByNodeId.set(node.id, snapshotDir);
	}

	return { layers, plansByNodeId, snapshotPathsByNodeId };
}

/**
 * Determine which nodes in the plan are stale (no snapshot at their current
 * hash). Bypassed nodes are never stale — they pass through their upstream.
 */
export async function diffStaleNodes(plan: RenderPlan, main: Main): Promise<Set<string>> {
	const stale = new Set<string>();

	await Promise.all(
		Array.from(plan.plansByNodeId.values()).map(async (nodePlan) => {
			if (nodePlan.bypassed) return;

			try {
				const entries = await main.readDirectory(nodePlan.nodeDir);

				if (!entries.includes(nodePlan.hash)) {
					stale.add(nodePlan.nodeId);
				}
			} catch {
				stale.add(nodePlan.nodeId);
			}
		}),
	);

	return stale;
}

/**
 * Run the planned render against the main process. Walks layer-by-layer,
 * rendering all stale nodes in each layer in parallel via `audioRenderNode`.
 * Returns once all stale nodes finish (or rejects on first failure /
 * abort-signal trip). The caller owns `jobId` — `audioAbortJob(jobId)` will
 * trip the AbortController attached to every `renderNode` call sharing it.
 */
export async function executeRenderPlan(
	plan: RenderPlan,
	staleNodes: ReadonlySet<string>,
	graphDefinition: GraphDefinition,
	jobId: string,
	main: Main,
	signal: AbortSignal,
): Promise<void> {
	const nodeMap = new Map<string, GraphNode>(graphDefinition.nodes.map((node) => [node.id, node]));

	for (const layer of plan.layers) {
		if (signal.aborted) throw new DOMException("Render aborted", "AbortError");

		const staleInLayer = layer.filter((nodeId) => staleNodes.has(nodeId));

		if (staleInLayer.length === 0) continue;

		await Promise.all(
			staleInLayer.map(async (nodeId) => {
				const nodePlan = plan.plansByNodeId.get(nodeId);
				const node = nodeMap.get(nodeId);

				if (!nodePlan || !node) return;
				const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";

				await main.audioRenderNode({
					jobId,
					nodeId,
					packageName: node.packageName,
					packageVersion,
					nodeName: node.nodeName,
					parameters: node.parameters ?? {},
					bypass: node.options?.bypass ?? false,
					isSourceNode: nodePlan.isSourceNode,
					inputPath: nodePlan.inputPath,
					outputPath: nodePlan.audioPath,
				});
			}),
		);
	}
}
