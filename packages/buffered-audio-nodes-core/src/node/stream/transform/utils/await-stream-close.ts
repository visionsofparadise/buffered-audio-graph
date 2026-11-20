import type { ReadStream, WriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";

export async function awaitStreamClose(stream: ReadStream | Readable | WriteStream | Writable): Promise<void> {
	if (stream.closed) return;

	await new Promise<void>((resolve) => {
		stream.once("close", () => resolve());
	});
}
