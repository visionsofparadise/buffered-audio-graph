import os from "node:os";
import path from "node:path";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { VST3_GET_DEFAULT_SCAN_ROOTS_ACTION, type Vst3GetDefaultScanRootsIpcParameters, type Vst3GetDefaultScanRootsIpcReturn } from "./Renderer";

export class Vst3GetDefaultScanRootsMainIpc extends AsyncMainIpc<Vst3GetDefaultScanRootsIpcParameters, Vst3GetDefaultScanRootsIpcReturn> {
	action = VST3_GET_DEFAULT_SCAN_ROOTS_ACTION;

	handler(_dependencies: IpcHandlerDependencies): Vst3GetDefaultScanRootsIpcReturn {
		switch (process.platform) {
			case "win32":
				return ["C:\\Program Files\\Common Files\\VST3", ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "Common", "VST3")] : [])];
			case "darwin":
				return ["/Library/Audio/Plug-Ins/VST3", path.join(os.homedir(), "Library", "Audio", "Plug-Ins", "VST3")];
			case "linux":
				return [path.join(os.homedir(), ".vst3"), "/usr/lib/vst3", "/usr/local/lib/vst3"];
			default:
				return [];
		}
	}
}
