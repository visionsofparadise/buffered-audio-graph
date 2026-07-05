import type { GraphDefinition } from "@buffered-audio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioProgressPayload } from "../../../../../shared/utilities/emitToRenderer";
import type { GraphContext } from "../../../../models/Context";
import { buildRenderPlan, diffStaleNodes, executeRenderPlan } from "./renderCoordinator";

export interface UseRenderJobReturn {
	readonly startRender: () => Promise<void>;
	readonly abortRender: () => Promise<void>;
	readonly activeJobId: string | null;
	readonly processingNodes: Map<string, number>;
	readonly errorNodes: Set<string>;
}

function mintJobId(): string {
	return crypto.randomUUID();
}

export function useRenderJob(refresh: () => void, context: GraphContext): UseRenderJobReturn {
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [processingNodes, setProcessingNodes] = useState<Map<string, number>>(() => new Map());
	const [errorNodes, setErrorNodes] = useState<Set<string>>(() => new Set());

	const activeJobIdRef = useRef<string | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	useEffect(() => {
		activeJobIdRef.current = activeJobId;
	}, [activeJobId]);

	const startRender = useCallback(async () => {
		const jobId = mintJobId();
		const controller = new AbortController();

		abortControllerRef.current = controller;
		setActiveJobId(jobId);
		setProcessingNodes(new Map());
		setErrorNodes(new Set());

		const { _key, ...rest } = context.graphDefinition;
		const graphDefinition = structuredClone(rest) as GraphDefinition;
		const snapshotsDir = `${context.userDataPath}/snapshots`;

		try {
			const plan = await buildRenderPlan(graphDefinition, snapshotsDir, context.bagId);
			const stale = await diffStaleNodes(plan, context.main);

			await executeRenderPlan(plan, stale, graphDefinition, jobId, context.main, controller.signal);

			if (activeJobIdRef.current !== jobId) return;

			setActiveJobId(null);
			setProcessingNodes(new Map());
			refresh();
		} catch (error) {
			if (activeJobIdRef.current !== jobId) return;

			const isAbort = error instanceof DOMException && error.name === "AbortError";

			if (isAbort) {
				setActiveJobId(null);
				setProcessingNodes(new Map());

				return;
			}

			setProcessingNodes((previous) => {
				setErrorNodes(new Set(previous.keys()));

				return new Map();
			});
			setActiveJobId(null);
		}
	}, [context, refresh]);

	const abortRender = useCallback(async () => {
		if (activeJobIdRef.current === null) return;

		abortControllerRef.current?.abort();
		await context.main.audioAbortJob(activeJobIdRef.current);
		setActiveJobId(null);
		setProcessingNodes(new Map());
	}, [context.main]);

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

	return { startRender, abortRender, activeJobId, processingNodes, errorNodes };
}
