import { BrowserWindow } from "electron";
import path from "path";
import { JobManager } from "../shared/utilities/JobManager";
import { ASYNC_MAIN_IPCS } from "../shared/ipc/asyncMainIpcs";
import type { Logger } from "../shared/models/Logger";
import { createNodeRegistry } from "../shared/models/NodeRegistry";
import { FileWatcherManager } from "./FileWatcherManager";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const WINDOW_CONFIG = {
	width: 1200,
	height: 800,
	minWidth: 600,
	minHeight: 400,
	titleBarStyle: "hidden" as const,
	titleBarOverlay: {
		color: "#100F0D",
		symbolColor: "#918979",
		height: 40,
	},
};

export const createWindow = (logger: Logger): BrowserWindow => {
	const browserWindow = new BrowserWindow({
		...WINDOW_CONFIG,
		icon: path.join(__dirname, "../../assets/icon.png"),
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	const windowId = crypto.randomUUID();
	const fileWatcherManager = new FileWatcherManager(browserWindow);
	const jobManager = new JobManager();
	const nodeRegistry = createNodeRegistry();

	for (const AsyncMainIpc of ASYNC_MAIN_IPCS) {
		new AsyncMainIpc().register({ browserWindow, fileWatcherManager, jobManager, logger, nodeRegistry: nodeRegistry, windowId });
	}

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const emitBounds = (): void => {
		const { x, y, width, height } = browserWindow.getBounds();

		browserWindow.webContents.send("windowBoundsChanged", { x, y, width, height });
	};

	const debouncedEmit = (): void => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(emitBounds, 500);
	};

	browserWindow.on("move", debouncedEmit);
	browserWindow.on("resize", debouncedEmit);

	browserWindow.on("close", () => {
		if (debounceTimer) clearTimeout(debounceTimer);

		emitBounds();
	});

	browserWindow.on("closed", () => {
		fileWatcherManager.dispose();
	});

	if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		browserWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL).catch((error: unknown) => {
			logger.error("Failed to load dev server URL", error as Error, {
				namespace: "window",
				url: MAIN_WINDOW_VITE_DEV_SERVER_URL,
			});
		});
	} else {
		const filePath = path.join(__dirname, `../../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);

		browserWindow.loadFile(filePath).catch((error: unknown) => {
			logger.error("Failed to load file", error as Error, { namespace: "window", filePath });
		});
	}

	browserWindow.on("ready-to-show", () => {
		browserWindow.show();
	});

	return browserWindow;
};
