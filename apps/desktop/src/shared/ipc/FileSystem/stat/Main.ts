import fs from "node:fs/promises";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { STAT_ACTION, type StatIpcParameters, type StatIpcReturn } from "./Renderer";

export class StatMainIpc extends AsyncMainIpc<StatIpcParameters, StatIpcReturn> {
	action = STAT_ACTION;

	async handler(filePath: string, _dependencies: IpcHandlerDependencies): Promise<StatIpcReturn> {
		const stats = await fs.stat(filePath);

		return {
			size: stats.size,
			isFile: stats.isFile(),
			isDirectory: stats.isDirectory(),
			mtimeMs: stats.mtimeMs,
		};
	}
}
