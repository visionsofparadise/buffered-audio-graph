import type { State } from ".";
import type { ProxyStore } from "../ProxyStore/ProxyStore";

export interface ActiveCommands extends State {
	undo: (() => void) | null;
	redo: (() => void) | null;
	canUndo: boolean;
	canRedo: boolean;
	rename: ((name: string) => void) | null;
	importBag: (() => Promise<void>) | null;
	save: (() => void) | null;
}

export function createActiveCommands(store: ProxyStore): ActiveCommands {
	return store.createState<ActiveCommands>({
		undo: null,
		redo: null,
		canUndo: false,
		canRedo: false,
		rename: null,
		importBag: null,
		save: null,
	});
}
