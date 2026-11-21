import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
import { write } from ".";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();

	return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs/promises", { spy: true });

const SAMPLE_RATE = 44100;
const IS_WINDOWS = process.platform === "win32";
const IS_ROOT = process.getuid?.() === 0;
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

let delayedBlocks = 0;

// Delivers one block after 2 s, or nothing once its stream aborts, and counts the blocks it delivered.
class DelayedSourceStream extends BufferedSourceStream<DelayedSource> {
	private done = false;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: SAMPLE_RATE, channels: 1 };
	}

	override async _read(): Promise<Block | undefined> {
		if (this.done) return undefined;

		this.done = true;

		const signal = this.streamSignal;

		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 2000);

			signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			});
		});

		if (signal.aborted) return undefined;

		delayedBlocks += 1;

		return { samples: [new Float32Array(SAMPLE_RATE)], offset: 0, sampleRate: SAMPLE_RATE, bitDepth: 32 };
	}
}

class DelayedSource extends SourceNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "delayed-source";
	static override readonly schema = z.object({});
	static override readonly Stream = DelayedSourceStream;
}

let actualSpawn: typeof spawn;
let actualOpen: typeof open;

beforeAll(async () => {
	actualSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
	actualOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
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

// Renders the delayed source into `path`, returning the error, the time to settle and the blocks the source delivered.
async function renderDelayed(
	path: string,
	options: Parameters<typeof write>[1] = { bitDepth: "16" },
	abortAfterMs?: number,
): Promise<{ error: unknown; signal: AbortSignal; elapsedMs: number; blocks: number }> {
	const source = new DelayedSource();
	const controller = new AbortController();

	delayedBlocks = 0;
	source.to(write(path, options));

	const abortTimer = abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(), abortAfterMs);
	const startedAt = performance.now();

	try {
		const error = await source
			.createRenderJob({ signal: controller.signal })
			.render()
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		return { error, signal: controller.signal, elapsedMs: performance.now() - startedAt, blocks: delayedBlocks };
	} finally {
		clearTimeout(abortTimer);
	}
}

describe("WriteStream output file", () => {
	it.skipIf(!hasBinaryFixtures("ffmpeg"))(
		"leaves no target file when an encode aborts",
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

	it("leaves no target file when a WAV render aborts", async () => {
		const directory = await temporaryDirectory("write-abort-wav-");
		const { error, signal } = await renderTo(write(join(directory, "out.wav"), { bitDepth: "16" }), {
			abortAfterMs: 300,
		});

		expect(isAbortReason(error, signal)).toBe(true);
		expect(await readdir(directory)).toEqual([]);
	});

	it("removes the target when an encode fails", async () => {
		const directory = await temporaryDirectory("write-fail-");

		// A stand-in encoder that writes part of its output, then exits 3 after its first chunk.
		standIn(
			`process.stdin.once("data", () => { require("fs").writeFileSync(process.argv.at(-1), "partial"); process.exit(3); })`,
		);

		const { error } = await renderTo(
			write(join(directory, "out.flac"), { bitDepth: "32f", ffmpegPath: "ffmpeg", encoding: { format: "flac" } }),
			{ maxBlocks: 2 },
		);

		expect((error as Error).message).toBe("ffmpeg exited 3");
		expect(await readdir(directory)).toEqual([]);
	}, 20_000);

	it("leaves an existing encoded target unchanged when the encoder fails before it opens the target", async () => {
		const directory = await temporaryDirectory("write-fail-unopened-");
		const path = join(directory, "out.flac");

		await writeFile(path, "old");

		// A stand-in encoder that exits 3 after its first chunk without opening its output path.
		standIn(`process.stdin.once("data", () => process.exit(3))`);

		const { error } = await renderTo(
			write(path, { bitDepth: "32f", ffmpegPath: "ffmpeg", encoding: { format: "flac" } }),
			{ maxBlocks: 2 },
		);

		expect((error as Error).message).toBe("ffmpeg exited 3");
		expect(await readFile(path, "utf8")).toBe("old");
	}, 20_000);

	it("leaves an existing encoded target unchanged when the render aborts before its first block", async () => {
		const directory = await temporaryDirectory("write-abort-early-");
		const path = join(directory, "out.flac");

		await writeFile(path, "old");

		const { error, signal, blocks } = await renderDelayed(
			path,
			{ bitDepth: "32f", ffmpegPath: "ffmpeg", encoding: { format: "flac" } },
			300,
		);

		expect(isAbortReason(error, signal)).toBe(true);
		expect(blocks).toBe(0);
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe("old");
	});

	it("replaces an existing target on success", async () => {
		const directory = await temporaryDirectory("write-replace-");
		const path = join(directory, "out.wav");

		await writeFile(path, "old");

		const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });
		const written = await readFile(path);

		expect(error).toBeUndefined();
		expect(written.subarray(0, 4).toString("ascii")).toBe("RIFF");
		expect(written.length).toBe(80 + 2 * SAMPLE_RATE * 2);
		expect(await readdir(directory)).toEqual(["out.wav"]);
	});

	it("writes the whole WAV when its file handle writes each buffer in pieces", async () => {
		const directory = await temporaryDirectory("write-short-");
		const whole = join(directory, "whole.wav");
		const pieces = join(directory, "pieces.wav");

		expect((await renderTo(write(whole, { bitDepth: "16" }), { maxBlocks: 2 })).error).toBeUndefined();

		// A file handle that writes at most half of each request, as a write to a full disk or an interrupted write can.
		vi.mocked(open).mockImplementationOnce((async (...args: Parameters<typeof open>) => {
			const handle = await actualOpen(...args);
			const writeAll = handle.write.bind(handle) as (
				buffer: Buffer,
				offset: number,
				length: number,
				position: number,
			) => Promise<{ bytesWritten: number; buffer: Buffer }>;

			Object.assign(handle, {
				write: (buffer: Buffer, offset: number, length: number, position: number) =>
					writeAll(buffer, offset, Math.max(1, Math.floor(length / 2)), position),
			});

			return handle;
		}) as typeof open);

		expect((await renderTo(write(pieces, { bitDepth: "16" }), { maxBlocks: 2 })).error).toBeUndefined();

		const [written, expected] = await Promise.all([readFile(pieces), readFile(whole)]);

		expect(written.length).toBe(expected.length);
		expect(written.equals(expected)).toBe(true);
	});

	it("rejects an empty path in setup", async () => {
		const source = new EndlessSource({ readDelayMs: 20, maxBlocks: 2 });

		source.to(write("", { bitDepth: "16" }));

		await expect(source.createRenderJob().render()).rejects.toThrow("Write needs a file path; path is empty");
	});

	it("resolves a render with no input to an encoded target, creating no file and leaving an existing one", async () => {
		const directory = await temporaryDirectory("write-empty-");
		const path = join(directory, "out.flac");
		const node = (): ReturnType<typeof write> =>
			write(path, { bitDepth: "32f", ffmpegPath: "ffmpeg", encoding: { format: "flac" } });

		expect((await renderTo(node(), { maxBlocks: 0 })).error).toBeUndefined();
		expect(await readdir(directory)).toEqual([]);

		await writeFile(path, "old");

		expect((await renderTo(node(), { maxBlocks: 0 })).error).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe("old");
		expect(await readdir(directory)).toEqual(["out.flac"]);
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});
});

