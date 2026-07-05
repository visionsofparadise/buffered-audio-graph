import { randomUUID } from "node:crypto";

interface ActiveJob {
	readonly id: string;
	readonly controller: AbortController;
}

export class JobManager {
	private readonly activeJobs = new Map<string, ActiveJob>();

	startJob(): { id: string; signal: AbortSignal } {
		const controller = new AbortController();
		const id = randomUUID();

		this.activeJobs.set(id, { id, controller });

		return { id, signal: controller.signal };
	}

	/**
	 * Get the abort signal for an existing job, or create a new entry for an
	 * externally-minted jobId. Used by atomic per-node IPCs where the renderer
	 * mints a jobId once and reuses it across multiple node-render calls — the
	 * first call lazily registers an AbortController; subsequent calls share it
	 * so `abortJob(jobId)` cancels every in-flight node under that job.
	 */
	getOrCreateSignal(id: string): AbortSignal {
		const existing = this.activeJobs.get(id);

		if (existing) return existing.controller.signal;

		const controller = new AbortController();

		this.activeJobs.set(id, { id, controller });

		return controller.signal;
	}

	abortJob(id: string): void {
		const job = this.activeJobs.get(id);

		if (job) {
			job.controller.abort();
			this.activeJobs.delete(id);
		}
	}

	completeJob(id: string): void {
		this.activeJobs.delete(id);
	}
}
