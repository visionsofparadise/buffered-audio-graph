import { readBundledBinaryDefaults } from "../../../../main/bundledBinaries";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import {
	GET_BUNDLED_BINARY_DEFAULTS_ACTION,
	type GetBundledBinaryDefaultsIpcParameters,
	type GetBundledBinaryDefaultsIpcReturn,
} from "./Renderer";

export class GetBundledBinaryDefaultsMainIpc extends AsyncMainIpc<
	GetBundledBinaryDefaultsIpcParameters,
	GetBundledBinaryDefaultsIpcReturn
> {
	action = GET_BUNDLED_BINARY_DEFAULTS_ACTION;

	async handler(_dependencies: IpcHandlerDependencies): Promise<GetBundledBinaryDefaultsIpcReturn> {
		return await readBundledBinaryDefaults();
	}
}
