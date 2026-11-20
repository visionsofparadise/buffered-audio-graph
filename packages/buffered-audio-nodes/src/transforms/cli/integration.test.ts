import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	BufferedSourceStream,
	BufferedTargetStream,
	SourceNode,
	TargetNode,
	type Block,
	type SourceMetadata,
	type StreamSetupContext,
} from "@buffered-audio/core";
import {
	blockFromSamples,
	channelSamples,
	createTestSetupContext,
	createTestStreamContext,
	drainBlocks,
	readableFrom,
} from "@buffered-audio/core/testing";
import { buildStreamingWavHeader } from "./utils/wav-stream";
import { cli, CliStream, type CliProperties } from ".";

const SAMPLE_RATE = 44100;
const IS_WINDOWS = process.platform === "win32";
const RENDER_STDERR_HOLDER = fileURLToPath(new URL("./__fixtures__/render-stderr-holder.mjs", import.meta.url));
const HOLDER_SCRIPT = "setInterval(function(){console.log('holder')},500);setTimeout(function(){process.exit()},6000)";
const BLOCK_FRAMES = 4096;
const LABEL = basename(process.execPath);

const ECHO = "process.stdin.pipe(process.stdout)";
// Reads all of stdin before failing, so the exit is not a write error on a closed pipe.
const FAIL_AFTER_INPUT = (code: number, message: string): string =>
	`process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write(${JSON.stringify(message)}); process.exit(${code}); })`;

function inputBlocks(
	count: number,
	options?: { readonly channels?: number; readonly bitDepth?: number },
): Array<Block> {
	const channels = options?.channels ?? 2;
	const blocks: Array<Block> = [];

	for (let index = 0; index < count; index++) {
		const samples: Array<Float32Array> = [];

		for (let channel = 0; channel < channels; channel++) {
			const data = new Float32Array(BLOCK_FRAMES);

			for (let frame = 0; frame < BLOCK_FRAMES; frame++) {
				data[frame] = Math.sin((index * BLOCK_FRAMES + frame) * 0.01 * (channel + 1)) * 0.9;
			}

			samples.push(data);
		}

		blocks.push(
			blockFromSamples(samples, index * BLOCK_FRAMES, { sampleRate: SAMPLE_RATE, bitDepth: options?.bitDepth }),
		);
	}

	return blocks;
}

function createStream(
	properties: Omit<CliProperties, "command">,
	setup?: Partial<StreamSetupContext>,
): { stream: CliStream; context: StreamSetupContext } {
	const stream = new CliStream(cli({ command: process.execPath, ...properties }), createTestStreamContext().context);
	const context = createTestSetupContext({ sourceSampleRate: SAMPLE_RATE, sampleRate: SAMPLE_RATE, ...setup });

	stream._setup(context);

	return { stream, context };
}

async function run(properties: Omit<CliProperties, "command">, input: Array<Block>): Promise<Array<Block>> {
	const { stream } = createStream(properties);

	return drainBlocks(stream._pipe(readableFrom(input)));
}

const directories: Array<string> = [];

afterAll(async () => {
	await Promise.all(
		directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)),
	);
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));

	directories.push(directory);

	return directory;
}

async function holderCommand(code: number): Promise<{ readonly command: string; readonly args: Array<string> }> {
	if (!IS_WINDOWS) {
		return { command: "sh", args: ["-c", code === 0 ? "sleep 6 & exit 0" : `sleep 6 & echo bad >&2; exit ${code}`] };
	}

	const file = join(await temporaryDirectory("cli-holder-cmd-"), "holder.cmd");
	const lines = [`@start /b "" "${process.execPath}" -e "${HOLDER_SCRIPT}"`, "@echo bad 1>&2", `@exit ${code}`];

	await writeFile(file, `${lines.join("\r\n")}\r\n`);

	return { command: "cmd.exe", args: ["/d", "/c", file] };
}

