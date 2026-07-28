import fs from "node:fs/promises";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { READ_FILE_CHUNK_ACTION, type ReadFileChunkIpcParameters, type ReadFileChunkIpcReturn } from "./Renderer";

export class ReadFileChunkMainIpc extends AsyncMainIpc<ReadFileChunkIpcParameters, ReadFileChunkIpcReturn> {
	action = READ_FILE_CHUNK_ACTION;

	async handler(
		path: string,
		offset: number,
		length: number,
		_dependencies: IpcHandlerDependencies,
	): Promise<ReadFileChunkIpcReturn> {
		const handle = await fs.open(path, "r");

		try {
			const buffer = Buffer.alloc(length);

			const { bytesRead } = await handle.read(buffer, 0, length, offset);

			return new Uint8Array(buffer.subarray(0, bytesRead));
		} finally {
			await handle.close();
		}
	}
}
