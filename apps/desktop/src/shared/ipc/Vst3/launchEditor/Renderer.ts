import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

export interface Vst3LaunchEditorInput {
	pluginPath: string;
	pluginName?: string;
	presetPath?: string;
}

export interface Vst3LaunchEditorResult {
	launchId: string;
	presetPath: string;
}

export type Vst3LaunchEditorIpcParameters = [input: Vst3LaunchEditorInput];
export type Vst3LaunchEditorIpcReturn = Vst3LaunchEditorResult;
export const VST3_LAUNCH_EDITOR_ACTION = "vst3LaunchEditor" as const;

export class Vst3LaunchEditorRendererIpc extends AsyncRendererIpc<typeof VST3_LAUNCH_EDITOR_ACTION, Vst3LaunchEditorIpcParameters, Vst3LaunchEditorIpcReturn> {
	action = VST3_LAUNCH_EDITOR_ACTION;
}
