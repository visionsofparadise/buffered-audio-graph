import type { BufferedAudioNode, GraphDefinition, NodeRegistry, ProgressPayload, StreamIdentity } from "@buffered-audio/core";
import { createRenderJobs } from "@buffered-audio/core";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { resolvePackageNodes, type NodeClass, type NodeRegistryMap } from "../../../models/NodeRegistry";
import type { AudioProgressPayload } from "../../../utilities/emitToRenderer";
import { RENDER_GRAPH_ACTION, type RenderGraphInput, type RenderGraphIpcParameters, type RenderGraphIpcReturn } from "./Renderer";

type CoreNodeConstructor = new (options?: Record<string, unknown>) => BufferedAudioNode;

/** The installed nodes for a package at the highest installed version, if any. */
function latestInstalledNodes(registry: NodeRegistryMap, packageName: string): { version: string; nodes: Map<string, NodeClass> } | undefined {
	const versions = registry.get(packageName);

	if (!versions || versions.size === 0) return undefined;

	let winner: { version: string; nodes: Map<string, NodeClass> } | undefined;

	for (const [version, nodes] of versions) {
		if (!winner || version.localeCompare(winner.version, undefined, { numeric: true, sensitivity: "base" }) > 0) {
			winner = { version, nodes };
		}
	}

	return winner;
}

/**
 * Project the main-process version-keyed registry through the bag's `packages`
 * map into core's two-level `Map<packageName, Map<nodeName, NodeClass>>`. The
 * exact pinned version wins; when it is not installed (the built-in package is
 * `@latest`, so it advances past a bag's older pin) the latest installed version
 * of the same package is used with a warning, rather than failing the render. A
 * package with no installed version at all throws, naming it.
 */
function projectRegistry(registry: NodeRegistryMap, definition: GraphDefinition, logger: IpcHandlerDependencies["logger"]): NodeRegistry {
	const projected: NodeRegistry = new Map();

	for (const [packageName, version] of Object.entries(definition.packages)) {
		let packageNodes = resolvePackageNodes(registry, packageName, version);

		if (!packageNodes) {
			const fallback = latestInstalledNodes(registry, packageName);

			if (!fallback) {
				throw new Error(`Package "${packageName}@${version}" not found in node registry`);
			}

			logger.warn(`Bag pins ${packageName}@${version}, which is not installed — rendering with the installed ${packageName}@${fallback.version}`, {
				namespace: "render",
			});
			packageNodes = fallback.nodes;
		}

		const coreNodes = new Map<string, CoreNodeConstructor>();

		for (const [nodeName, NodeClass] of packageNodes) {
			coreNodes.set(nodeName, NodeClass);
		}

		projected.set(packageName, coreNodes);
	}

	return projected;
}

export class RenderGraphMainIpc extends AsyncMainIpc<RenderGraphIpcParameters, RenderGraphIpcReturn> {
	action = RENDER_GRAPH_ACTION;

	async handler(input: RenderGraphInput, dependencies: IpcHandlerDependencies): Promise<RenderGraphIpcReturn> {
		const { browserWindow, jobManager, nodeRegistry, logger } = dependencies;
		const { jobId, definition } = input;

		const registry = projectRegistry(nodeRegistry, definition, logger);
		const signal = jobManager.getOrCreateSignal(jobId);

		try {
			const jobs = createRenderJobs(definition, registry, { signal });

			for (const job of jobs) {
				job.events.on("progress", (identity: StreamIdentity, payload: ProgressPayload): void => {
					const progressPayload: AudioProgressPayload = {
						jobId,
						nodeId: identity.nodeId ?? identity.nodeName,
						phase: payload.phase,
						framesDone: payload.framesDone,
						framesTotal: payload.framesTotal,
					};

					browserWindow.webContents.send("audio:progress", progressPayload);
				});
			}

			await Promise.all(jobs.map((job) => job.render()));
		} finally {
			jobManager.completeJob(jobId);
		}

		return undefined;
	}
}
