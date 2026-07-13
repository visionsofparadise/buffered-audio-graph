import type { GraphDefinition } from "@buffered-audio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioProgressPayload } from "../../../../../shared/utilities/emitToRenderer";
import type { GraphContext } from "../../../../models/Context";

export interface UseRenderJobReturn {
	readonly startRender: () => Promise<void>;
	readonly abortRender: () => Promise<void>;
	readonly clearRenderError: () => void;
	readonly activeJobId: string | null;
	readonly processingNodes: Map<string, number>;
	readonly renderError: string | null;
}

function mintJobId(): string {
	return crypto.randomUUID();
}

/**
 * Thin IPC driver for full-graph rendering. `startRender` mints a jobId,
 * snapshots the current definition, and awaits `audioRenderGraph`; a rejection
 * (core's leaf-must-be-a-target validation, a missing package, or a DSP
 * failure) is stored as `renderError` for the render toast. `audio:progress`
 * events update the per-node fraction map used for the aggregate bar.
 */
export function useRenderJob(context: GraphContext): UseRenderJobReturn {
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [processingNodes, setProcessingNodes] = useState<Map<string, number>>(() => new Map());
	const [renderError, setRenderError] = useState<string | null>(null);

	const activeJobIdRef = useRef<string | null>(null);

	useEffect(() => {
		activeJobIdRef.current = activeJobId;
	}, [activeJobId]);

	const startRender = useCallback(async () => {
		const jobId = mintJobId();

		setActiveJobId(jobId);
		setProcessingNodes(new Map());
		setRenderError(null);

		const { _key, ...rest } = context.graphDefinition;
		const definition = structuredClone(rest) as GraphDefinition;

		try {
			await context.main.audioRenderGraph({ jobId, definition });

			if (activeJobIdRef.current !== jobId) return;

			setActiveJobId(null);
			setProcessingNodes(new Map());
		} catch (error) {
			if (activeJobIdRef.current !== jobId) return;

			setActiveJobId(null);
			setProcessingNodes(new Map());
			setRenderError(error instanceof Error ? error.message : String(error));
		}
	}, [context]);

	const abortRender = useCallback(async () => {
		if (activeJobIdRef.current === null) return;

		await context.main.audioAbortJob(activeJobIdRef.current);
		setActiveJobId(null);
		setProcessingNodes(new Map());
	}, [context.main]);

	const clearRenderError = useCallback(() => {
		setRenderError(null);
	}, []);

	useEffect(() => {
		const handler = (payload: AudioProgressPayload): void => {
			if (payload.jobId !== activeJobIdRef.current) return;

			const { framesTotal } = payload;

			if (framesTotal === undefined) return;

			setProcessingNodes((previous) => {
				const next = new Map(previous);

				next.set(payload.nodeId, payload.framesDone / framesTotal);

				return next;
			});
		};

		context.mainEvents.on("audio:progress", handler);

		return () => {
			context.mainEvents.off("audio:progress", handler);
		};
	}, [context.mainEvents]);

	return { startRender, abortRender, clearRenderError, activeJobId, processingNodes, renderError };
}
