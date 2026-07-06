import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

export interface UnloadPackageNodesInput {
	readonly packageName: string;
	readonly packageVersion: string;
}

export type UnloadPackageNodesIpcParameters = [input: UnloadPackageNodesInput];
export type UnloadPackageNodesIpcReturn = undefined;
export const UNLOAD_PACKAGE_NODES_ACTION = "unloadPackageNodes" as const;

export class UnloadPackageNodesRendererIpc extends AsyncRendererIpc<
	typeof UNLOAD_PACKAGE_NODES_ACTION,
	UnloadPackageNodesIpcParameters,
	UnloadPackageNodesIpcReturn
> {
	action = UNLOAD_PACKAGE_NODES_ACTION;
}
