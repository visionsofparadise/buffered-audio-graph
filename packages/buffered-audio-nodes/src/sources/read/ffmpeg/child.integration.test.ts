import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BufferedTargetStream, TargetNode, type Block } from "@buffered-audio/core";
import { readFfmpeg } from ".";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();

	return { ...actual, spawn: vi.fn(actual.spawn) };
});

const IS_WINDOWS = process.platform === "win32";
const INPUT = join(tmpdir(), "read-ffmpeg-child-input.wav");
const HOLDER_SCRIPT = "setInterval(function(){console.log('holder')},500);setTimeout(function(){process.exit()},6000)";
const PROBE = `process.stdout.write(JSON.stringify({ streams: [{ sample_rate: "44100", channels: 1, duration: "1" }] }))`;
const ONE_SECOND_BYTES = 44100 * 4;

let actualSpawn: typeof spawn;
const directories: Array<string> = [];

beforeAll(async () => {
	actualSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
});

afterEach(() => {
	for (const result of vi.mocked(spawn).mock.results) {
		const child = result.value as ChildProcess | undefined;

		if (result.type === "return" && child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}

	vi.mocked(spawn).mockReset();
	vi.mocked(spawn).mockImplementation(actualSpawn);
});

afterAll(async () => {
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

class CollectTargetStream extends BufferedTargetStream {
	override _write(_chunk: Block): void {
		return undefined;
	}

	override _close(): void {
		return undefined;
	}
}

class CollectTarget extends TargetNode {
	static override readonly Stream = CollectTargetStream;
}

function redirect(command: string, args: ReadonlyArray<string>): void {
	vi.mocked(spawn).mockImplementationOnce(((_command: string, _args: ReadonlyArray<string>, options: object) =>
		actualSpawn(command, [...args], options)) as unknown as typeof spawn);
}

function redirectNode(script: string): void {
	redirect(process.execPath, ["-e", script]);
}

function redirectProbes(): void {
	redirectNode(PROBE);
	redirectNode(PROBE);
}

async function windowsHolder(code: number): Promise<Array<string>> {
	const directory = await mkdtemp(join(tmpdir(), "read-ffmpeg-holder-"));
	const file = join(directory, "holder.cmd");
	const lines = [`@start /b "" "${process.execPath}" -e "${HOLDER_SCRIPT}"`, "@echo bad 1>&2", `@exit ${code}`];

	directories.push(directory);
	await writeFile(file, `${lines.join("\r\n")}\r\n`);

	return ["/d", "/c", file];
}

function render(options?: { readonly ffmpegPath?: string; readonly signal?: AbortSignal }): Promise<void> {
	const source = readFfmpeg(INPUT, { ffmpegPath: options?.ffmpegPath ?? "ffmpeg", ffprobePath: "ffprobe" });

	source.to(new CollectTarget());

	return source.createRenderJob({ signal: options?.signal }).render();
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("render resolved");
		},
		(error: unknown) => error,
	);
}

async function stubPid(directory: string): Promise<number> {
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 50));

		const pid = Number(await readFile(join(directory, "pid"), "utf8").catch(() => ""));

		if (pid) return pid;
	}
}

// A stand-in that ignores SIGTERM, writes `output` bytes to stdout, records its pid once they are written, then idles.
function ignoresSigterm(directory: string, output = 0): Array<string> {
	const script = `process.on("SIGTERM", () => {}); process.stdout.write(Buffer.alloc(${output}), () => require("fs").writeFileSync(process.argv[1], String(process.pid))); setInterval(() => undefined, 1000)`;

	return ["-e", script, join(directory, "pid")];
}

