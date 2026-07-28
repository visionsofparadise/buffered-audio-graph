import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ASYNC_RENDERER_IPCS } from "../shared/ipc/asyncRendererIpcs";
import type { MainEventMap } from "../shared/utilities/emitToRenderer";

const ipcHandlers = ASYNC_RENDERER_IPCS.map((AsyncRendererIpc) => new AsyncRendererIpc().register(ipcRenderer));

const mainApi = {
	...(Object.fromEntries(ipcHandlers) as Record<string, unknown>),

	events: {
		on: <K extends keyof MainEventMap>(
			eventName: K,
			listener: (_event: IpcRendererEvent, ...args: MainEventMap[K]) => void,
		) => ipcRenderer.addListener(eventName, listener),
		removeListener: <K extends keyof MainEventMap>(
			eventName: K,
			listener: (_event: IpcRendererEvent, ...args: MainEventMap[K]) => void,
		) => ipcRenderer.removeListener(eventName, listener),
	},

	send: (eventName: string, ...args: Array<unknown>) => {
		ipcRenderer.send(eventName, ...args);
	},
};

contextBridge.exposeInMainWorld("main", mainApi);
