import os from "node:os";
import path from "node:path";
import { getVst3CliPath } from "../../../../main/bundledBinaries";
import { launchVst3Editor } from "../../../../main/vst3/editor";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../Models/AsyncMainIpc";
import { emitToRenderer } from "../../../utilities/emitToRenderer";
import {
	VST3_LAUNCH_EDITOR_ACTION,
	type Vst3LaunchEditorInput,
	type Vst3LaunchEditorIpcParameters,
	type Vst3LaunchEditorIpcReturn,
} from "./Renderer";
import type { Vst3EditorEvent } from "../Vst3EditorEvent";

const generatePresetPath = (): string => path.join(os.tmpdir(), "bagman-vst3", `${crypto.randomUUID()}.vstpreset`);

const buildArgs = (input: Vst3LaunchEditorInput, presetPath: string): ReadonlyArray<string> => {
	const smokeCloseAfterMs = process.env.BAG_VST3_SMOKE_CLOSE_MS;

	return [
		"--plugin",
		input.pluginPath,
		...(input.pluginName === undefined ? [] : ["--plugin-name", input.pluginName]),
		"--preset",
		presetPath,
		...(smokeCloseAfterMs === undefined || smokeCloseAfterMs === "" ? [] : ["--close-after-ms", smokeCloseAfterMs]),
	];
};

export class Vst3LaunchEditorMainIpc extends AsyncMainIpc<Vst3LaunchEditorIpcParameters, Vst3LaunchEditorIpcReturn> {
	action = VST3_LAUNCH_EDITOR_ACTION;

	handler(input: Vst3LaunchEditorInput, dependencies: IpcHandlerDependencies): Vst3LaunchEditorIpcReturn {
		const { browserWindow, logger } = dependencies;
		const cli = getVst3CliPath();

		if (!cli.exists) throw new Error(`vst-demon-cli binary not found at ${cli.path}`);

		const presetPath = input.presetPath ?? generatePresetPath();
		const launchId = crypto.randomUUID();
		const args = buildArgs(input, presetPath);

		const emit = (event: Vst3EditorEvent): void => {
			if (browserWindow.isDestroyed()) return;

			emitToRenderer(browserWindow, "vst3:editorEvent", { launchId, event });
		};

		launchVst3Editor({ command: cli.path, args, launchId, logger, emit });

		logger.info("Launched VST3 editor", { namespace: "vst3", launchId, pluginPath: input.pluginPath, presetPath });

		return { launchId, presetPath };
	}
}
