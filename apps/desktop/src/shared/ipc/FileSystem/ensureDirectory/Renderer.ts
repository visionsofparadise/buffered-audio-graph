import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type EnsureDirectoryIpcParameters = [path: string];
export type EnsureDirectoryIpcReturn = undefined;
export const ENSURE_DIRECTORY_ACTION = "ensureDirectory" as const;

export class EnsureDirectoryRendererIpc extends AsyncRendererIpc<typeof ENSURE_DIRECTORY_ACTION, EnsureDirectoryIpcParameters, EnsureDirectoryIpcReturn> {
	action = ENSURE_DIRECTORY_ACTION;
}
