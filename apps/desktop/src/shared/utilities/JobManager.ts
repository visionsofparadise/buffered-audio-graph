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
