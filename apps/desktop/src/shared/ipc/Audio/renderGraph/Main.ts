import type { NodeRegistry, ProgressPayload, StreamIdentity } from "@buffered-audio/core";
import { createRenderJobs } from "@buffered-audio/core";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import type { AudioProgressPayload } from "../../../utilities/emitToRenderer";
import { RENDER_GRAPH_ACTION, type RenderGraphInput, type RenderGraphIpcParameters, type RenderGraphIpcReturn } from "./Renderer";

export class RenderGraphMainIpc extends AsyncMainIpc<RenderGraphIpcParameters, RenderGraphIpcReturn> {
	action = RENDER_GRAPH_ACTION;

	async handler(input: RenderGraphInput, dependencies: IpcHandlerDependencies): Promise<RenderGraphIpcReturn> {
		const { browserWindow, jobManager, nodeRegistry } = dependencies;
		const { jobId, definition } = input;

		const signal = jobManager.getOrCreateSignal(jobId);

		try {
			// Bridges the desktop's `NodeClass` values to core's bare-ctor `NodeRegistry`: same object, structural superset, blocked only by `Map` generic invariance.
			const jobs = createRenderJobs(definition, nodeRegistry as unknown as NodeRegistry, { signal });

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
