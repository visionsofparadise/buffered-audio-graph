import type { GraphDefinition } from "@buffered-audio/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioProgressPayload } from "../../../../../shared/utilities/emitToRenderer";
import type { GraphContext } from "../../../../Models/Context";

export interface UseRenderJobReturn {
	readonly startRender: (parameters: Record<string, string>) => Promise<void>;
	readonly abortRender: () => Promise<void>;
	readonly clearRenderError: () => void;
	readonly surfaceRenderError: (message: string) => void;
	readonly activeJobId: string | null;
	readonly processingNodes: Map<string, number>;
	readonly renderError: string | null;
}

function mintJobId(): string {
	return crypto.randomUUID();
}

export function unreadyRenderPairs(
	nodes: ReadonlyArray<{ readonly packageName: string; readonly packageVersion: string }>,
	packages: ReadonlyArray<{ readonly name: string; readonly version: string | null; readonly status: string }>,
): Array<string> {
	const seen = new Set<string>();
	const missing: Array<string> = [];

	for (const node of nodes) {
		const key = `${node.packageName}@${node.packageVersion}`;

		if (seen.has(key)) continue;

		seen.add(key);

		const ready = packages.some(
			(entry) => entry.name === node.packageName && entry.version === node.packageVersion && entry.status === "ready",
		);

		if (!ready) missing.push(key);
	}

	return missing;
}

export function useRenderJob(context: GraphContext): UseRenderJobReturn {
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [processingNodes, setProcessingNodes] = useState<Map<string, number>>(() => new Map());
	const [renderError, setRenderError] = useState<string | null>(null);

	const activeJobIdRef = useRef<string | null>(null);

	useEffect(() => {
		activeJobIdRef.current = activeJobId;
	}, [activeJobId]);

	const startRender = useCallback(
		async (parameters: Record<string, string>) => {
			if (unreadyRenderPairs(context.graphDefinition.nodes, context.app.packages).length > 0) return;

			const jobId = mintJobId();

			setActiveJobId(jobId);
			setProcessingNodes(new Map());
			setRenderError(null);

			const definition = structuredClone(context.graphDefinition.op.unwrap()) as GraphDefinition;

			try {
				await context.main.audioRenderGraph({ jobId, definition, parameters });

				if (activeJobIdRef.current !== jobId) return;

				setActiveJobId(null);
				setProcessingNodes(new Map());
			} catch (error) {
				if (activeJobIdRef.current !== jobId) return;

				setActiveJobId(null);
				setProcessingNodes(new Map());
				setRenderError(error instanceof Error ? error.message : String(error));
			}
		},
		[context],
	);

	const abortRender = useCallback(async () => {
		if (activeJobIdRef.current === null) return;

		await context.main.audioAbortJob(activeJobIdRef.current);
		setActiveJobId(null);
		setProcessingNodes(new Map());
	}, [context.main]);

	const clearRenderError = useCallback(() => {
		setRenderError(null);
	}, []);

	const surfaceRenderError = useCallback((message: string) => {
		setActiveJobId(null);
		setProcessingNodes(new Map());
		setRenderError(message);
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

	return { startRender, abortRender, clearRenderError, surfaceRenderError, activeJobId, processingNodes, renderError };
}
