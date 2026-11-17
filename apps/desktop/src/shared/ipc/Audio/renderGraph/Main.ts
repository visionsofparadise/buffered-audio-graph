import { createRenderJobs, isAbortReason } from "@buffered-audio/core";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { emitToRenderer, type AudioProgressPayload } from "../../../utilities/emitToRenderer";
import {
	RENDER_GRAPH_ACTION,
	type RenderGraphInput,
	type RenderGraphIpcParameters,
	type RenderGraphIpcReturn,
} from "./Renderer";
import type { ProgressPayload, StreamIdentity } from "@buffered-audio/core";

export class RenderGraphMainIpc extends AsyncMainIpc<RenderGraphIpcParameters, RenderGraphIpcReturn> {
	action = RENDER_GRAPH_ACTION;

	async handler(input: RenderGraphInput, dependencies: IpcHandlerDependencies): Promise<RenderGraphIpcReturn> {
		const { browserWindow, jobManager, nodeRegistry } = dependencies;
		const { jobId, definition, parameters } = input;

		const signal = jobManager.getOrCreateSignal(jobId);

		try {
			const jobs = createRenderJobs(definition, nodeRegistry, { signal, parameters });

			for (const job of jobs) {
				job.events.on("progress", (identity: StreamIdentity, payload: ProgressPayload): void => {
					const progressPayload: AudioProgressPayload = {
						jobId,
						nodeId: identity.nodeId ?? identity.nodeName,
						phase: payload.phase,
						framesDone: payload.framesDone,
						framesTotal: payload.framesTotal,
					};

					emitToRenderer(browserWindow, "audio:progress", progressPayload);
				});
			}

			const results = await Promise.allSettled(jobs.map((job) => job.render()));
			const failures = results.filter((result) => result.status === "rejected");
			const failure = failures.find((result) => !isAbortReason(result.reason, signal)) ?? failures[0];

			if (failure && !(signal.aborted && isAbortReason(failure.reason, signal))) throw failure.reason;
		} finally {
			jobManager.completeJob(jobId);
		}

		return undefined;
	}
}
