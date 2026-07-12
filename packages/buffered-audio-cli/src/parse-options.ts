export function parseParams(entries: ReadonlyArray<string>): Record<string, string> {
	const parameters = new Map<string, string>();

	for (const entry of entries) {
		const separatorIndex = entry.indexOf("=");

		if (separatorIndex === -1) throw new Error(`--param must be in name=value form, got "${entry}"`);

		const name = entry.slice(0, separatorIndex);
		const value = entry.slice(separatorIndex + 1);

		if (name === "") throw new Error(`--param name must not be empty, got "${entry}"`);
		if (parameters.has(name)) throw new Error(`--param ${name} given more than once`);

		parameters.set(name, value);
	}

	return Object.fromEntries(parameters);
}

export function parseResolveOverrides(entries: ReadonlyArray<string>): Map<string, string> {
	const overrides = new Map<string, string>();

	for (const entry of entries) {
		const separatorIndex = entry.indexOf("=");

		if (separatorIndex === -1) throw new Error(`--resolve must be in name=path form, got "${entry}"`);

		const name = entry.slice(0, separatorIndex);
		const path = entry.slice(separatorIndex + 1);

		if (name === "") throw new Error(`--resolve name must not be empty, got "${entry}"`);
		if (path === "") throw new Error(`--resolve path must not be empty, got "${entry}"`);
		if (overrides.has(name)) throw new Error(`--resolve ${name} given more than once`);

		overrides.set(name, path);
	}

	return overrides;
}
