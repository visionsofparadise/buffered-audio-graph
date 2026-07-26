import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type ReadDirectoryIpcParameters = [dirPath: string];
export type ReadDirectoryIpcReturn = Array<string>;
export const READ_DIRECTORY_ACTION = "readDirectory" as const;

export class ReadDirectoryRendererIpc extends AsyncRendererIpc<typeof READ_DIRECTORY_ACTION, ReadDirectoryIpcParameters, ReadDirectoryIpcReturn> {
	action = READ_DIRECTORY_ACTION;
}
