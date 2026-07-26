import fs from "node:fs/promises";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { ENSURE_DIRECTORY_ACTION, type EnsureDirectoryIpcParameters, type EnsureDirectoryIpcReturn } from "./Renderer";

export class EnsureDirectoryMainIpc extends AsyncMainIpc<EnsureDirectoryIpcParameters, EnsureDirectoryIpcReturn> {
	action = ENSURE_DIRECTORY_ACTION;

	async handler(path: string, _dependencies: IpcHandlerDependencies): Promise<EnsureDirectoryIpcReturn> {
		await fs.mkdir(path, { recursive: true });
	}
}
