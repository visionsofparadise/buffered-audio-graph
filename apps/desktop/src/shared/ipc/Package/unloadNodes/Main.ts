import { unregisterPackage } from "../../../models/NodeRegistry";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import {
	UNLOAD_PACKAGE_NODES_ACTION,
	type UnloadPackageNodesInput,
	type UnloadPackageNodesIpcParameters,
	type UnloadPackageNodesIpcReturn,
} from "./Renderer";

export class UnloadPackageNodesMainIpc extends AsyncMainIpc<UnloadPackageNodesIpcParameters, UnloadPackageNodesIpcReturn> {
	action = UNLOAD_PACKAGE_NODES_ACTION;

	handler(input: UnloadPackageNodesInput, dependencies: IpcHandlerDependencies): UnloadPackageNodesIpcReturn {
		unregisterPackage(dependencies.nodeRegistry, input.packageName, input.packageVersion);

		return undefined;
	}
}
