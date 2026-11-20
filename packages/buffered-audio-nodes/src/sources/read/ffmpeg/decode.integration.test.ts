import { describe, expect, it } from "vitest";
import { BufferedTargetStream, TargetNode, type Block } from "@buffered-audio/core";
import { audio, binaries, hasAudioFixtures, hasBinaryFixtures } from "../../../utils/test-binaries";
import { readFfmpeg } from ".";

const TEST_VOICE_FRAMES = 1346816;

class CountTargetStream extends BufferedTargetStream {
	frames = 0;

	override _write(chunk: Block): void {
		this.frames += chunk.samples[0]?.length ?? 0;
	}

	override _close(): void {
		return undefined;
	}
}

class CountTarget extends TargetNode {
	static override readonly Stream = CountTargetStream;
}

describe("ReadFfmpegStream against the staged ffmpeg", () => {
	it.skipIf(!hasBinaryFixtures("ffmpeg", "ffprobe") || !hasAudioFixtures("testVoice"))(
		"decodes every frame of a file",
		async () => {
			const source = readFfmpeg(audio.testVoice, { ffmpegPath: binaries.ffmpeg, ffprobePath: binaries.ffprobe });
			const target = new CountTarget();

			source.to(target);

			const job = source.createRenderJob();

			await job.render();

			const stream = job.streams.get(target)?.[0];

			if (!(stream instanceof CountTargetStream)) throw new Error("expected a CountTargetStream");

			expect(stream.frames).toBe(TEST_VOICE_FRAMES);
		},
	);

	it.skipIf(process.platform === "win32" || !hasBinaryFixtures("ffmpeg", "ffprobe") || !hasAudioFixtures("testMusic"))(
		"rejects with the abort reason within 1000 ms while ffmpeg is blocked on its full stdout",
		async () => {
			const controller = new AbortController();
			let blocks = 0;
			let abortedAt = 0;

			class SlowTargetStream extends BufferedTargetStream {
				override async _write(): Promise<void> {
					await new Promise((resolve) => setTimeout(resolve, 100));

					if (++blocks === 2) {
						abortedAt = performance.now();
						controller.abort();
					}
				}

				override _close(): void {
					return undefined;
				}
			}

			class SlowTarget extends TargetNode {
				static override readonly Stream = SlowTargetStream;
			}

			const source = readFfmpeg(audio.testMusic, { ffmpegPath: binaries.ffmpeg, ffprobePath: binaries.ffprobe });

			source.to(new SlowTarget());

			const error = await source
				.createRenderJob({ highWaterMark: 1, signal: controller.signal })
				.render()
				.then(
					() => new Error("render resolved"),
					(reason: unknown) => reason,
				);

			expect(error).toBe(controller.signal.reason);
			expect(performance.now() - abortedAt).toBeLessThan(1000);
		},
	);
});
