import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

export type Vst3GetDefaultScanRootsIpcParameters = [];
export type Vst3GetDefaultScanRootsIpcReturn = Array<string>;
export const VST3_GET_DEFAULT_SCAN_ROOTS_ACTION = "vst3GetDefaultScanRoots" as const;

export class Vst3GetDefaultScanRootsRendererIpc extends AsyncRendererIpc<typeof VST3_GET_DEFAULT_SCAN_ROOTS_ACTION, Vst3GetDefaultScanRootsIpcParameters, Vst3GetDefaultScanRootsIpcReturn> {
	action = VST3_GET_DEFAULT_SCAN_ROOTS_ACTION;
}
