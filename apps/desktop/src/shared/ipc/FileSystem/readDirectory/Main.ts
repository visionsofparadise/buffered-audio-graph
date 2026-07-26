import fs from "node:fs/promises";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { READ_DIRECTORY_ACTION, type ReadDirectoryIpcParameters, type ReadDirectoryIpcReturn } from "./Renderer";

export class ReadDirectoryMainIpc extends AsyncMainIpc<ReadDirectoryIpcParameters, ReadDirectoryIpcReturn> {
	action = READ_DIRECTORY_ACTION;

	async handler(dirPath: string, _dependencies: IpcHandlerDependencies): Promise<ReadDirectoryIpcReturn> {
		try {
			return await fs.readdir(dirPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [] as Array<string>;
			}

			throw error;
		}
	}
}
