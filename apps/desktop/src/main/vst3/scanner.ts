import type { Logger } from "../../shared/models/Logger";
import type { Vst3ScanEntry } from "../../shared/ipc/Vst3/Vst3ScanEntry";
import { isCacheHit, readCache, statModule, writeCache, type CacheRecord, type ModuleStat, type ScanCache } from "./cache";
import { deriveErrorEntry, derivePendingEntry, deriveReadyEntries } from "./entries";
import { listModule } from "./listing";
import { walkVst3Roots, type WalkModule } from "./walk";

const LIST_POOL_CONCURRENCY = 3;

export interface Vst3ScannerOptions {
	readonly cachePath: string;
	readonly resolveCliPath: () => { path: string; exists: boolean };
	readonly logger: Logger;
	readonly onUpdate: (entries: ReadonlyArray<Vst3ScanEntry>) => void;
}

interface PreparedScan {
	readonly modules: ReadonlyArray<WalkModule>;
	readonly entriesByModule: Map<string, ReadonlyArray<Vst3ScanEntry>>;
	readonly toProbe: ReadonlyArray<WalkModule>;
	readonly cache: ScanCache;
	readonly cliPath: string;
}

const recordToEntries = (module: WalkModule, record: CacheRecord): ReadonlyArray<Vst3ScanEntry> =>
	"classNames" in record ? deriveReadyEntries(module, record.classNames) : [deriveErrorEntry(module, record.error)];

export class Vst3Scanner {
	private readonly options: Vst3ScannerOptions;
	private inFlight: Promise<void> | undefined;
	private rescanQueued = false;
	private queuedRoots: ReadonlyArray<string> = [];

	constructor(options: Vst3ScannerOptions) {
		this.options = options;
	}

	scan(roots: ReadonlyArray<string>): ReadonlyArray<Vst3ScanEntry> {
		const prepared = this.prepare(roots);
		const immediate = this.flatten(prepared.modules, prepared.entriesByModule);

		if (prepared.toProbe.length > 0) this.scheduleExpansion(roots, prepared);

		return immediate;
	}

	private prepare(roots: ReadonlyArray<string>): PreparedScan {
		const { logger, cachePath } = this.options;
		const cli = this.options.resolveCliPath();
		const modules = walkVst3Roots(roots, logger);
		const cache = readCache(cachePath, logger);

		const entriesByModule = new Map<string, ReadonlyArray<Vst3ScanEntry>>();
		const toProbe: Array<WalkModule> = [];

		for (const module of modules) {
			const record = cache[module.modulePath];
			const stat = this.statModuleSafe(module);
			const cached = stat !== undefined && isCacheHit(record, stat) ? record : undefined;

			if (cached !== undefined) {
				entriesByModule.set(module.modulePath, recordToEntries(module, cached));
			} else if (!cli.exists) {
				entriesByModule.set(module.modulePath, [deriveErrorEntry(module, `vst-demon-cli binary not found at ${cli.path}`)]);
			} else {
				entriesByModule.set(module.modulePath, [derivePendingEntry(module)]);
				toProbe.push(module);
			}
		}

		return { modules, entriesByModule, toProbe, cache, cliPath: cli.path };
	}

	private scheduleExpansion(roots: ReadonlyArray<string>, prepared?: PreparedScan): void {
		if (this.inFlight !== undefined) {
			this.rescanQueued = true;
			this.queuedRoots = roots;

			return;
		}

		const prep = prepared ?? this.prepare(roots);

		this.inFlight = this.runExpansion(prep).finally(() => {
			this.inFlight = undefined;

			if (this.rescanQueued) {
				this.rescanQueued = false;

				this.scheduleExpansion(this.queuedRoots);
			}
		});
	}

	private async runExpansion(prep: PreparedScan): Promise<void> {
		const { onUpdate } = this.options;
		const nextCache: ScanCache = { ...prep.cache };

		await this.runPool(prep.toProbe, async (module) => {
			const stat = this.statModuleSafe(module);
			const result = await listModule(prep.cliPath, module.modulePath);

			if (result.ok) {
				prep.entriesByModule.set(module.modulePath, deriveReadyEntries(module, result.classNames));

				if (stat !== undefined) nextCache[module.modulePath] = { ...stat, classNames: [...result.classNames] };
			} else {
				prep.entriesByModule.set(module.modulePath, [deriveErrorEntry(module, result.error)]);

				if (stat !== undefined) nextCache[module.modulePath] = { ...stat, error: result.error };
			}

			onUpdate(this.flatten(prep.modules, prep.entriesByModule));
		});

		this.writeCacheSafe(nextCache);
	}

	private flatten(modules: ReadonlyArray<WalkModule>, entriesByModule: Map<string, ReadonlyArray<Vst3ScanEntry>>): ReadonlyArray<Vst3ScanEntry> {
		const entries: Array<Vst3ScanEntry> = [];

		for (const module of modules) {
			const moduleEntries = entriesByModule.get(module.modulePath) ?? [derivePendingEntry(module)];

			entries.push(...moduleEntries);
		}

		return entries;
	}

	private async runPool(modules: ReadonlyArray<WalkModule>, worker: (module: WalkModule) => Promise<void>): Promise<void> {
		let cursor = 0;

		const runNext = async (): Promise<void> => {
			while (cursor < modules.length) {
				const module = modules[cursor];

				cursor += 1;

				if (module === undefined) continue;

				await worker(module);
			}
		};

		const workerCount = Math.min(LIST_POOL_CONCURRENCY, modules.length);

		await Promise.all(Array.from({ length: workerCount }, () => runNext()));
	}

	private statModuleSafe(module: WalkModule): ModuleStat | undefined {
		try {
			return statModule(module.modulePath);
		} catch (error) {
			this.options.logger.warn("Failed to stat module", { namespace: "vst3", modulePath: module.modulePath, error: String(error) });

			return undefined;
		}
	}

	private writeCacheSafe(cache: ScanCache): void {
		try {
			writeCache(this.options.cachePath, cache);
		} catch (error) {
			this.options.logger.warn("Failed to write scan cache", { namespace: "vst3", cachePath: this.options.cachePath, error: String(error) });
		}
	}
}
