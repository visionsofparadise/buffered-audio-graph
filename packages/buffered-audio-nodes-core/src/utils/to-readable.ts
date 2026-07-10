export function toReadable<T>(iterator: AsyncIterator<T>): ReadableStream<T> {
	return new ReadableStream<T>({
		pull: async (controller) => {
			const result = await iterator.next();

			if (result.done) {
				controller.close();

				return;
			}

			controller.enqueue(result.value);
		},
		cancel: async () => {
			await iterator.return?.();
		},
	});
}
