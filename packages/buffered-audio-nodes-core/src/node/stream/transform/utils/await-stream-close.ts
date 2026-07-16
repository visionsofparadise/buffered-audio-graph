import type { ReadStream } from "node:fs";
import type { Readable } from "node:stream";

export async function awaitStreamClose(stream: ReadStream | Readable): Promise<void> {
	if (stream.closed) return;

	// Windows keeps the file busy until the close event, even after destroy returns.
	await new Promise<void>((resolve) => {
		stream.once("close", () => resolve());
	});
}
