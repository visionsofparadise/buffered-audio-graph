export interface ActiveCommands {
	undo: (() => void) | null;
	redo: (() => void) | null;
	canUndo: boolean;
	canRedo: boolean;
	rename: ((name: string) => void) | null;
	importBag: (() => Promise<void>) | null;
	save: (() => void) | null;
}