async function abortWithin(controller: AbortController, rendering: Promise<unknown>, pid: number): Promise<void> {
	const abortedAt = performance.now();

	controller.abort();

	expect(await rendering).toBe(controller.signal.reason);
	expect(performance.now() - abortedAt).toBeLessThan(1000);
	expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

function spawnedChild(index: number): ChildProcess {
	const result = vi.mocked(spawn).mock.results[index];

	if (result?.type !== "return") throw new Error(`spawn ${String(index)} did not return a child`);

	return result.value as ChildProcess;
}

describe("ReadFfmpegStream against real children", () => {
	it("rejects with a labelled failure to start for a missing ffmpeg, with nothing uncaught", async () => {
		const uncaught: Array<unknown> = [];
		const onUncaught = (error: unknown): void => {
			uncaught.push(error);
		};

		process.on("uncaughtException", onUncaught);

		try {
			redirectProbes();

			const error = await rejection(render({ ffmpegPath: join(tmpdir(), "missing-ffmpeg") }));

			expect((error as Error).message).toMatch(/ffmpeg failed to start/);
			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});

	it("rejects with the exit error when ffmpeg exits 1 after a second of output", async () => {
		redirectProbes();
		redirectNode(
			`process.stdout.write(Buffer.alloc(${ONE_SECOND_BYTES}), () => process.stderr.write("decode error", () => process.exit(1)))`,
		);

		const error = await rejection(render());

		expect((error as Error).message).toBe("ffmpeg exited 1: decode error");
	});

	it("rejects with the exit error when ffmpeg writes less than one frame and exits 1", async () => {
		redirectProbes();
		redirectNode(
			`process.stdout.write(Buffer.alloc(3), () => process.stderr.write("truncated", () => process.exit(1)))`,
		);

		const error = await rejection(render());

		expect((error as Error).message).toBe("ffmpeg exited 1: truncated");
	});

	it("rejects with the abort reason within 3 s when the render aborts while ffprobe hangs", async () => {
		redirectNode("setInterval(() => undefined, 1000)");

		const controller = new AbortController();
		const rendering = rejection(render({ signal: controller.signal }));

		await new Promise((resolve) => setTimeout(resolve, 200));

		const abortedAt = performance.now();

		controller.abort();

		const error = await Promise.race([
			rendering,
			new Promise((resolve) => setTimeout(() => resolve("still pending after 3000 ms"), 3000)),
		]);

		expect(error).toBe(controller.signal.reason);
		expect(performance.now() - abortedAt).toBeLessThan(3000);

		const probe = spawnedChild(0);

		expect(probe.exitCode !== null || probe.signalCode !== null).toBe(true);
	});

	it("rejects with a labelled probe error when ffprobe prints unreadable JSON", async () => {
		redirectNode(`process.stdout.write("not json")`);

		const message = ((await rejection(render())) as Error).message;

		expect(message.startsWith(`Cannot probe "${INPUT}": ffprobe printed unreadable JSON (`)).toBe(true);
		expect(message.endsWith(")")).toBe(true);
	});

	it("passes quiet, error-only logging flags to ffprobe and ffmpeg", async () => {
		redirectProbes();
		redirectNode(`process.stdout.write(Buffer.alloc(1764), () => process.exit(0))`);

		await render();

		const calls = vi.mocked(spawn).mock.calls;

		expect(calls[0]?.[1]).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-print_format",
			"json",
			"-show_streams",
			"-select_streams",
			"a:0",
			INPUT,
		]);
		expect(calls[2]?.[1]?.slice(0, 6)).toEqual(["-hide_banner", "-nostats", "-loglevel", "error", "-i", INPUT]);
	});

	it("rejects with the exit error, not the held stdout, when ffmpeg exits 1 while a grandchild holds stdout", async () => {
		redirectProbes();

		if (IS_WINDOWS) redirect("cmd.exe", await windowsHolder(1));
		else redirect("sh", ["-c", "sleep 6 & echo bad >&2; exit 1"]);

		const started = performance.now();
		const error = await rejection(render());

		expect((error as Error).message).toMatch(/ffmpeg exited 1: bad/);
		expect(performance.now() - started).toBeLessThan(4000);
	});

	it.skipIf(IS_WINDOWS)("kills an ffprobe that ignores SIGTERM at once when the render aborts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "read-ffmpeg-abort-"));

		directories.push(directory);
		redirect(process.execPath, ignoresSigterm(directory));

		const controller = new AbortController();
		const rendering = rejection(render({ signal: controller.signal }));

		await abortWithin(controller, rendering, await stubPid(directory));
	});

	it.skipIf(IS_WINDOWS)("kills an ffmpeg that ignores SIGTERM at once when the render aborts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "read-ffmpeg-abort-"));

		directories.push(directory);
		redirectProbes();
		redirect(process.execPath, ignoresSigterm(directory, ONE_SECOND_BYTES));

		const controller = new AbortController();
		const rendering = rejection(render({ signal: controller.signal }));
		const pid = await stubPid(directory);

		await new Promise((resolve) => setTimeout(resolve, 200));
		await abortWithin(controller, rendering, pid);
	});
});
