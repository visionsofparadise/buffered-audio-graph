import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { VST3_SCAN_PLUGINS_ACTION, type Vst3ScanPluginsIpcParameters, type Vst3ScanPluginsIpcReturn } from "./Renderer";

export class Vst3ScanPluginsMainIpc extends AsyncMainIpc<Vst3ScanPluginsIpcParameters, Vst3ScanPluginsIpcReturn> {
	action = VST3_SCAN_PLUGINS_ACTION;

	handler(roots: Array<string>, dependencies: IpcHandlerDependencies): Vst3ScanPluginsIpcReturn {
		return [...dependencies.vst3Scanner.scan(roots)];
	}
}