async function runCommand(command: string, args: Array<string>, input: Array<Block>): Promise<Array<Block>> {
	const stream = new CliStream(cli({ command, args }), createTestStreamContext().context);

	stream._setup(createTestSetupContext({ sourceSampleRate: SAMPLE_RATE, sampleRate: SAMPLE_RATE }));

	return drainBlocks(stream._pipe(readableFrom(input)));
}

function silentWav(sampleRate: number, frames: number): Buffer {
	const dataBytes = frames * 2;
	const header = Buffer.alloc(44);

	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + dataBytes, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(dataBytes, 40);

	return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

function expectSameSamples(output: Array<Block>, input: Array<Block>): void {
	const channels = input[0]?.samples.length ?? 0;

	expect(output[0]?.samples.length).toBe(channels);

	for (let channel = 0; channel < channels; channel++) {
		expect(channelSamples(output, channel)).toEqual(channelSamples(input, channel));
	}
}

describe("CliStream against a real child", () => {
	it.each(["f32le", "f64le"] as const)("round-trips %s through an echo child sample-exactly", async (format) => {
		const input = inputBlocks(40);
		const output = await run({ args: ["-e", ECHO], inputFormat: format, outputFormat: format }, input);

		expectSameSamples(output, input);

		let expectedOffset = 0;

		for (const block of output) {
			expect(block.offset).toBe(expectedOffset);
			expectedOffset += block.samples[0]?.length ?? 0;
		}
	});

	it("round-trips wav in and wav out through an echo child", async () => {
		const input = inputBlocks(8);
		const output = await run({ args: ["-e", ECHO], inputFormat: "wav", outputFormat: "wav" }, input);

		expectSameSamples(output, input);
	});

	it("substitutes {sampleRate} and {channels} in args at spawn", async () => {
		const expected = JSON.stringify([String(SAMPLE_RATE), "2", `aresample=${SAMPLE_RATE}:ac=2`]);
		const script = `if (JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(expected)}) process.exit(1); ${ECHO}`;
		const input = inputBlocks(2);
		const output = await run(
			{ args: ["-e", script, "{sampleRate}", "{channels}", "aresample={sampleRate}:ac={channels}"] },
			input,
		);

		expectSameSamples(output, input);
	});

	it("errors with the exit code and stderr when the child exits non-zero", async () => {
		await expect(run({ args: ["-e", FAIL_AFTER_INPUT(3, "bad input")] }, inputBlocks(2))).rejects.toThrow(
			`${LABEL} exited 3: bad input`,
		);
	});

	it("writes outputSampleRate to context.sampleRate and stamps it on the output", async () => {
		const { stream, context } = createStream({ args: ["-e", ECHO], outputSampleRate: 22050 });

		expect(context.sampleRate).toBe(22050);

		const output = await drainBlocks(stream._pipe(readableFrom(inputBlocks(2))));

		expect(output.length).toBeGreaterThan(0);
		expect(output.every((block) => block.sampleRate === 22050)).toBe(true);
	});

	it("errors when the WAV output's sample rate differs from the expected rate", async () => {
		await expect(
			run({ args: ["-e", ECHO], inputFormat: "wav", outputFormat: "wav", outputSampleRate: 22050 }, inputBlocks(2)),
		).rejects.toThrow(`${LABEL} output WAV has sample rate ${SAMPLE_RATE}, expected 22050`);
	});

	it("decodes outputChannels channels from a child that changes the channel count", async () => {
		const downmix = [
			"let stash = Buffer.alloc(0);",
			'process.stdin.on("data", (chunk) => {',
			"const data = Buffer.concat([stash, chunk]); const frames = Math.floor(data.length / 8); const out = Buffer.alloc(frames * 4);",
			"for (let i = 0; i < frames; i++) out.writeFloatLE((data.readFloatLE(i * 8) + data.readFloatLE(i * 8 + 4)) / 2, i * 4);",
			"stash = data.subarray(frames * 8); process.stdout.write(out); });",
			'process.stdin.on("end", () => process.stdout.end());',
		].join(" ");
		const input = inputBlocks(4);
		const output = await run({ args: ["-e", downmix], outputChannels: 1 }, input);
		const left = channelSamples(input, 0);
		const right = channelSamples(input, 1);
		const expected = left.map((sample, index) => Math.fround((sample + (right[index] ?? 0)) / 2));

		expect(output.every((block) => block.samples.length === 1)).toBe(true);
		expect(channelSamples(output, 0)).toEqual(expected);
	});

	it("errors when the WAV output's channel count differs from outputChannels", async () => {
		await expect(
			run({ args: ["-e", ECHO], inputFormat: "wav", outputFormat: "wav", outputChannels: 1 }, inputBlocks(2)),
		).rejects.toThrow(`${LABEL} output WAV has 2 channels, expected 1`);
	});

	it("terminates the child when the consumer cancels mid-stream", async () => {
		const pidFile = join(tmpdir(), `ban-cli-pid-${randomBytes(8).toString("hex")}`);
		const script = `require("node:fs").writeFileSync(process.argv[1], String(process.pid)); ${ECHO}`;
		let offset = 0;
		const endless = new ReadableStream<Block>({
			pull: (controller) => {
				const [block] = inputBlocks(1);

				if (block) controller.enqueue({ ...block, offset });
				offset += BLOCK_FRAMES;
			},
		});

		try {
			const { stream } = createStream({ args: ["-e", script, pidFile] });
			const reader = stream._pipe(endless).getReader();

			expect((await reader.read()).done).toBe(false);

			const pid = Number(await readFile(pidFile, "utf8"));
			const started = performance.now();

			await reader.cancel();

			expect(performance.now() - started).toBeLessThan(1000);
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			await unlink(pidFile).catch(() => undefined);
		}
	});

	it("round-trips 30 s of stereo f32le through an echo child sample-exactly, across the child's exit", async () => {
		const input = inputBlocks(Math.ceil((30 * SAMPLE_RATE) / BLOCK_FRAMES));
		const output = await run({ args: ["-e", ECHO] }, input);

		for (let channel = 0; channel < 2; channel++) {
			const expected = channelSamples(input, channel);
			const actual = channelSamples(output, channel);

			expect(actual.length).toBe(expected.length);
			expect(Buffer.from(actual.buffer).equals(Buffer.from(expected.buffer))).toBe(true);
		}
	});

	it("serves output a child writes only after its stdin ends", async () => {
		const script = `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(Buffer.alloc(1048576), () => process.exit(0)))`;
		const output = await run({ args: ["-e", script] }, inputBlocks(4));

		expect(output.reduce((frames, block) => frames + (block.samples[0]?.length ?? 0), 0)).toBe(1048576 / 4 / 2);
	});

	it("carries the input's bit depth onto the output blocks", async () => {
		const output = await run({ args: ["-e", ECHO] }, inputBlocks(2, { bitDepth: 24 }));

		expect(output.length).toBeGreaterThan(0);
		expect(output.every((block) => block.bitDepth === 24)).toBe(true);
	});

	it("surfaces the exit error, not a parser error, when a wav child exits non-zero with no stdout", async () => {
		await expect(
			run({ args: ["-e", FAIL_AFTER_INPUT(2, "no audio")], outputFormat: "wav" }, inputBlocks(2)),
		).rejects.toThrow(`${LABEL} exited 2`);
	});
});

describe("CliStream spawn failures", () => {
	it("refuses an empty command before spawning", async () => {
		const stream = new CliStream(cli({ command: "" }), createTestStreamContext().context);

		stream._setup(createTestSetupContext());

		await expect(drainBlocks(stream._pipe(readableFrom(inputBlocks(1))))).rejects.toThrow("CLI node has no command");
	});

	it("labels a synchronous spawn throw as a failure to start", async () => {
		const stream = new CliStream(cli({ command: "tool\0name" }), createTestStreamContext().context);

		stream._setup(createTestSetupContext());

		await expect(drainBlocks(stream._pipe(readableFrom(inputBlocks(1))))).rejects.toThrow(
			/^tool\0name failed to start: .*null bytes/,
		);
	});

	it.skipIf(process.platform !== "win32")("labels the EINVAL Windows raises for a .cmd command", async () => {
		const stream = new CliStream(cli({ command: join(tmpdir(), "tool.cmd") }), createTestStreamContext().context);

		stream._setup(createTestSetupContext());

		await expect(drainBlocks(stream._pipe(readableFrom(inputBlocks(1))))).rejects.toThrow(
			"tool.cmd failed to start: spawn EINVAL",
		);
	});
});

describe("CliStream decode errors against the child's exit", () => {
	// Each write finishes before the next starts, so stdout, stderr and the exit reach the parent in that order.
	const USAGE = `process.stdout.write("usage: tool [options]\\n", () => process.stderr.write("bad option", () => process.exit(2)))`;

	it("throws the exit error with stderr when a child prints text to stdout after reading its input", async () => {
		const script = `process.stdin.resume(); process.stdin.on("end", () => ${USAGE})`;

		await expect(run({ args: ["-e", script], outputFormat: "wav" }, inputBlocks(2))).rejects.toThrow(
			`${LABEL} exited 2: bad option`,
		);
	});

	it("throws the exit error with stderr when a child prints text to stdout before reading any input", async () => {
		await expect(run({ args: ["-e", USAGE], outputFormat: "wav" }, inputBlocks(8))).rejects.toThrow(
			`${LABEL} exited 2: bad option`,
		);
	});

	it("throws the exit error with stderr over a WAV header whose rate disagrees", async () => {
		const header = buildStreamingWavHeader(8000, 2).toString("base64");
		const script = `process.stdout.write(Buffer.from(process.argv[1], "base64"), () => process.stderr.write("real cause", () => process.exit(1)))`;

		await expect(run({ args: ["-e", script, header], outputFormat: "wav" }, inputBlocks(2))).rejects.toThrow(
			`${LABEL} exited 1: real cause`,
		);
	});

	it("throws the decode error when the child exits 0 after bad stdout", async () => {
		const script = `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("usage: tool [options]\\n", () => process.exit(0)))`;

		await expect(run({ args: ["-e", script], outputFormat: "wav" }, inputBlocks(2))).rejects.toThrow(
			'Not a WAV stream (first bytes "usag")',
		);
	});

	it("throws the decode error for bad stdout that a child wrote before exiting 0, unread until after the exit", async () => {
		const script = `process.stdout.write("usage: tool\\n", () => process.exit(0))`;

		await expect(run({ args: ["-e", script], outputFormat: "wav" }, inputBlocks(2))).rejects.toThrow(
			'Not a WAV stream (first bytes "usag")',
		);
	});

	it("throws the decode error once a child that keeps running has had its bounded wait", async () => {
		const script = `process.stdout.write("usage: tool [options]\\n"); setInterval(() => undefined, 1000)`;
		const started = performance.now();

		await expect(run({ args: ["-e", script], outputFormat: "wav" }, inputBlocks(2))).rejects.toThrow(
			'Not a WAV stream (first bytes "usag")',
		);
		expect(performance.now() - started).toBeLessThan(5000);
	});
});

describe("CliStream with a process that holds the child's stdio after it exits", () => {
	it("rejects a clean exit whose stdout stays open with the held-stdout error, within 4000 ms", async () => {
		const { command, args } = await holderCommand(0);
		const started = performance.now();

		await expect(runCommand(command, args, inputBlocks(2))).rejects.toThrow(
			/exited, but its stdout stayed open for 2000 ms/,
		);
		expect(performance.now() - started).toBeLessThan(4000);
	});

	it("rejects a clean exit with held stdout mid-stream at the deadline, not once the input ends", async () => {
		const { command, args } = await holderCommand(0);
		const blocks = inputBlocks(60);
		let index = 0;
		const input = new ReadableStream<Block>({
			pull: async (controller) => {
				await new Promise((resolve) => setTimeout(resolve, 100));

				const block = blocks[index++];

				if (block) controller.enqueue(block);
				else controller.close();
			},
		});
		const stream = new CliStream(cli({ command, args }), createTestStreamContext().context);

		stream._setup(createTestSetupContext({ sourceSampleRate: SAMPLE_RATE, sampleRate: SAMPLE_RATE }));

		const started = performance.now();

		await expect(drainBlocks(stream._pipe(input))).rejects.toThrow(/exited, but its stdout stayed open for 2000 ms/);
		expect(performance.now() - started).toBeLessThan(4000);
	});

	it("rejects a failed exit with its exit error rather than the held stdout, within 4000 ms", async () => {
		const { command, args } = await holderCommand(3);
		const started = performance.now();

		await expect(runCommand(command, args, inputBlocks(2))).rejects.toThrow(/exited 3: bad/);
		expect(performance.now() - started).toBeLessThan(4000);
	});

	it.skipIf(IS_WINDOWS)("lets the process exit once a render settles while a grandchild holds stderr", async () => {
		const directory = await temporaryDirectory("cli-holder-");
		const input = join(directory, "in.wav");

		await writeFile(input, silentWav(44100, 44100));

		const child = spawn(process.execPath, [RENDER_STDERR_HOLDER, input, join(directory, "out.wav")], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		let settledAt: number | undefined;

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (settledAt === undefined && chunk.toString().includes("settled")) settledAt = performance.now();
		});

		const [code] = (await once(child, "exit")) as [number | null];
		const exitedAt = performance.now();

		expect(code, `fixture stderr: ${stderr}`).toBe(0);
		expect(settledAt, `fixture stderr: ${stderr}`).toBeDefined();
		expect(exitedAt - (settledAt ?? exitedAt)).toBeLessThan(500);
	});
});

