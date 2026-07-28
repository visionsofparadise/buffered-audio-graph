import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type ReadFileChunkIpcParameters = [path: string, offset: number, length: number];
export type ReadFileChunkIpcReturn = Uint8Array;
export const READ_FILE_CHUNK_ACTION = "readFileChunk" as const;

export class ReadFileChunkRendererIpc extends AsyncRendererIpc<
	typeof READ_FILE_CHUNK_ACTION,
	ReadFileChunkIpcParameters,
	ReadFileChunkIpcReturn
> {
	action = READ_FILE_CHUNK_ACTION;
}
