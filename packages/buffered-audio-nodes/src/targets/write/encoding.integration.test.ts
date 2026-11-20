import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	BufferedSourceStream,
	isAbortReason,
	SourceNode,
	type Block,
	type SourceMetadata,
	type SourceNodeProperties,
} from "@buffered-audio/core";
import { z } from "zod";
import { binaries, hasBinaryFixtures } from "../../utils/test-binaries";
import { write, type WavBitDepth } from ".";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();

	return { ...actual, spawn: vi.fn(actual.spawn) };
});

const SAMPLE_RATE = 44100;
const WRITE_OUTPUT = `require("fs").writeFileSync(process.argv.at(-1), "")`;

interface EndlessSourceProperties extends SourceNodeProperties {
	readonly readDelayMs: number;
	readonly maxBlocks?: number;
}

class EndlessSourceStream extends BufferedSourceStream<EndlessSource> {
	private offset = 0;
	private blocks = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: SAMPLE_RATE, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		if (this.properties.maxBlocks !== undefined && this.blocks >= this.properties.maxBlocks) return undefined;

		this.blocks += 1;

		await new Promise((resolve) => setTimeout(resolve, this.properties.readDelayMs));

		const samples = Float32Array.from(
			{ length: SAMPLE_RATE },
			(_, index) => Math.sin((this.offset + index) / 50) * 0.5,
		);
		const block: Block = { samples: [samples], offset: this.offset, sampleRate: SAMPLE_RATE, bitDepth: 32 };

		this.offset += SAMPLE_RATE;

		return block;
	}
}

class EndlessSource extends SourceNode<EndlessSourceProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "endless-source";
	static override readonly schema = z.object({});
	static override readonly Stream = EndlessSourceStream;
}

let actualSpawn: typeof spawn;

beforeAll(async () => {
	actualSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
});

// Redirects the next spawn to a node stand-in that receives the encoder's output path as its last argument.
function standIn(script: string): void {
	vi.mocked(spawn).mockImplementationOnce(((_command: string, args: ReadonlyArray<string>, options: object) =>
		actualSpawn(process.execPath, ["-e", script, String(args.at(-1))], options)) as unknown as typeof spawn);
}

function spawnedChild(): ChildProcess {
	const result = vi.mocked(spawn).mock.results.at(-1);

	if (result?.type !== "return") throw new Error("ffmpeg was not spawned");

	return result.value as ChildProcess;
}

const directories: Array<string> = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));

	directories.push(directory);

	return directory;
}

async function partialFiles(directory: string): Promise<Array<string>> {
	return (await readdir(directory)).filter((name) => name.includes(".partial-"));
}

async function renderTo(
	node: ReturnType<typeof write>,
	options: { readonly maxBlocks?: number; readonly abortAfterMs?: number },
): Promise<{ error: unknown; signal: AbortSignal }> {
	const source = new EndlessSource({ readDelayMs: 20, maxBlocks: options.maxBlocks });
	const controller = new AbortController();

	source.to(node);

	const abortTimer =
		options.abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(), options.abortAfterMs);

	try {
		const error = await source
			.createRenderJob({ signal: controller.signal })
			.render()
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		return { error, signal: controller.signal };
	} finally {
		clearTimeout(abortTimer);
	}
}

async function renderToEncoder(
	ffmpegPath: string,
	abortAfterMs?: number,
	maxBlocks?: number,
): Promise<{ error: unknown; signal: AbortSignal }> {
	const output = join(tmpdir(), `ban-write-encode-${randomBytes(8).toString("hex")}.mp3`);

	try {
		return await renderTo(write(output, { bitDepth: "32f", ffmpegPath, encoding: { format: "mp3" } }), {
			abortAfterMs,
			maxBlocks,
		});
	} finally {
		await rm(output, { force: true });
	}
}

const unhandled: Array<unknown> = [];
const onUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
};

