import type { Block } from "../node/stream/block";

export function assertFirstBlockSampleRate(readable: ReadableStream<Block>, expected: number, nodeName: string): ReadableStream<Block> {
	const reader = readable.getReader();
	let checked = false;

	return new ReadableStream<Block>({
		pull: async (controller) => {
			const result = await reader.read();

			if (result.done) {
				controller.close();

				return;
			}

			if (!checked) {
				checked = true;

				if (result.value.sampleRate !== expected) {
					controller.error(
						new Error(
							`${nodeName}: emitted ${result.value.sampleRate} Hz where ${expected} Hz was declared — a rate-changing stream must assign context.sampleRate in _setup`,
						),
					);
					await reader.cancel();

					return;
				}
			}

			controller.enqueue(result.value);
		},
		cancel: async (reason) => {
			await reader.cancel(reason);
		},
	});
}
