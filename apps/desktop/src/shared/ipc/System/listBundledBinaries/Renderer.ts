import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export type ListBundledBinariesIpcParameters = [];
export type ListBundledBinariesIpcReturn = Record<string, string>;
export const LIST_BUNDLED_BINARIES_ACTION = "listBundledBinaries" as const;

export class ListBundledBinariesRendererIpc extends AsyncRendererIpc<typeof LIST_BUNDLED_BINARIES_ACTION, ListBundledBinariesIpcParameters, ListBundledBinariesIpcReturn> {
	action = LIST_BUNDLED_BINARIES_ACTION;
}
