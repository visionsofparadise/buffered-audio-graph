/** djb2 string hash — Resequence's project-icon assignment hash. */
export function hashString(input: string): number {
	let hash = 5381;

	for (let index = 0; index < input.length; index++) {
		hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
	}

	return Math.abs(hash);
}
