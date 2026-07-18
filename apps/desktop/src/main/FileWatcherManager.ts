import type { BrowserWindow } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { emitToRenderer, type FileChangedPayload } from "../shared/utilities/emitToRenderer";

export class FileWatcherManager {
	private readonly watchers = new Map<string, fs.FSWatcher>();
	private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly browserWindow: BrowserWindow;

	constructor(browserWindow: BrowserWindow) {
		this.browserWindow = browserWindow;
	}

	watch(filePath: string): void {
		if (this.watchers.has(filePath)) return;

		const watcher = fs.watch(filePath, () => {
			const existing = this.debounceTimers.get(filePath);

			if (existing) clearTimeout(existing);

			this.debounceTimers.set(
				filePath,
				setTimeout(() => {
					this.debounceTimers.delete(filePath);

					void (async () => {
						try {
							const content = await fsPromises.readFile(filePath);
							const contentHash = crypto.createHash("sha256").update(content).digest("hex");
							const payload: FileChangedPayload = { path: filePath, contentHash };

							emitToRenderer(this.browserWindow, "file:changed", payload);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
					})();
				}, 100),
			);
		});

		this.watchers.set(filePath, watcher);
	}

	unwatch(filePath: string): void {
		const timer = this.debounceTimers.get(filePath);

		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(filePath);
		}

		const watcher = this.watchers.get(filePath);

		if (watcher) {
			watcher.close();
			this.watchers.delete(filePath);
		}
	}

	dispose(): void {
		for (const [filePath] of this.watchers) {
			this.unwatch(filePath);
		}
	}
}
