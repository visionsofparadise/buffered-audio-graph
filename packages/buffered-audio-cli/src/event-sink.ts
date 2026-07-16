import {
	BufferedSourceStream,
	type FinishedPayload,
	type LogPayload,
	type ProgressPayload,
	type RenderEvents,
	type RenderJob,
	type RenderLivenessPayload,
	type StartedPayload,
	type StreamIdentity,
} from "@buffered-audio/core";

export type EventWriter = (text: string) => void;

const labelOf = (identity: StreamIdentity): string => (identity.nodeId !== undefined ? `${identity.nodeName}#${identity.nodeId}` : `${identity.nodeName}#${identity.streamId}`);

function sourceLabel(job: RenderJob): string | undefined {
	for (const streams of job.streams.values()) {
		for (const stream of streams) {
			if (stream instanceof BufferedSourceStream) return labelOf(stream.identity);
		}
	}

	return undefined;
}

function stamp(createdAt: number): string {
	const date = new Date(createdAt);
	const pad = (value: number): string => String(value).padStart(2, "0");

	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function subscribeRenderEvents(events: RenderEvents, getSourceLabel: () => string, write: EventWriter): void {
	events.on("liveness", ({ createdAt, elapsedMs }: RenderLivenessPayload) => {
		write(`${stamp(createdAt)} [${getSourceLabel()}] render active elapsed=${Math.round(elapsedMs / 1000)}s\n`);
	});

	events.on("started", (node: StreamIdentity, payload: StartedPayload) => {
		write(`${stamp(payload.createdAt)} [${labelOf(node)}] started\n`);
	});

	events.on("progress", (node: StreamIdentity, payload: ProgressPayload) => {
		const label = labelOf(node);

		if (payload.framesTotal !== undefined) {
			const percent = Math.round((payload.framesDone / payload.framesTotal) * 100);

			write(`${stamp(payload.createdAt)} [${label}] ${payload.phase} ${percent}%\n`);
		} else {
			write(`${stamp(payload.createdAt)} [${label}] ${payload.phase} frames=${payload.framesDone}\n`);
		}
	});

	events.on("log", (node: StreamIdentity, payload: LogPayload) => {
		const data = payload.data ? Object.entries(payload.data).map(([key, value]) => `${key}=${String(value)}`) : [];
		const parts = [payload.message, ...data].join(" ");
		const prefix = payload.level === "warn" ? "warn: " : "";

		write(`${stamp(payload.createdAt)} ${prefix}[${labelOf(node)}] ${parts}\n`);
	});

	events.on("finished", (node: StreamIdentity, payload: FinishedPayload) => {
		const ms = payload.processingMs !== undefined ? ` ms=${Math.round(payload.processingMs)}` : "";

		write(`${stamp(payload.createdAt)} [${labelOf(node)}] finished frames=${payload.framesDone}${ms}\n`);
	});
}

export function createEventSink(write: EventWriter = (text) => process.stdout.write(text)): { subscribe(job: RenderJob): void; printSummary(jobs: ReadonlyArray<RenderJob>): void } {
	// Keyed by streamId, not label: id-less same-type nodes share a label but each has a unique streamId.
	const totals = new Map<number, { label: string; framesDone: number; processingMs?: number }>();

	const subscribe = (job: RenderJob): void => {
		subscribeRenderEvents(job.events, () => sourceLabel(job) ?? "source", write);
		job.events.on("finished", (node, payload) => {
			totals.set(node.streamId, { label: labelOf(node), framesDone: payload.framesDone, processingMs: payload.processingMs });
		});
	};

	const printSummary = (jobs: ReadonlyArray<RenderJob>): void => {
		for (const { label, framesDone, processingMs } of totals.values()) {
			if (processingMs !== undefined) {
				write(`${stamp(Date.now())} [${label}] processed ${framesDone} frames in ${Math.round(processingMs)}ms\n`);
			} else {
				write(`${stamp(Date.now())} [${label}] processed ${framesDone} frames\n`);
			}
		}

		for (const job of jobs) {
			const timing = job.timing;

			if (!timing) continue;

			const label = sourceLabel(job) ?? "source";

			write(`${stamp(Date.now())} [${label}] total ${(timing.totalMs / 1000).toFixed(1)}s, ${timing.realTimeMultiplier.toFixed(1)}x RT\n`);
		}
	};

	return { subscribe, printSummary };
}
