import type { IpcRendererEvent } from "electron";
import type { AsyncIpcAction, AsyncIpcParameters, AsyncIpcReturn } from "../../shared/ipc/asyncRendererIpcs";
import type { MainEventMap } from "../../shared/utilities/emitToRenderer";

type MainListener<K extends keyof MainEventMap> = (event: IpcRendererEvent, ...parameters: MainEventMap[K]) => void;

export type Main = {
	[K in AsyncIpcAction]: (...data: AsyncIpcParameters<K>) => Promise<AsyncIpcReturn<K>>;
} & {
	events: {
		on: <K extends keyof MainEventMap>(eventName: K, listener: MainListener<K>) => void;
		removeListener: <K extends keyof MainEventMap>(eventName: K, listener: MainListener<K>) => void;
	};

	send: (channel: string, ...args: Array<unknown>) => void;
};

export const main = (window as Window & typeof globalThis & { main: Main }).main;

declare global {
	interface Window {
		main: Main;
	}
}
