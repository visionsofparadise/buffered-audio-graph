import { randomBytes } from "node:crypto";
import { open, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWavFormat } from "./wav-format";

const paths: Array<string> = [];

afterEach(async () => {
	await Promise.all(paths.splice(0).map((path) => unlink(path).catch(() => undefined)));
});

describe("parseWavFormat", () => {
	it("stops reading once a leading chunk declares a size past the end of the file", async () => {
		const header = Buffer.alloc(20);

		header.write("RIFF", 0, "latin1");
		header.writeUInt32LE(0xffffffff, 4);
		header.write("WAVE", 8, "latin1");
		header.write("JUNK", 12, "latin1");
		header.writeUInt32LE(0x7fffff00, 16);

		const path = join(tmpdir(), `ban-wav-format-${randomBytes(8).toString("hex")}.wav`);

		paths.push(path);
		await writeFile(path, Buffer.concat([header, Buffer.alloc(256 * 1024)]));

		const fh = await open(path, "r");
		const read = fh.read.bind(fh);
		let bytesRequested = 0;

		fh.read = ((buffer: Buffer, offset: number, length: number, position: number) => {
			bytesRequested += length;

			return read(buffer, offset, length, position);
		}) as typeof fh.read;

		try {
			await expect(parseWavFormat(fh, path)).rejects.toThrow(`Invalid WAV file: "${path}"`);
		} finally {
			await fh.close();
		}

		expect(bytesRequested).toBeLessThanOrEqual(4096);
	});

	it("names the file in an unsupported format error", async () => {
		const bytes = Buffer.alloc(44);

		bytes.write("RIFF", 0, "latin1");
		bytes.writeUInt32LE(36, 4);
		bytes.write("WAVE", 8, "latin1");
		bytes.write("fmt ", 12, "latin1");
		bytes.writeUInt32LE(16, 16);
		bytes.writeUInt16LE(6, 20);
		bytes.writeUInt16LE(1, 22);
		bytes.writeUInt32LE(8000, 24);
		bytes.writeUInt32LE(8000, 28);
		bytes.writeUInt16LE(1, 32);
		bytes.writeUInt16LE(8, 34);
		bytes.write("data", 36, "latin1");

		const path = join(tmpdir(), `ban-wav-format-${randomBytes(8).toString("hex")}.wav`);

		paths.push(path);
		await writeFile(path, bytes);

		const fh = await open(path, "r");

		try {
			await expect(parseWavFormat(fh, path)).rejects.toThrow(
				`Unsupported WAV format (format code 6 at 8 bits; supported: PCM 8, 16, 24 or 32 bits, IEEE float 32 or 64 bits): "${path}"`,
			);
		} finally {
			await fh.close();
		}
	});
});
