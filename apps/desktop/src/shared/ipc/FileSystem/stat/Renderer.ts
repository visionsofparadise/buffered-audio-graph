import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

interface FileStat {
	readonly size: number;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly mtimeMs: number;
}

export type StatIpcParameters = [filePath: string];
export type StatIpcReturn = FileStat;
export const STAT_ACTION = "stat" as const;

export class StatRendererIpc extends AsyncRendererIpc<typeof STAT_ACTION, StatIpcParameters, StatIpcReturn> {
	action = STAT_ACTION;
}
