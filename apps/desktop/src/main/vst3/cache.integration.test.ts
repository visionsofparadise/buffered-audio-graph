import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Logger } from "../../shared/Models/Logger";
import { readCache, writeCache } from "./cache";

const silent: Logger.BaseLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};
const logger = new Logger("main", silent);
const directories: Array<string> = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cacheFile(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "vst3-cache-"));

	directories.push(directory);

	return join(directory, "vst3-scan-cache.json");
}

describe("VST3 scan cache", () => {
	it("reads a cache file in the unversioned flat format as empty", async () => {
		const path = await cacheFile();

		await writeFile(
			path,
			JSON.stringify({
				"C:/plugins/plugin.vst3": { size: 1, mtimeMs: 1, error: "vst-demon-cli timed out after 300000 ms" },
			}),
		);

		expect(readCache(path, logger)).toEqual({});
	});

	it("reads back an entry it wrote", async () => {
		const path = await cacheFile();
		const cache = { "C:/plugins/plugin.vst3": { size: 2, mtimeMs: 3, classNames: ["Synth"] } };

		writeCache(path, cache);

		expect(readCache(path, logger)).toEqual(cache);
	});
});
