/**
 * A file-kind parameter's contribution to a node's content hash: the parameter
 * path plus the `stat` result (`mtimeMs` + `size`) of the file it points at, or
 * `null` when the file is missing or unstattable (a legitimate pre-render state).
 */
export interface FileParamStat {
	readonly parameterPath: string;
	readonly stat: { readonly mtimeMs: number; readonly size: number } | null;
}

/**
 * Pure serialization of a node's file-param stats into a deterministic string
 * fragment folded into the content hash. Sorted by `parameterPath` so hash
 * inputs are order-independent. A present file becomes `[path, mtimeMs, size]`;
 * a missing/unstattable file becomes `[path, null]`.
 *
 * This is the single serialization shared by both `contentHash` implementations
 * (renderer Web Crypto + main Node crypto) so the two consumers agree on a
 * node's hash. Stat-gathering may differ per environment; this pure function
 * must not.
 */
export function serializeFileParamStats(stats: ReadonlyArray<FileParamStat>): string {
	const tuples = [...stats]
		.sort((first, second) => (first.parameterPath < second.parameterPath ? -1 : first.parameterPath > second.parameterPath ? 1 : 0))
		.map((entry) =>
			entry.stat === null
				? [entry.parameterPath, null]
				: [entry.parameterPath, entry.stat.mtimeMs, entry.stat.size],
		);

	return JSON.stringify(tuples);
}
