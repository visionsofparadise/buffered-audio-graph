import EventEmitter from "events";
import type { IpcRendererEvent } from "electron";
import type { MainEventMap } from "../../shared/utilities/emitToRenderer";
import type { Main } from "./Main";

/**
 * Wraps the IPC event bridge in a normal Node EventEmitter so renderer code
 * can subscribe and unsubscribe by function identity. The IPC bridge is
 * subscribed to once per event name at construction; consumers register
 * against this emitter only. Without this layer, every React effect that
 * subscribes through `main.events.on` and unsubscribes through
 * `removeListener` risks identity drift across rerenders, leaking listeners
 * on the underlying IpcRenderer (the source of MaxListenersExceeded).
 */
export class MainEvents extends EventEmitter<MainEventMap> {
	constructor(main: Main) {
		super();

		main.events.on("windowBoundsChanged", (_: IpcRendererEvent, ...args) => {
			this.emit("windowBoundsChanged", ...args);
		});

		main.events.on("file:changed", (_: IpcRendererEvent, ...args) => {
			this.emit("file:changed", ...args);
		});

		main.events.on("audio:progress", (_: IpcRendererEvent, ...args) => {
			this.emit("audio:progress", ...args);
		});
	}
}
