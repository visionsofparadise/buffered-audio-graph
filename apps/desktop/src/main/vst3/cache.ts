import fs from "node:fs";
import { z } from "zod";
import type { Logger } from "../../shared/Models/Logger";

const cacheRecordSchema = z.union([
	z.object({
		size: z.number(),
		mtimeMs: z.number(),
		classNames: z.array(z.string()),
	}),
	z.object({
		size: z.number(),
		mtimeMs: z.number(),
		error: z.string(),
	}),
]);

const cacheSchema = z.record(z.string(), cacheRecordSchema);

const CACHE_VERSION = 2;

const cacheFileSchema = z.object({ version: z.literal(CACHE_VERSION), entries: cacheSchema });

export type CacheRecord = z.infer<typeof cacheRecordSchema>;
export type ScanCache = z.infer<typeof cacheSchema>;

export interface ModuleStat {
	readonly size: number;
	readonly mtimeMs: number;
}

export const isCacheHit = (record: CacheRecord | undefined, stat: ModuleStat): record is CacheRecord =>
	record?.size === stat.size && record.mtimeMs === stat.mtimeMs;

const parseCache = (raw: string): ScanCache => {
	const result = cacheFileSchema.safeParse(JSON.parse(raw));

	return result.success ? result.data.entries : {};
};

const serializeCache = (cache: ScanCache): string =>
	JSON.stringify({ version: CACHE_VERSION, entries: cache }, null, "\t");

export const readCache = (cachePath: string, logger: Logger): ScanCache => {
	let raw: string;

	try {
		raw = fs.readFileSync(cachePath, "utf8");
	} catch {
		return {};
	}

	try {
		return parseCache(raw);
	} catch (error) {
		logger.warn("Scan cache is malformed, starting fresh", { namespace: "vst3", cachePath, error: String(error) });

		return {};
	}
};

export const writeCache = (cachePath: string, cache: ScanCache): void => {
	fs.writeFileSync(cachePath, serializeCache(cache), "utf8");
};

export const statModule = (modulePath: string): ModuleStat => {
	const stats = fs.statSync(modulePath);

	return { size: stats.size, mtimeMs: stats.mtimeMs };
};