class SineSourceStream extends BufferedSourceStream {
	private offset = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: SAMPLE_RATE, channels: 1 };
	}

	override async _read(): Promise<Block> {
		await delay(50, undefined, { signal: this.streamSignal });

		const samples = Float32Array.from({ length: 4410 }, (_, index) =>
			Math.sin((2 * Math.PI * 440 * (this.offset + index)) / SAMPLE_RATE),
		);
		const block = blockFromSamples([samples], this.offset, { sampleRate: SAMPLE_RATE });

		this.offset += 4410;

		return block;
	}
}

class SineSource extends SourceNode {
	static override readonly Stream = SineSourceStream;
}

class DiscardTargetStream extends BufferedTargetStream {
	override _write(): void {
		return undefined;
	}

	override _close(): void {
		return undefined;
	}
}

class DiscardTarget extends TargetNode {
	static override readonly Stream = DiscardTargetStream;
}

async function processGone(pid: number, withinMs: number): Promise<unknown> {
	const deadline = performance.now() + withinMs;

	for (;;) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			return error;
		}

		if (performance.now() > deadline) return undefined;

		await delay(50);
	}
}

describe("CliStream abort teardown", () => {
	const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); process.stdin.on("data", () => {});`;

	for (const [name, reason] of [
		["the default abort reason", undefined],
		["a non-Error abort reason", "cancelled"],
	] as const) {
		it.skipIf(IS_WINDOWS)(
			`kills a child that ignores SIGTERM at once when the render aborts with ${name}`,
			async () => {
				const directory = await temporaryDirectory("cli-abort-");
				const pidFile = join(directory, "child.pid");
				const source = new SineSource();
				const node = cli({ command: process.execPath, args: ["-e", IGNORES_SIGTERM, pidFile] });
				const controller = new AbortController();

				source.to(node);
				node.to(new DiscardTarget());

				const rendering = source
					.createRenderJob({ highWaterMark: 1, signal: controller.signal })
					.render()
					.then(
						() => new Error("render resolved"),
						(error: unknown) => error,
					);

				while (!existsSync(pidFile)) await delay(20);

				await delay(50);

				const pid = Number(await readFile(pidFile, "utf8"));

				await delay(200);

				const abortedAt = performance.now();

				controller.abort(reason);

				const error = await rendering;

				expect(error).toBe(controller.signal.reason);
				expect(performance.now() - abortedAt).toBeLessThan(1000);
				expect(await processGone(pid, 1000)).toHaveProperty("code", "ESRCH");
			},
		);
	}
});
