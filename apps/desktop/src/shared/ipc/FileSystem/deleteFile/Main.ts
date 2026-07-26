import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { DELETE_FILE_ACTION, type DeleteFileIpcParameters, type DeleteFileIpcReturn } from "./Renderer";

const ALLOWED_ROOTS = () => [app.getPath("userData"), app.getPath("temp")];

export class DeleteFileMainIpc extends AsyncMainIpc<DeleteFileIpcParameters, DeleteFileIpcReturn> {
	action = DELETE_FILE_ACTION;

	async handler(filePath: string, _dependencies: IpcHandlerDependencies): Promise<DeleteFileIpcReturn> {
		const resolved = path.resolve(filePath);
		const roots = ALLOWED_ROOTS();

		if (!roots.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
			throw new Error(`deleteFile: path "${resolved}" is outside allowed directories`);
		}

		await fs.rm(filePath, { recursive: true, force: true });
	}
}
