import { stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { GraphNode } from "@buffered-audio/core";
import type { SourceNode, TransformNode } from "@buffered-audio/core";
import { ReadNode, WriteNode } from "@buffered-audio/nodes";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { resolvePackageModules, type ModuleClass, type ModuleRegistryMap } from "../../../models/ModuleRegistry";
import type { Logger } from "../../../models/Logger";
import { contentHash } from "../../../utilities/contentHash";
import { topologicalSort } from "../../../utilities/topologicalSort";
import type { AudioChainCompletePayload, AudioProgressPayload } from "../../../utilities/emitToRenderer";
import type { JobManager } from "../apply/utils/jobManager";
import { RENDER_GRAPH_ACTION, type RenderGraphInput, type RenderGraphIpcParameters, type RenderGraphIpcReturn } from "./Renderer";

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

/** Check whether a snapshot file exists at the given path. */
async function snapshotExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);

		return true;
	} catch {
		return false;
	}
}

/** Look up a module constructor from the registry by package identity and nodeName. */
function resolveModule(registry: ModuleRegistryMap, packageName: string, packageVersion: string, nodeName: string): ModuleClass {
	const packageModules = resolvePackageModules(registry, packageName, packageVersion);

	if (!packageModules) {
		throw new Error(`Package "${packageName}@${packageVersion}" not found in module registry`);
	}

	const ModuleConstructor = packageModules.get(nodeName);

	if (!ModuleConstructor) {
		throw new Error(`Module "${nodeName}" not found in package "${packageName}@${packageVersion}"`);
	}

	return ModuleConstructor;
}

/**
 * Render a source node pipeline with progress forwarding.
 *
 * `render()` populates `sourceNode.streams` synchronously during its setup
 * phase before the first internal `await`. Calling `render()` without awaiting
 * lets us subscribe to stream progress events before data starts flowing.
 */
async function renderWithProgress(
	sourceNode: ReadNode,
	signal: AbortSignal,
	jobId: string,
	nodeId: string,
	browserWindow: BrowserWindow,
): Promise<void> {
	const renderPromise = sourceNode.render({ signal });

	for (const stream of sourceNode.streams) {
		stream.events.on("progress", (data: { framesProcessed: number; sourceTotalFrames?: number }) => {
			const payload: AudioProgressPayload = {
				jobId,
				nodeId,
				framesProcessed: data.framesProcessed,
				sourceTotalFrames: data.sourceTotalFrames ?? 0,
			};

			browserWindow.webContents.send("audio:progress", payload);
		});
	}

	await renderPromise;
}

/** Look up a graph node by ID, throwing if not found. */
function getGraphNode(nodeMap: Map<string, GraphNode>, nodeId: string): GraphNode {
	const node = nodeMap.get(nodeId);

	if (!node) {
		throw new Error(`Graph node "${nodeId}" not found`);
	}

	return node;
}

/** Look up a computed hash by node ID, throwing if not found. */
function getNodeHash(nodeHashes: Map<string, string>, nodeId: string): string {
	const hash = nodeHashes.get(nodeId);

	if (hash === undefined) {
		throw new Error(`Content hash not computed for node "${nodeId}"`);
	}

	return hash;
}

export class RenderGraphMainIpc extends AsyncMainIpc<RenderGraphIpcParameters, RenderGraphIpcReturn> {
	action = RENDER_GRAPH_ACTION;

	handler(input: RenderGraphInput, dependencies: IpcHandlerDependencies): RenderGraphIpcReturn {
		const { jobManager, browserWindow, logger, moduleRegistry } = dependencies;
		const { id, signal } = jobManager.startJob();

		void this.execute(input, id, signal, browserWindow, logger, moduleRegistry, jobManager);

		return { jobId: id };
	}

