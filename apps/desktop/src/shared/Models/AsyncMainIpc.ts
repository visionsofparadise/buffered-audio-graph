import type { BrowserWindow } from "electron";
import type { FileWatcherManager } from "../../main/FileWatcherManager";
import type { Vst3Scanner } from "../../main/vst3/scanner";
import type { JobManager } from "../utilities/JobManager";
import { Logger } from "./Logger";
import type { NodeRegistryMap } from "./NodeRegistry";

export interface IpcHandlerDependencies {
	readonly browserWindow: BrowserWindow;
	readonly fileWatcherManager: FileWatcherManager;
	readonly jobManager: JobManager;
	readonly logger: Logger;
	readonly nodeRegistry: NodeRegistryMap;
	readonly vst3Scanner: Vst3Scanner;
	readonly windowId: string;
}

export abstract class AsyncMainIpc<P extends Array<unknown>, R> {
	abstract action: string;
	abstract handler(...parameters: [...P, IpcHandlerDependencies]): R | Promise<R>;

	log(transactionId: string, logger: Logger): void {
		logger.debug(`Executing IPC handler`, {
			namespace: "ipc",
			transactionId,
			action: this.action,
		});
	}

	register(dependencies: IpcHandlerDependencies): void {
		const { browserWindow, logger } = dependencies;

		browserWindow.webContents.ipc.handle(this.action, async (_event, ...parameters: Array<unknown>) => {
			const transactionId = Logger.generateTransactionId();

			try {
				this.log(transactionId, logger);

				const result = await this.handler(...(parameters as P), dependencies);

				logger.debug(`IPC handler completed successfully`, {
					namespace: "ipc",
					transactionId,
					action: this.action,
				});

				return result;
			} catch (error) {
				logger.error(`IPC handler failed`, error as Error, {
					namespace: "ipc",
					transactionId,
					action: this.action,
				});
				throw error;
			}
		});
	}
}
