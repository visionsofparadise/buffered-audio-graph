import { app, BrowserWindow } from "electron";
import { logger } from "./logger";
import { createWindow } from "./window";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron Forge requires this pattern
if (require("electron-squirrel-startup")) {
	app.quit();
}

app.whenReady()
	.then(() => createWindow(logger))
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
