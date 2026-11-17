export function isAbortReason(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted && error === signal.reason) return true;

	return error instanceof Error && error.name === "AbortError";
}

export function preferredFailure(
	results: ReadonlyArray<PromiseSettledResult<unknown>>,
	signal?: AbortSignal,
): PromiseRejectedResult | undefined {
	const failures = results.filter((result) => result.status === "rejected");

	return failures.find((result) => !isAbortReason(result.reason, signal)) ?? failures[0];
}
