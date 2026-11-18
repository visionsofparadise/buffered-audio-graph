import { describe, it, expect } from "vitest";
import { parseWavHeader, readSample } from "./wav-format";

function chunk(id: string, body: Buffer): Buffer {
	const head = Buffer.alloc(8);

	head.write(id, 0, "latin1");
	head.writeUInt32LE(body.length, 4);

	return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
}

function fmtBody(audioFormat: number, channels: number, sampleRate: number, bits: number): Buffer {
	const body = Buffer.alloc(16);
	const blockAlign = (channels * bits) / 8;

	body.writeUInt16LE(audioFormat, 0);
	body.writeUInt16LE(channels, 2);
	body.writeUInt32LE(sampleRate, 4);
	body.writeUInt32LE(sampleRate * blockAlign, 8);
	body.writeUInt16LE(blockAlign, 12);
	body.writeUInt16LE(bits, 14);

	return body;
}

function riff(magic: string, chunks: Array<Buffer>): Buffer {
	const head = Buffer.alloc(12);

	head.write(magic, 0, "latin1");
	head.writeUInt32LE(0xffffffff, 4);
	head.write("WAVE", 8, "latin1");

	return Buffer.concat([head, ...chunks]);
}

function dataHeader(size: number): Buffer {
	const head = Buffer.alloc(8);

	head.write("data", 0, "latin1");
	head.writeUInt32LE(size, 4);

	return head;
}

describe("parseWavHeader", () => {
	it("returns undefined until the data chunk header has arrived, skipping odd-sized chunks with their pad byte", () => {
		const bytes = riff("RIFF", [
			chunk("LIST", Buffer.from("abc")),
			chunk("fmt ", fmtBody(1, 2, 48000, 16)),
			dataHeader(8),
		]);

		for (let length = 0; length < bytes.length; length++) {
			expect(parseWavHeader(bytes.subarray(0, length))).toBeUndefined();
		}

		expect(parseWavHeader(bytes)).toEqual({
			sampleRate: 48000,
			channels: 2,
			bitsPerSample: 16,
			audioFormat: 1,
			blockAlign: 4,
			dataOffset: bytes.length,
			dataSize: 8,
		});
	});

	it("resolves WAVE_FORMAT_EXTENSIBLE to its SubFormat format code", () => {
		const fmt = Buffer.concat([fmtBody(0xfffe, 1, 44100, 32), Buffer.alloc(24)]);

		fmt.writeUInt16LE(22, 16);
		fmt.writeUInt16LE(32, 18);
		fmt.writeUInt32LE(0x4, 20);
		// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT begins with format code 3.
		fmt.writeUInt16LE(3, 24);

		expect(parseWavHeader(riff("RIFF", [chunk("fmt ", fmt), dataHeader(0)]))?.audioFormat).toBe(3);
	});

	it("takes an RF64 data size from its ds64 chunk", () => {
		const ds64 = Buffer.alloc(28);

		ds64.writeBigUInt64LE(5_000_000_000n, 8);

		const header = parseWavHeader(
			riff("RF64", [chunk("ds64", ds64), chunk("fmt ", fmtBody(3, 2, 48000, 32)), dataHeader(0xffffffff)]),
		);

		expect(header?.dataSize).toBe(5_000_000_000);
	});

	it("rejects a stream that is not RIFF or RF64, naming its first bytes", () => {
		expect(() => parseWavHeader(Buffer.from("Error: no such filter"))).toThrow(
			'Not a WAV stream (first bytes "Erro")',
		);
	});

	it("rejects a RIFF stream that is not WAVE", () => {
		const bytes = riff("RIFF", []);

		bytes.write("AVI ", 8, "latin1");

		expect(() => parseWavHeader(bytes)).toThrow('Not a WAV stream (first bytes "RIFF")');
	});
});

describe("readSample", () => {
	// One case per bit depth / format: the type-coercion boundary where PCM ints/floats become normalized samples.
	it("decodes 16-bit signed PCM to [-1, 1)", () => {
		const buffer = Buffer.alloc(2);

		buffer.writeInt16LE(16384, 0); // 0x4000 = half of 0x8000

		expect(readSample(buffer, 0, 16, 1)).toBeCloseTo(0.5, 6);
	});

	it("decodes 16-bit full-scale negative to exactly -1", () => {
		const buffer = Buffer.alloc(2);

		buffer.writeInt16LE(-32768, 0);

		expect(readSample(buffer, 0, 16, 1)).toBe(-1);
	});

	it("decodes 24-bit signed PCM (little-endian 3-byte)", () => {
		const positive = Buffer.from([0x00, 0x00, 0x40]); // 0x400000 = half of 0x800000
		const negative = Buffer.from([0x00, 0x00, 0x80]); // 0x800000 → -1 after sign extension

		expect(readSample(positive, 0, 24, 1)).toBeCloseTo(0.5, 6);
		expect(readSample(negative, 0, 24, 1)).toBe(-1);
	});

	it("decodes 32-bit signed PCM", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeInt32LE(0x40000000, 0); // half of 0x80000000

		expect(readSample(buffer, 0, 32, 1)).toBeCloseTo(0.5, 6);
	});

	it("decodes 32-bit IEEE float (audioFormat 3)", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeFloatLE(0.25, 0);

		expect(readSample(buffer, 0, 32, 3)).toBe(0.25);
	});

	it("decodes 64-bit IEEE float (audioFormat 3)", () => {
		const buffer = Buffer.alloc(8);

		buffer.writeDoubleLE(0.75, 0);

		expect(readSample(buffer, 0, 64, 3)).toBe(0.75);
	});

	it("decodes 8-bit unsigned PCM (128 = silence)", () => {
		const buffer = Buffer.from([192]); // (192 - 128) / 128 = 0.5

		expect(readSample(buffer, 0, 8, 1)).toBeCloseTo(0.5, 6);
	});

	it("honours the byte offset", () => {
		const buffer = Buffer.alloc(4);

		buffer.writeInt16LE(0, 0);
		buffer.writeInt16LE(-32768, 2);

		expect(readSample(buffer, 2, 16, 1)).toBe(-1);
	});

	// Unsupported depth/format returns 0 rather than NaN.
	it("returns 0 for an unsupported bit depth", () => {
		const buffer = Buffer.alloc(4);

		expect(readSample(buffer, 0, 12, 1)).toBe(0);
	});
});
