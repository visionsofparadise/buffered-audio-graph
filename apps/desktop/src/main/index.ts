import { rm } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { logger } from "./logger";
import { createWindow } from "./window";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron Forge requires this pattern
if (require("electron-squirrel-startup")) {
	app.quit();
}

if (process.env.BAG_USER_DATA) {
	app.setPath("userData", process.env.BAG_USER_DATA);
}

/**
 * One-time cleanup: the snapshot executor was removed (2026-07-12), so the
 * `{userData}/snapshots` tree is unreadable and never written again. The call
 * is a permanent no-op once the tree is gone.
 */
async function removeSnapshotsDirectory(): Promise<void> {
	await rm(path.join(app.getPath("userData"), "snapshots"), { recursive: true, force: true }).catch(() => undefined);
}

app.whenReady()
	.then(() => {
		createWindow(logger);
		void removeSnapshotsDirectory();
	})
	.catch(console.error);

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow(logger);
	}
});
