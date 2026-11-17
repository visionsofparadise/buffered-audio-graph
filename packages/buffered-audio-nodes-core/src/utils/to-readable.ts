export interface ToReadableOptions {
	/**
	 * Runs on cancel before `iterator.return()`, which queues behind a pending `next()`; use it to wake whatever that call awaits.
	 */
	readonly onCancel?: () => void;
}

export function toReadable<T>(iterator: AsyncIterator<T>, options?: ToReadableOptions): ReadableStream<T> {
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
			options?.onCancel?.();

			await iterator.return?.();
		},
	});
}
