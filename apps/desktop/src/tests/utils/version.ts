/** Numeric dotted-version comparison: is `version` ≥ `target`? */
export function versionAtLeast(version: string, target: string): boolean {
	const left = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = target.split(".").map((part) => Number.parseInt(part, 10) || 0);

	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);

		if (delta !== 0) return delta > 0;
	}

	return true;
}
