import fs from "node:fs/promises";
import path from "node:path";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { WRITE_FILE_ACTION, type WriteFileIpcParameters, type WriteFileIpcReturn } from "./Renderer";

export class WriteFileMainIpc extends AsyncMainIpc<WriteFileIpcParameters, WriteFileIpcReturn> {
	action = WRITE_FILE_ACTION;

	async handler(
		filePath: string,
		content: string,
		_dependencies: IpcHandlerDependencies,
	): Promise<WriteFileIpcReturn> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const tmpPath = `${filePath}.tmp`;

		try {
			await fs.writeFile(tmpPath, content, "utf-8");
			await fs.rename(tmpPath, filePath);
		} catch (error) {
			await fs.unlink(tmpPath).catch(() => {});
			throw error;
		}
	}
}
