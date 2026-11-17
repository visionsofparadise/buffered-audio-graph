export function isAbortReason(error: unknown, signal: AbortSignal): boolean {
	if (signal.aborted && error === signal.reason) return true;

	return error instanceof Error && error.name === "AbortError";
}
