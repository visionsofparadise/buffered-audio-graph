import { createHash } from "node:crypto";
import { type FileParamStat, serializeFileParamStats } from "./serializeFileParamStats";
import { sortKeysRecursive } from "./sortKeysRecursive";

export function contentHash(
	upstreamHash: string,
	packageName: string,
	packageVersion: string,
	nodeName: string,
	parameters: Record<string, unknown>,
	bypass: boolean,
	fileParamStats: ReadonlyArray<FileParamStat>,
): string {
	const input =
		upstreamHash +
		packageName +
		packageVersion +
		nodeName +
		JSON.stringify(sortKeysRecursive(parameters)) +
		String(bypass) +
		serializeFileParamStats(fileParamStats);

	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