	private async execute(
		input: RenderGraphInput,
		jobId: string,
		signal: AbortSignal,
		browserWindow: BrowserWindow,
		logger: Logger,
		moduleRegistry: ModuleRegistryMap,
		jobManager: JobManager,
	): Promise<void> {
		const { bagId, graphDefinition, snapshotsDir } = input;
		const { nodes, edges } = graphDefinition;

		try {
			const layers = topologicalSort(nodes, edges);
			const nodeMap = new Map<string, GraphNode>(nodes.map((graphNode) => [graphNode.id, graphNode]));

			// Build parent map (child -> parent). Each node has at most one incoming edge in a tree.
			const parentMap = new Map<string, string>();

			for (const edge of edges) {
				parentMap.set(edge.to, edge.from);
			}

			// Identify bypassed nodes
			const bypassedSet = new Set<string>();

			for (const node of nodes) {
				if (node.options?.bypass) {
					bypassedSet.add(node.id);
				}
			}

			// Compute content hashes in topological order
			const nodeHashes = new Map<string, string>();

			for (const layer of layers) {
				for (const nodeId of layer) {
					const node = getGraphNode(nodeMap, nodeId);
					const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";
					const upstreamHash = resolveUpstreamHash(nodeId, parentMap, bypassedSet, nodeHashes);
					const hash = contentHash(
						upstreamHash,
						node.packageName,
						packageVersion,
						node.nodeName,
						node.parameters ?? {},
						node.options?.bypass ?? false,
					);

					nodeHashes.set(nodeId, hash);
				}
			}

			// Build snapshot paths and determine which nodes need rendering.
			// For each non-bypassed node, record its snapshot directory and its input audio path.
			const snapshotPaths = new Map<string, string>();
			const staleNodes = new Set<string>();
			const nodeInputPaths = new Map<string, string>();

			for (const layer of layers) {
				for (const nodeId of layer) {
					if (bypassedSet.has(nodeId)) continue;

					const node = getGraphNode(nodeMap, nodeId);
					const hash = getNodeHash(nodeHashes, nodeId);
					const snapshotDir = join(snapshotsDir, bagId, nodeId, hash);
					const audioPath = join(snapshotDir, "audio.wav");

					snapshotPaths.set(nodeId, snapshotDir);

					// Determine input path
					const isSourceNode = !parentMap.has(nodeId);

					if (isSourceNode) {
						const path = typeof node.parameters?.path === "string" ? node.parameters.path : "";

						nodeInputPaths.set(nodeId, path);
					} else {
						// Walk back to the nearest non-bypassed ancestor
						let ancestorId = parentMap.get(nodeId);

						while (ancestorId !== undefined && bypassedSet.has(ancestorId)) {
							ancestorId = parentMap.get(ancestorId);
						}

						if (ancestorId !== undefined) {
							const ancestorHash = getNodeHash(nodeHashes, ancestorId);

							nodeInputPaths.set(nodeId, join(snapshotsDir, bagId, ancestorId, ancestorHash, "audio.wav"));
						}
					}

					const exists = await snapshotExists(audioPath);

					if (!exists) {
						staleNodes.add(nodeId);
					}
				}
			}

			// Render stale nodes layer by layer (parallel within each layer)
			for (const layer of layers) {
				const staleInLayer = layer.filter((nodeId) => staleNodes.has(nodeId));

				if (staleInLayer.length === 0) continue;

				if (signal.aborted) {
					browserWindow.webContents.send("audio:chainComplete", { jobId, status: "aborted" } satisfies AudioChainCompletePayload);
					jobManager.completeJob(jobId);

					return;
				}

				await Promise.all(
					staleInLayer.map(async (nodeId) => {
						if (signal.aborted) return;

						const node = getGraphNode(nodeMap, nodeId);
						const hash = getNodeHash(nodeHashes, nodeId);
						const snapshotDir = join(snapshotsDir, bagId, nodeId, hash);
						const outputPath = join(snapshotDir, "audio.wav");

						await mkdir(snapshotDir, { recursive: true });

						const isSourceNode = !parentMap.has(nodeId);
						const inputPath = nodeInputPaths.get(nodeId);

						if (isSourceNode) {
							// Source node: instantiate from registry, pipe to WriteNode
							const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";
							const SourceConstructor = resolveModule(
								moduleRegistry,
								node.packageName,
								packageVersion,
								node.nodeName,
							);
							const sourceInstance = new SourceConstructor(node.parameters ?? {}) as SourceNode;
							const writeInstance = new WriteNode({ path: outputPath, bitDepth: "32f" });

							sourceInstance.to(writeInstance);

							await renderWithProgress(sourceInstance as ReadNode, signal, jobId, nodeId, browserWindow);
						} else {
							// Transform node: ReadNode(parent snapshot) -> transform -> WriteNode(snapshot)
							if (!inputPath) {
								throw new Error(`No input path resolved for node "${nodeId}"`);
							}

							const readInstance = new ReadNode({ path: inputPath, ffmpegPath: "", ffprobePath: "" });

							const packageVersion = typeof node.packageVersion === "string" ? node.packageVersion : "";
							const TransformConstructor = resolveModule(
								moduleRegistry,
								node.packageName,
								packageVersion,
								node.nodeName,
							);
							const transformInstance = new TransformConstructor(node.parameters ?? {}) as TransformNode;
							const writeInstance = new WriteNode({ path: outputPath, bitDepth: "32f" });

							readInstance.to(transformInstance);
							transformInstance.to(writeInstance);

							await renderWithProgress(readInstance, signal, jobId, nodeId, browserWindow);
						}
					}),
				);
			}

			// Successful completion
			const resultPaths: Record<string, string> = {};

			for (const [nodeId, dirPath] of snapshotPaths) {
				resultPaths[nodeId] = dirPath;
			}

			const completePayload: AudioChainCompletePayload = {
				jobId,
				status: "completed",
				snapshotPaths: resultPaths,
			};

			browserWindow.webContents.send("audio:chainComplete", completePayload);
			jobManager.completeJob(jobId);
		} catch (error) {
			logger.error("renderGraph failed", error as Error, { namespace: "audio", jobId });
			browserWindow.webContents.send("audio:chainComplete", { jobId, status: "failed" } satisfies AudioChainCompletePayload);
			jobManager.completeJob(jobId);
		}
	}
}
