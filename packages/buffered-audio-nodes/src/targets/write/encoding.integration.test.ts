import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const SAMPLE_RATE = 44100;

interface EndlessSourceProperties extends SourceNodeProperties {
	readonly readDelayMs: number;
}

class EndlessSourceStream extends BufferedSourceStream<EndlessSource> {
	private offset = 0;

	override async getMetadata(): Promise<SourceMetadata> {
		return { sampleRate: SAMPLE_RATE, channels: 1 };
	}

	override async _read(): Promise<Block> {
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

function spawnedChild(): ChildProcess {
	const result = vi.mocked(spawn).mock.results.at(-1);

	if (result?.type !== "return") throw new Error("ffmpeg was not spawned");

	return result.value as ChildProcess;
}

async function renderToEncoder(
	ffmpegPath: string,
	abortAfterMs?: number,
): Promise<{ error: unknown; signal: AbortSignal }> {
	const output = join(tmpdir(), `ban-write-encode-${randomBytes(8).toString("hex")}.mp3`);
	const source = new EndlessSource({ readDelayMs: 20 });
	const controller = new AbortController();

	source.to(write(output, { bitDepth: "32f", ffmpegPath, encoding: { format: "mp3" } }));

	const abortTimer = abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(), abortAfterMs);

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
		await rm(output, { force: true });
	}
}

const unhandled: Array<unknown> = [];
const onUnhandled = (reason: unknown): void => {
	unhandled.push(reason);
};

afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
	unhandled.length = 0;
	vi.mocked(spawn).mockClear();
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
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

		// A stand-in encoder that never reads stdin, so the first one-second block parks on drain.
		vi.mocked(spawn).mockImplementationOnce((_command, _args, options) =>
			actual.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options),
		);
		process.on("unhandledRejection", onUnhandled);

		const { error, signal } = await renderToEncoder("ffmpeg", 300);
		const child = spawnedChild();

		expect(isAbortReason(error, signal)).toBe(true);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		expect(unhandled).toEqual([]);
	}, 20_000);

	it("rejects with the encoder's exit error when it exits before its input ends", async () => {
		const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

		// A stand-in encoder that exits 3 after its first chunk, while the write still waits to drain.
		vi.mocked(spawn).mockImplementationOnce((_command, _args, options) =>
			actual.spawn(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(3))"], options),
		);

		const { error } = await renderToEncoder("ffmpeg");

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("ffmpeg exited with code 3");
	}, 20_000);
});
