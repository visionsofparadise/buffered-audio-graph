function leafMessages(error: unknown): Array<string> {
	if (error instanceof AggregateError) return (error.errors as Array<unknown>).flatMap(leafMessages);

	if (error instanceof Error) return [error.message];

	return [String(error)];
}

export function describeError(error: unknown): string {
	if (error instanceof AggregateError) {
		const causes = [...new Set(leafMessages(error))];

		return causes.length > 0 ? `${error.message}: ${causes.join("; ")}` : error.message;
	}

	if (error instanceof Error) return error.message;

	return String(error);
}
