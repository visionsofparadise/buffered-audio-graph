import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Logger } from "../../shared/Models/Logger";
import { launchVst3Editor } from "./editor";
import type { Vst3EditorEvent } from "../../shared/ipc/Vst3/Vst3EditorEvent";

const silent: Logger.BaseLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};
const logger = new Logger("main", silent);
const directories: Array<string> = [];

afterAll(async () => {
	await Promise.all(
		directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
	);
});

async function windowsHolder(code: number, stderrLine: string): Promise<Array<string>> {
	const directory = await mkdtemp(join(tmpdir(), "vst3-editor-"));

	directories.push(directory);

	const file = join(directory, "holder.cmd");
	const script = "setInterval(function(){console.log('holder')},500);setTimeout(function(){process.exit()},6000)";

	await writeFile(
		file,
		[`@start /b "" "${process.execPath}" -e "${script}"`, `@echo ${stderrLine} 1>&2`, `@exit ${code}`, ""].join(
			"\r\n",
		),
	);

	return ["/d", "/c", file];
}

function launch(
	command: string,
	args: ReadonlyArray<string>,
): { readonly events: Array<Vst3EditorEvent>; readonly exited: Promise<Vst3EditorEvent> } {
	const events: Array<Vst3EditorEvent> = [];
	let resolveExited: (event: Vst3EditorEvent) => void = () => undefined;
	const exited = new Promise<Vst3EditorEvent>((resolve) => {
		resolveExited = resolve;
	});

	launchVst3Editor({
		command,
		args,
		launchId: "launch-1",
		logger,
		emit: (event) => {
			events.push(event);

			if (event.event === "exited") resolveExited(event);
		},
	});

	return { events, exited };
}

describe("launchVst3Editor", () => {
	it("emits the editor's events, then its failed exit with the stderr excerpt", async () => {
		const { events, exited } = launch(process.execPath, [
			"-e",
			"process.stdout.write(JSON.stringify({ event: 'ready' }) + '\\n'); process.stderr.write('fatal\\n'); process.exitCode = 3;",
		]);

		await exited;

		expect(events.map((event) => event.event)).toEqual(["ready", "exited"]);
		expect(events[1]).toMatchObject({ event: "exited", code: 3, stderrTail: "fatal" });
		expect(events[1]?.event === "exited" ? events[1].error?.trimEnd() : undefined).toMatch(
			/^vst-demon-cli exited 3: fatal$/,
		);
	});

	it("reports a crashed editor whose helper holds its pipes within 4000 ms of the spawn", async () => {
		const [command, args] =
			process.platform === "win32"
				? ["cmd.exe", await windowsHolder(3, "fatal")]
				: ["sh", ["-c", "sleep 6 & echo fatal >&2; exit 3"]];
		const start = performance.now();
		const { exited } = launch(command, args);
		const event = await exited;

		expect(performance.now() - start).toBeLessThan(4000);
		expect(event).toMatchObject({ event: "exited", code: 3 });
		expect(event.event === "exited" ? event.error : undefined).toMatch(/vst-demon-cli exited 3: fatal/);
	});
});
