import EventEmitter from "events";
import type { IpcRendererEvent } from "electron";
import type { MainEventMap } from "../../shared/utilities/emitToRenderer";
import type { Main } from "./Main";

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

		main.events.on("vst3:scanUpdate", (_: IpcRendererEvent, ...args) => {
			this.emit("vst3:scanUpdate", ...args);
		});

		main.events.on("vst3:editorEvent", (_: IpcRendererEvent, ...args) => {
			this.emit("vst3:editorEvent", ...args);
		});
	}
}
