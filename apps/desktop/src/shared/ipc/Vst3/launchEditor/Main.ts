import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { getVst3CliPath } from "../../../../main/bundledBinaries";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import type { Logger } from "../../../models/Logger";
import { parseVst3EditorLine, type Vst3EditorEvent } from "../Vst3EditorEvent";
import { VST3_LAUNCH_EDITOR_ACTION, type Vst3LaunchEditorInput, type Vst3LaunchEditorIpcParameters, type Vst3LaunchEditorIpcReturn } from "./Renderer";

const STDERR_TAIL_LINE_LIMIT = 20;
const STDERR_TAIL_BYTE_LIMIT = 4096;

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

const consumeChildStreams = (child: ChildProcess, launchId: string, logger: Logger, emit: (event: Vst3EditorEvent) => void): (() => string) => {
	const stderrChunks: Array<string> = [];
	let stderrBytes = 0;

	if (child.stderr !== null) {
		child.stderr.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk.toString());
			stderrBytes += chunk.length;

			while (stderrChunks.length > STDERR_TAIL_LINE_LIMIT * 4 || stderrBytes > STDERR_TAIL_BYTE_LIMIT * 2) {
				const removed = stderrChunks.shift();

				if (removed === undefined) break;

				stderrBytes -= Buffer.byteLength(removed);
			}
		});
	}

	if (child.stdout !== null) {
		const lines = readline.createInterface({ input: child.stdout });

		lines.on("line", (line: string) => {
			const event = parseVst3EditorLine(line);

			if (event === undefined) {
				logger.warn("Unparseable VST3 editor stdout line", { namespace: "vst3", launchId, line });

				return;
			}

			emit(event);
		});
	}

	return () => {
		const combined = stderrChunks.join("");
		const nonEmpty = combined.split(/\r?\n/).filter((line) => line.trim().length > 0);
		const tail = nonEmpty.slice(-STDERR_TAIL_LINE_LIMIT).join("\n");

		return tail.length > STDERR_TAIL_BYTE_LIMIT ? tail.slice(-STDERR_TAIL_BYTE_LIMIT) : tail;
	};
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

		// Editor children are spawned detached and must outlive the app.
		const child = spawn(cli.path, [...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });

		logger.info("Launched VST3 editor", { namespace: "vst3", launchId, pluginPath: input.pluginPath, presetPath });

		const emit = (event: Vst3EditorEvent): void => {
			if (browserWindow.isDestroyed()) return;

			browserWindow.webContents.send("vst3:editorEvent", { launchId, event });
		};

		const readStderrTail = consumeChildStreams(child, launchId, logger, emit);

		child.on("error", (error: Error) => {
			logger.error("VST3 editor child errored", error, { namespace: "vst3", launchId });
		});

		child.on("close", (code) => {
			emit({ event: "exited", code, stderrTail: readStderrTail() });
		});

		child.unref();

		return { launchId, presetPath };
	}
}
