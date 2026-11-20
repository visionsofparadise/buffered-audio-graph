import { preferredFailure, type RenderJob } from "@buffered-audio/core";

export async function runJobs(
	jobs: ReadonlyArray<Pick<RenderJob, "render" | "abort">>,
	signal: AbortSignal,
): Promise<void> {
	let aborting = false;

	const results = await Promise.allSettled(
		jobs.map(async (job) => {
			try {
				await job.render();
			} catch (error) {
				if (!aborting) {
					aborting = true;

					for (const sibling of jobs) if (sibling !== job) sibling.abort();
				}

				throw error;
			}
		}),
	);
	const failure = preferredFailure(results, signal);

	if (failure) {
		const reason: unknown = failure.reason;

		throw reason;
	}
}
