import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Block, StreamSetupContext } from "@buffered-audio/core";
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

	it("throws the decode error once a child that keeps running has had its bounded wait", async () => {
		const script = `process.stdout.write("usage: tool [options]\\n"); setInterval(() => undefined, 1000)`;
		const started = performance.now();

		await expect(run({ args: ["-e", script], outputFormat: "wav" }, inputBlocks(2))).rejects.toThrow(
			'Not a WAV stream (first bytes "usag")',
		);
		expect(performance.now() - started).toBeLessThan(5000);
	});
});