describe("WriteStream target path", () => {
	it("rejects a directory WAV target in setup with open's EISDIR, before the source delivers a block", async () => {
		const parent = await temporaryDirectory("write-directory-");
		const path = join(parent, "out.wav");

		await mkdir(path);

		const { error, elapsedMs, blocks } = await renderDelayed(path);

		expect(error).toMatchObject({ code: "EISDIR" });
		expect(blocks).toBe(0);
		expect(elapsedMs).toBeLessThan(1000);
		expect((await stat(path)).isDirectory()).toBe(true);
	});

	it("rejects a directory encoded target in setup, before the source delivers a block", async () => {
		const parent = await temporaryDirectory("write-directory-encoded-");
		const path = join(parent, "out.flac");

		await mkdir(path);

		const { error, elapsedMs, blocks } = await renderDelayed(path, {
			bitDepth: "32f",
			ffmpegPath: "ffmpeg",
			encoding: { format: "flac" },
		});

		expect((error as Error).message).toBe(`Write needs a file path; "${path}" is a directory`);
		expect(blocks).toBe(0);
		expect(elapsedMs).toBeLessThan(1000);
		expect((await stat(path)).isDirectory()).toBe(true);
	});

	it("rejects a path that ends with a path separator in setup, before the source delivers a block", async () => {
		const parent = await temporaryDirectory("write-separator-");

		for (const separator of new Set([sep, "/"])) {
			const path = `${join(parent, "out.wav")}${separator}`;
			const { error, elapsedMs, blocks } = await renderDelayed(path);

			expect((error as Error).message).toBe(`Write needs a file path; "${path}" ends with a path separator`);
			expect(blocks).toBe(0);
			expect(elapsedMs).toBeLessThan(1000);
			expect(await readdir(parent)).toEqual([]);
		}
	});

	it("rejects a WAV target in a missing folder in setup with ENOENT naming the target", async () => {
		const parent = await temporaryDirectory("write-missing-folder-");
		const path = join(parent, "missing", "out.wav");
		const { error, elapsedMs, blocks } = await renderDelayed(path);

		expect(error).toMatchObject({ code: "ENOENT" });
		expect((error as Error).message).toContain(path);
		expect(blocks).toBe(0);
		expect(elapsedMs).toBeLessThan(1000);
		expect(await readdir(parent)).toEqual([]);
	});

	// Skipped as root, so a regression in the cleanup can never reach a file outside the test's own directory.
	it.skipIf(IS_WINDOWS || IS_ROOT)(
		"truncates the file a symlink names when a WAV render aborts, and keeps the symlink",
		async () => {
			const directory = await temporaryDirectory("write-symlink-file-");
			const real = join(directory, "real");
			const links = join(directory, "links");
			const target = join(real, "out.wav");
			const path = join(links, "out.wav");

			await mkdir(real);
			await mkdir(links);
			await writeFile(target, "old");
			await symlink(target, path);

			const { error, signal } = await renderTo(write(path, { bitDepth: "16" }), { abortAfterMs: 300 });

			expect(isAbortReason(error, signal)).toBe(true);
			expect((await lstat(path)).isSymbolicLink()).toBe(true);
			expect((await stat(target)).size).toBe(0);
			expect(await readdir(links)).toEqual(["out.wav"]);
			expect(await readdir(real)).toEqual(["out.wav"]);
		},
	);

	// Skipped as root, like the test above.
	it.skipIf(IS_WINDOWS || IS_ROOT)(
		"leaves a FIFO target in place when an encode into it aborts",
		async () => {
			const directory = await temporaryDirectory("write-fifo-");
			const path = join(directory, "out.mp3");
			const made = spawnSync("mkfifo", [path]);

			if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);

			// The FIFO's reader, started before the render so the encoder's open of the FIFO does not block.
			const reader = actualSpawn("cat", [path], { stdio: ["ignore", "ignore", "ignore"] });

			try {
				// A stand-in encoder that copies its input to its output path, as ffmpeg's `-y <path>` writes it.
				standIn(`process.stdin.pipe(require("fs").createWriteStream(process.argv.at(-1)));`);

				const { error, signal } = await renderTo(
					write(path, { bitDepth: "32f", ffmpegPath: "ffmpeg", encoding: { format: "mp3" } }),
					{ abortAfterMs: 500 },
				);

				expect(isAbortReason(error, signal)).toBe(true);
				expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
				expect((await lstat(path)).isFIFO()).toBe(true);
				expect(await readdir(directory)).toEqual(["out.mp3"]);
			} finally {
				reader.kill("SIGKILL");
			}
		},
		20_000,
	);
});
