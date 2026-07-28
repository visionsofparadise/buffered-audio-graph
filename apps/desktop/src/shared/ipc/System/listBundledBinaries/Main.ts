import { listBundledBinaryFiles } from "../../../../main/bundledBinaries";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import {
	LIST_BUNDLED_BINARIES_ACTION,
	type ListBundledBinariesIpcParameters,
	type ListBundledBinariesIpcReturn,
} from "./Renderer";

export class ListBundledBinariesMainIpc extends AsyncMainIpc<
	ListBundledBinariesIpcParameters,
	ListBundledBinariesIpcReturn
> {
	action = LIST_BUNDLED_BINARIES_ACTION;

	async handler(_dependencies: IpcHandlerDependencies): Promise<ListBundledBinariesIpcReturn> {
		return await listBundledBinaryFiles();
	}
}
