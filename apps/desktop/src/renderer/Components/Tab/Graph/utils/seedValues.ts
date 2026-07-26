export function seedValues(names: ReadonlyArray<string>, initialValues: Record<string, string>): Record<string, string> {
	const next: Record<string, string> = {};

	for (const name of names) {
		next[name] = initialValues[name] ?? "";
	}

	return next;
}
