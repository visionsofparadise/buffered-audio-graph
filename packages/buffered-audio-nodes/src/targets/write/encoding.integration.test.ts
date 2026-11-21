import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
	vi.mocked(rename).mockClear();
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

describe("WriteStream target path", () => {
	// Renders the delayed source into `path`, returning the error, the time to settle and the blocks the source delivered.
	async function renderDelayed(path: string): Promise<{ error: unknown; elapsedMs: number; blocks: number }> {
		const source = new DelayedSource();

		delayedBlocks = 0;
		source.to(write(path, { bitDepth: "16" }));

		const startedAt = performance.now();
		const error = await source
			.createRenderJob()
			.render()
			.then(
				() => undefined,
				(reason: unknown) => reason,
			);

		return { error, elapsedMs: performance.now() - startedAt, blocks: delayedBlocks };
	}

	it("rejects a directory target in setup, before the source delivers a block", async () => {
		const parent = await temporaryDirectory("write-directory-");
		const path = join(parent, "out.wav");

		await mkdir(path);

		const { error, elapsedMs, blocks } = await renderDelayed(path);

		expect((error as Error).message).toBe(`Write needs a file path; "${path}" is a directory`);
		expect(blocks).toBe(0);
		expect(elapsedMs).toBeLessThan(1000);
		expect(await readdir(parent)).toEqual(["out.wav"]);
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

	it.skipIf(IS_WINDOWS)("keeps the mode of the existing file it replaces", async () => {
		const directory = await temporaryDirectory("write-mode-");
		const path = join(directory, "out.wav");

		await writeFile(path, "old");
		await chmod(path, 0o640);

		const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });

		expect(error).toBeUndefined();
		expect((await stat(path)).mode & 0o7777).toBe(0o640);
		expect((await readFile(path)).subarray(0, 4).toString("ascii")).toBe("RIFF");
	});

	it.skipIf(IS_WINDOWS)(
		"writes into a FIFO target and leaves it a FIFO",
		async () => {
			const directory = await temporaryDirectory("write-fifo-");
			const path = join(directory, "out.mp3");
			const made = spawnSync("mkfifo", [path]);

			if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);

			// The FIFO's reader, started before the render so the encoder's open of the FIFO does not block.
			const reader = actualSpawn("cat", [path], { stdio: ["ignore", "pipe", "ignore"] });
			const received: Array<Buffer> = [];

			reader.stdout.on("data", (chunk: Buffer) => received.push(chunk));

			const readerClosed = new Promise<boolean>((resolve) => reader.once("close", () => resolve(true)));

			try {
				// A stand-in encoder that copies its input to its output path, as ffmpeg's `-y <path>` writes it.
				standIn(
					`const out = require("fs").createWriteStream(process.argv.at(-1)); process.stdin.pipe(out); out.on("finish", () => process.exit(0));`,
				);

				const { error } = await renderTo(
					write(path, { bitDepth: "32f", ffmpegPath: "ffmpeg", encoding: { format: "mp3" } }),
					{
						maxBlocks: 2,
					},
				);

				expect(error).toBeUndefined();
				expect(await Promise.race([readerClosed, delay(5000, false)])).toBe(true);
				expect(Buffer.concat(received).length).toBe(2 * SAMPLE_RATE * 4);
				expect((await lstat(path)).isFIFO()).toBe(true);
				expect(await partialFiles(directory)).toEqual([]);
			} finally {
				reader.kill("SIGKILL");
			}
		},
		20_000,
	);

	// Skipped as root, where a regression would replace the system's /dev/null with a regular file.
	it.skipIf(IS_WINDOWS || IS_ROOT)("writes a WAV straight to /dev/null and leaves it a character device", async () => {
		const { error } = await renderTo(write("/dev/null", { bitDepth: "16" }), { maxBlocks: 2 });

		expect(error).toBeUndefined();
		expect((await stat("/dev/null")).isCharacterDevice()).toBe(true);
	});

	// Skipped as root, like the test above, since a regression could replace /dev/null through the symlink.
	it.skipIf(IS_WINDOWS || IS_ROOT)("follows a symlink to a character device and leaves both in place", async () => {
		const directory = await temporaryDirectory("write-symlink-");
		const path = join(directory, "out.wav");

		await symlink("/dev/null", path);

		const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });

		expect(error).toBeUndefined();
		expect((await lstat(path)).isSymbolicLink()).toBe(true);
		expect((await stat(path)).isCharacterDevice()).toBe(true);
		expect(await readdir(directory)).toEqual(["out.wav"]);
	});

	// Skipped as root for the same reason.
	it.skipIf(IS_WINDOWS || IS_ROOT)(
		"writes straight through a chain of symlinks to a device, as /dev/stdout is",
		async () => {
			const directory = await temporaryDirectory("write-symlink-chain-");
			const inner = join(directory, "fd");
			const path = join(directory, "stdout");

			await symlink("/dev/null", inner);
			await symlink(inner, path);

			const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });

			expect(error).toBeUndefined();
			expect((await lstat(path)).isSymbolicLink()).toBe(true);
			expect((await lstat(inner)).isSymbolicLink()).toBe(true);
			expect((await readdir(directory)).sort()).toEqual(["fd", "stdout"]);
		},
	);

	it.skipIf(IS_WINDOWS)(
		"writes through a symlink to a regular file in another directory and leaves it a symlink",
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

			const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });

			expect(error).toBeUndefined();
			expect((await lstat(path)).isSymbolicLink()).toBe(true);
			expect((await readFile(target)).subarray(0, 4).toString("ascii")).toBe("RIFF");
			expect(await readdir(links)).toEqual(["out.wav"]);
			expect(await readdir(real)).toEqual(["out.wav"]);
		},
	);

	// Skipped as root, whom file permissions do not stop.
	it.skipIf(IS_ROOT)("rejects a read-only existing target in setup and leaves it unchanged", async () => {
		const parent = await temporaryDirectory("write-read-only-");
		const path = join(parent, "out.wav");

		await writeFile(path, "old");
		await chmod(path, 0o444);

		try {
			const { error, elapsedMs, blocks } = await renderDelayed(path);

			expect(error).toMatchObject({ code: IS_WINDOWS ? "EPERM" : "EACCES" });
			expect(blocks).toBe(0);
			expect(elapsedMs).toBeLessThan(1000);
			expect(await readFile(path, "utf8")).toBe("old");
			expect(await readdir(parent)).toEqual(["out.wav"]);
		} finally {
			await chmod(path, 0o644);
		}
	});

	it.each(IS_WINDOWS ? ["EXDEV"] : ["EXDEV", "EBUSY"])(
		"copies onto the target and removes the temporary file when the rename fails with %s",
		async (code) => {
			const directory = await temporaryDirectory("write-copy-");
			const path = join(directory, "out.wav");

			await writeFile(path, "old");

			// A rename onto a mount point fails with EBUSY, and one across filesystems with EXDEV.
			vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error(`${code}: rename failed`), { code }));

			const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });
			const written = await readFile(path);

			expect(error).toBeUndefined();
			expect(written.subarray(0, 4).toString("ascii")).toBe("RIFF");
			expect(written.length).toBe(80 + 2 * SAMPLE_RATE * 2);
			expect(await readdir(directory)).toEqual(["out.wav"]);
		},
	);

	it.skipIf(!IS_WINDOWS)(
		"writes a reserved device name in place, creating no file in the working directory",
		async () => {
			const created = async (): Promise<Array<string>> =>
				(await readdir(process.cwd())).filter((name) => /^nul(?:\.|$)/i.test(name));

			try {
				for (const path of ["NUL", "nul.wav"]) {
					const { error } = await renderTo(write(path, { bitDepth: "16" }), { maxBlocks: 2 });

					expect(error).toBeUndefined();
					expect(await created()).toEqual([]);
				}
			} finally {
				// A regression creates real files named after the device here, which only a namespaced path removes.
				for (const name of await created()) await rm(join(process.cwd(), name), { force: true });
			}
		},
	);

	it.skipIf(!IS_WINDOWS)(
		"rejects with the abort at once and leaves the target unchanged when aborted while a held target's rename retries",
		async () => {
			const directory = await temporaryDirectory("write-held-");
			const path = join(directory, "out.wav");

			await writeFile(path, "old");

			// Another process holding the target open makes every rename onto it fail with EPERM on Windows.
			const holder = actualSpawn(
				process.execPath,
				[
					"-e",
					"require('fs').openSync(process.argv[1], 'r'); console.log('held'); setInterval(() => {}, 1000)",
					path,
				],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			const holderExited = new Promise((resolve) => holder.once("exit", resolve));

			try {
				await new Promise((resolve) => holder.stdout.once("data", resolve));

				const source = new EndlessSource({ readDelayMs: 20, maxBlocks: 2 });
				const controller = new AbortController();

				source.to(write(path, { bitDepth: "16" }));

				const rendering = source
					.createRenderJob({ signal: controller.signal })
					.render()
					.then(
						() => undefined,
						(reason: unknown) => reason,
					);
				const deadline = performance.now() + 5000;

				while (vi.mocked(rename).mock.calls.length === 0 && performance.now() < deadline) await delay(5);

				expect(vi.mocked(rename).mock.calls.length).toBeGreaterThan(0);

				// The first rename has failed and the retry is waiting for its next attempt.
				await delay(100);

				const abortedAt = performance.now();

				controller.abort();

				const error = await rendering;

				expect(error).toBe(controller.signal.reason);
				expect(performance.now() - abortedAt).toBeLessThan(300);
				expect(await readFile(path, "utf8")).toBe("old");
				expect(await partialFiles(directory)).toEqual([]);
			} finally {
				holder.kill();
				await holderExited;
			}
		},
		20_000,
	);

	it.skipIf(!IS_WINDOWS)(
		"fails at once, without the rename retry, when a directory takes the target's place",
		async () => {
			const directory = await temporaryDirectory("write-replaced-");
			const path = join(directory, "out.wav");
			const source = new EndlessSource({ readDelayMs: 300, maxBlocks: 2 });

			source.to(write(path, { bitDepth: "16" }));

			const startedAt = performance.now();
			const rendering = source
				.createRenderJob()
				.render()
				.then(
					() => undefined,
					(reason: unknown) => reason,
				);

			// Setup has passed by now, so only the rename meets the directory.
			await delay(150);
			await mkdir(path);

			const error = await rendering;

			expect((error as Error).message).toMatch(/^Cannot move ".*" onto ".*out\.wav": EPERM/);
			expect(vi.mocked(rename).mock.calls.length).toBe(1);
			expect(performance.now() - startedAt).toBeLessThan(1500);
			expect(await partialFiles(directory)).toEqual([]);
		},
	);
});