afterEach(async () => {
	process.off("unhandledRejection", onUnhandled);
	unhandled.length = 0;
	vi.mocked(spawn).mockClear();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WriteStream encoder teardown", () => {
	it.skipIf(!hasBinaryFixtures("ffmpeg"))(
		"rejects with the abort and leaves no unhandled rejection or running encoder when a render aborts",
		async () => {
			process.on("unhandledRejection", onUnhandled);

			const { error, signal } = await renderToEncoder(binaries.ffmpeg, 500);
			const child = spawnedChild();

			expect(isAbortReason(error, signal)).toBe(true);
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

			await new Promise((resolve) => setImmediate(resolve));

			expect(unhandled).toEqual([]);
		},
		20_000,
	);

	it("rejects with the abort when the render aborts while a write waits for the encoder to drain", async () => {
		// A stand-in encoder that never reads stdin, so the first one-second block parks on drain.
		standIn("setInterval(() => {}, 1000)");
		process.on("unhandledRejection", onUnhandled);

		const { error, signal } = await renderToEncoder("ffmpeg", 300);
		const child = spawnedChild();

		expect(isAbortReason(error, signal)).toBe(true);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(unhandled).toEqual([]);
	}, 20_000);

	it("rejects with the encoder's exit error when it exits before its input ends", async () => {
		// A stand-in encoder that exits 3 after its first chunk, while the write still waits to drain.
		standIn("process.stdin.once('data', () => process.exit(3))");

		const { error } = await renderToEncoder("ffmpeg");

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("ffmpeg exited 3");
	}, 20_000);

	it("resolves when the encoder writes 4 KiB of stderr per input chunk", async () => {
		// writeSync blocks on a full stderr pipe on every platform; process.stderr.write queues in memory on Linux.
		standIn(
			`process.stdin.on("data", () => require("fs").writeSync(2, "x".repeat(4096))); process.stdin.on("end", () => { ${WRITE_OUTPUT}; process.exit(0); })`,
		);

		const { error } = await renderToEncoder("ffmpeg", undefined, 40);

		expect(error).toBeUndefined();
	}, 20_000);

	it("rejects a clean encoder exit that wrote no output file", async () => {
		standIn(`process.stdin.resume(); process.stdin.on("end", () => process.exit(0))`);

		const { error } = await renderToEncoder("ffmpeg", undefined, 2);

		expect((error as Error).message).toMatch(
			/^ffmpeg exited 0 but wrote no output at ".*\.partial-\d+-[0-9a-f]{8}\.mp3"$/,
		);
	}, 20_000);

	it("rejects with the abort within 3 s when the encoder never exits after its input ends", async () => {
		standIn("process.stdin.resume(); setInterval(() => {}, 1000)");

		const started = performance.now();
		const { error, signal } = await renderToEncoder("ffmpeg", 1500, 2);
		const child = spawnedChild();

		expect(isAbortReason(error, signal)).toBe(true);
		expect(performance.now() - started).toBeLessThan(4500);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	}, 20_000);

	it("rejects with the exit code and stderr of a failed encoder", async () => {
		standIn(`process.stderr.write("bad codec", () => process.exit(3))`);

		const { error } = await renderToEncoder("ffmpeg", undefined, 2);

		expect((error as Error).message).toBe("ffmpeg exited 3: bad codec");
	}, 20_000);
});

describe("WriteStream output file", () => {
	it.skipIf(!hasBinaryFixtures("ffmpeg"))(
		"leaves neither the target nor a partial file when an encode aborts",
		async () => {
			const directory = await temporaryDirectory("write-abort-");
			const { error, signal } = await renderTo(
				write(join(directory, "out.flac"), {
					bitDepth: "32f",
					ffmpegPath: binaries.ffmpeg,
					encoding: { format: "flac" },
				}),
				{ abortAfterMs: 500 },
			);
			const child = spawnedChild();

			expect(isAbortReason(error, signal)).toBe(true);
			expect(await readdir(directory)).toEqual([]);
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		},
		20_000,
	);

	it("replaces an existing target on success and leaves no partial file", async () => {
		const directory = await temporaryDirectory("write-replace-");
		const path = join(directory, "out.wav");

		await writeFile(path, "old");

		const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });
		const written = await readFile(path);

		expect(error).toBeUndefined();
		expect(written.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(written.length).toBeGreaterThan(2 * SAMPLE_RATE * 2);
		expect(await partialFiles(directory)).toEqual([]);
	});

	it("gives two Write streams to the same path their own temporary files", async () => {
		const directory = await temporaryDirectory("write-twice-");
		const render = async (...bitDepths: Array<WavBitDepth>): Promise<void> => {
			const source = new EndlessSource({ readDelayMs: 20, maxBlocks: 2 });

			for (const bitDepth of bitDepths)
				source.to(write(join(directory, `${bitDepths.join("-")}.wav`), { bitDepth }));

			await source.createRenderJob().render();
		};

		// Different bit depths write different bytes at different offsets, so a shared temporary file mixes them.
		await render("16");
		await render("24");
		await render("16", "24");

		const references = await Promise.all(["16.wav", "24.wav"].map((name) => readFile(join(directory, name))));
		const written = await readFile(join(directory, "16-24.wav"));

		expect(references.some((reference) => reference.equals(written))).toBe(true);
		expect(await partialFiles(directory)).toEqual([]);
	});

	it("rejects an empty path in setup, writing nothing to the working directory", async () => {
		const source = new EndlessSource({ readDelayMs: 20, maxBlocks: 2 });

		source.to(write("", { bitDepth: "16" }));

		await expect(source.createRenderJob().render()).rejects.toThrow("Write needs a file path; path is empty");
		expect((await readdir(process.cwd())).filter((name) => name.startsWith(".partial-"))).toEqual([]);
	});

	it("leaves neither the target nor a partial file when a WAV render aborts", async () => {
		const directory = await temporaryDirectory("write-abort-wav-");
		const { error, signal } = await renderTo(write(join(directory, "out.wav"), { bitDepth: "16" }), {
			abortAfterMs: 300,
		});

		expect(isAbortReason(error, signal)).toBe(true);
		expect(await readdir(directory)).toEqual([]);
	});
});
