import type { BufferedAudioNode, GraphDefinition, NodeRegistry, ProgressPayload, StreamIdentity } from "@buffered-audio/core";
import { createRenderJobs } from "@buffered-audio/core";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { resolvePackageNodes, type NodeRegistryMap } from "../../../models/NodeRegistry";
import type { AudioProgressPayload } from "../../../utilities/emitToRenderer";
import { RENDER_GRAPH_ACTION, type RenderGraphInput, type RenderGraphIpcParameters, type RenderGraphIpcReturn } from "./Renderer";

type CoreNodeConstructor = new (options?: Record<string, unknown>) => BufferedAudioNode;

/**
 * Project the main-process version-keyed registry through the bag's `packages`
 * map into core's two-level `Map<packageName, Map<nodeName, NodeClass>>`. An
 * entry whose `name@version` is absent from the installed registry throws
 * naming it — the missing-package error surfaces in the render toast.
 */
function projectRegistry(registry: NodeRegistryMap, definition: GraphDefinition): NodeRegistry {
	const projected: NodeRegistry = new Map();

	for (const [packageName, version] of Object.entries(definition.packages)) {
		const packageNodes = resolvePackageNodes(registry, packageName, version);

		if (!packageNodes) {
			throw new Error(`Package "${packageName}@${version}" not found in node registry`);
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
		const { browserWindow, jobManager, nodeRegistry } = dependencies;
		const { jobId, definition } = input;

		const registry = projectRegistry(nodeRegistry, definition);
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
