import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";
import type { Vst3ScanEntry } from "../Vst3ScanEntry";

export type Vst3ScanPluginsIpcParameters = [roots: Array<string>];
export type Vst3ScanPluginsIpcReturn = Array<Vst3ScanEntry>;
export const VST3_SCAN_PLUGINS_ACTION = "vst3ScanPlugins" as const;

export class Vst3ScanPluginsRendererIpc extends AsyncRendererIpc<typeof VST3_SCAN_PLUGINS_ACTION, Vst3ScanPluginsIpcParameters, Vst3ScanPluginsIpcReturn> {
	action = VST3_SCAN_PLUGINS_ACTION;
}
