import { EventEmitter } from "node:events";
import { createRenderJobs, type GraphDefinition, type RenderJob } from "@buffered-audio/core";
import { describe, expect, it, vi } from "vitest";
import { JobManager } from "../../../utilities/JobManager";
import { RenderGraphMainIpc } from "./Main";
import type { IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";

vi.mock("@buffered-audio/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@buffered-audio/core")>();

	return { ...actual, createRenderJobs: vi.fn() };
});

interface FakeJob {
	readonly job: RenderJob;
	readonly abort: ReturnType<typeof vi.fn>;
}

// A job whose render rejects with an AbortError once aborted, or with `failure` once `fail()` is called.
function fakeJob(): FakeJob & { readonly fail: (error: Error) => void } {
	let rejectRender: ((error: unknown) => void) | undefined;
	const rendering = new Promise<void>((_resolve, reject) => {
		rejectRender = reject;
	});
	const abort = vi.fn(() => rejectRender?.(new DOMException("This operation was aborted", "AbortError")));
	const job = { events: new EventEmitter(), render: () => rendering, abort } as unknown as RenderJob;

	return { job, abort, fail: (error) => rejectRender?.(error) };
}

function dependencies(jobManager: JobManager): IpcHandlerDependencies {
	return { jobManager, nodeRegistry: new Map(), browserWindow: {} } as unknown as IpcHandlerDependencies;
}

const definition = { nodes: [], edges: [] } as unknown as GraphDefinition;

describe("RenderGraphMainIpc", () => {
	it("aborts every sibling job on the first failure and reports that failure", async () => {
		const failing = fakeJob();
		const sibling = fakeJob();

		vi.mocked(createRenderJobs).mockReturnValueOnce([failing.job, sibling.job]);

		const handling = new RenderGraphMainIpc().handler({ jobId: "job", definition }, dependencies(new JobManager()));

		failing.fail(new Error("write failed"));

		await expect(handling).rejects.toThrow("write failed");
		expect(sibling.abort).toHaveBeenCalled();
	});

	it("resolves quietly when the user aborted the job", async () => {
		const jobManager = new JobManager();
		const first = fakeJob();
		const second = fakeJob();

		vi.mocked(createRenderJobs).mockReturnValueOnce([first.job, second.job]);

		const handling = new RenderGraphMainIpc().handler({ jobId: "job", definition }, dependencies(jobManager));
		const signal = jobManager.getOrCreateSignal("job");

		signal.addEventListener("abort", () => {
			first.fail(signal.reason as Error);
			second.fail(signal.reason as Error);
		});
		jobManager.abortJob("job");

		await expect(handling).resolves.toBeUndefined();
	});
});
